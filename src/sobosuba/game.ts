import { drawArena, findArenaDrop, ARENA_HEIGHT, ARENA_WIDTH } from './arena';
import type { ArenaAim, ArenaTheme } from './arena';
import {
  burstLiquidIntro, clearLiquidIntro, clearLiquidIntroPointer, trackLiquidIntro,
} from './liquid-intro';
import type { RoundRecord } from './profile';
import { rackEntry, rackLevel, readHeldRack, SLOT_COUNT, SNAPSHOT_BODY_STRIDE, SNAPSHOT_HEADER } from './rack';
import type { RackSlot } from './rack';
import { createSound } from './sound';
import { loadCore } from './wasm';

export type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'failed';
export type PadStatus = 'none' | 'standard' | 'unknown';

export interface Hud {
  phase: Phase;
  score: string;
  highestLevel: number;
  shots: number;
  merges: number;
  left: number;
  right: number;
  danger: number;
  rack: readonly RackSlot[];
  selected: number;
  power: number | null;
  pad: PadStatus;
  message: string;
}

export const initialHud: Hud = {
  phase: 'loading', score: '0', highestLevel: 0, shots: 0, merges: 0, left: 0, right: 0,
  danger: 0, rack: [], selected: -1, power: null, pad: 'none', message: '',
};

const TICK_MS = 1000 / 120;
const DRAG_THRESHOLD = 14;
const FULL_PULL = 215;
const FULL_POOL_PULL = 125;
const DIRECTIONS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
};
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function numberedDropOffset(state: Float32Array, id: number | null) {
  if (id !== null) {
    for (let index = 0; index < state[11]; index++) {
      const offset = SNAPSHOT_HEADER + index * SNAPSHOT_BODY_STRIDE;
      if (state[offset] === id && state[offset + SNAPSHOT_BODY_STRIDE - 1] === 0) return offset;
    }
  }
  return -1;
}

type PadInput = { index: number; id: string; buttons: boolean[] };
type PointerDrag = {
  id: number;
  target: Element;
  x: number;
  y: number;
  moved: boolean;
  fromSlot: boolean;
  dropId: number | null;
};
type AimSource = 'pointer' | 'keyboard' | 'pad';

interface GameOptions {
  theme: ArenaTheme;
  reducedMotion: boolean;
  sound: boolean;
}

interface GameEvents {
  hud: (hud: Hud) => void;
  archive: (record: RoundRecord) => void;
  progress: (score: string, scoredMerges: number, flags: (total: number) => number, rackMerge: boolean) => boolean;
}

export function mountGame(canvas: HTMLCanvasElement, events: GameEvents, options: GameOptions) {
  const ctx = canvas.getContext('2d');
  const sound = createSound();
  let round: { id: string; startedAt: number } | null = null;
  let engine: Awaited<ReturnType<typeof loadCore>> | null = null;
  let load: AbortController | null = null;
  let hud = initialHud;
  let phase: Phase = 'loading';
  let pointer: PointerDrag | null = null;
  let input: AimSource | null = null;
  let aim: ArenaAim | null = null;
  let keyboardDirection = { x: 0, y: 1 };
  const heldDirections = new Set<string>();
  let keyboardPower = 0.48;
  let padInput: PadInput | null = null;
  let padStatus: PadStatus = 'none';
  let selected = -1;
  let selectedPool: number | null = null;
  let message = '';
  let lastMerges = 0;
  let lastScoredMerges = 0;
  let lastCollision = 0;
  let lastRackMerge = 0;
  let lastDanger = false;
  let currentScore = '0';
  let frame = 0;
  let previous = performance.now();
  let lag = 0;
  let clock = 0;
  let dirty = true;
  let closed = false;

  function play(kind: Parameters<typeof sound.play>[0]) {
    if (options.sound) sound.play(kind);
  }

  function archive(reason: RoundRecord['reason']) {
    if (!round || !engine) return;
    const state = engine.snapshot();
    events.archive({
      ...round, endedAt: Math.max(round.startedAt, Date.now()), score: engine.score(),
      highestLevel: state[1], merges: state[2], shots: state[3], reason,
    });
  }

  function publish(state = round ? engine?.snapshot() : null) {
    const activeAim = aim ? Math.round(100 * aim.power) : null;
    const next: Hud = {
      phase, score: currentScore, highestLevel: state?.[1] ?? 0, shots: state?.[3] ?? 0,
      merges: state?.[2] ?? 0, left: Math.round((state?.[4] ?? 0) * 50) * 2,
      right: Math.round((state?.[5] ?? 0) * 50) * 2,
      danger: Math.ceil((state?.[6] ?? 0) * 10) / 10,
      rack: state && engine ? readHeldRack(state, engine.rackHulls(), hud.rack) : hud.rack,
      selected, power: activeAim,
      pad: padStatus, message,
    };
    if ((Object.keys(next) as (keyof Hud)[]).some(key => next[key] !== hud[key])) {
      hud = next;
      events.hud(hud);
    }
  }

  function cancel() {
    const captured = pointer;
    pointer = null;
    aim = null;
    input = null;
    if (captured?.target.hasPointerCapture(captured.id)) captured.target.releasePointerCapture(captured.id);
    dirty = true;
    publish();
  }

  function pause() {
    if (phase !== 'playing') return;
    phase = 'paused';
    engine?.core.set_paused(1);
    lag = 0;
    cancel();
  }

  function resume() {
    if (phase !== 'paused' || document.hidden) return;
    phase = 'playing';
    engine?.core.set_paused(0);
    previous = performance.now();
    lag = 0;
    dirty = true;
    publish();
  }

  async function initialize() {
    load?.abort();
    const request = new AbortController();
    load = request;
    phase = 'loading';
    publish();
    try {
      if (!ctx) throw new Error('Canvas 2D is unavailable');
      const loaded = await loadCore(request.signal);
      if (closed || request.signal.aborted) return;
      loaded.core.reset(1);
      loaded.snapshot();
      loaded.score();
      engine = loaded;
      phase = 'ready';
      dirty = true;
      publish();
    } catch {
      if (closed || request.signal.aborted) return;
      phase = 'failed';
      publish();
    }
  }

  function start() {
    if (!engine || (phase !== 'ready' && phase !== 'paused' && phase !== 'ended' && phase !== 'playing')) return;
    if (round && phase !== 'ended') archive('aborted');
    if (options.sound) sound.enable();
    cancel();
    if (ctx) clearLiquidIntro(ctx);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const startedAt = Date.now();
    engine.core.reset(seed);
    round = { id: crypto.randomUUID?.() ?? `${startedAt.toString(36)}-${seed.toString(36)}`, startedAt };
    phase = 'playing';
    selected = 0;
    selectedPool = null;
    message = '';
    currentScore = engine.score();
    lastMerges = 0;
    lastScoredMerges = 0;
    lastCollision = engine.core.collision_event();
    lastRackMerge = 0;
    lastDanger = false;
    keyboardDirection = { x: 0, y: 1 };
    heldDirections.clear();
    keyboardPower = 0.48;
    previous = performance.now();
    clock = 0;
    lag = 0;
    dirty = true;
    publish();
  }

  function process(state: Float32Array) {
    if (!engine) return;
    const rackMerge = state[17] !== lastRackMerge && state[16] >= 0;
    if (rackMerge) {
      if (!input && selected >= 0) selected = state[16];
      message = '';
    }
    lastRackMerge = state[17];
    const merges = state[2];
    if (merges > lastMerges) {
      lastMerges = merges;
      const core = engine.core;
      const scoredMerges = core.scored_merges();
      const delta = scoredMerges - lastScoredMerges;
      lastScoredMerges = scoredMerges;
      if (delta > 0) {
        currentScore = engine.score();
        const achievement = events.progress(currentScore, delta, total => core.achievement_flags(total), rackMerge);
        play(achievement ? 'achievement' : 'merge');
      } else play('merge');
    }
    const collision = engine.core.collision_event();
    if (collision !== lastCollision) {
      lastCollision = collision;
      play('collision');
    }
    const danger = state[6] > 0;
    if (danger && !lastDanger) play('danger');
    lastDanger = danger;
    if (state[7] && phase !== 'ended') {
      phase = 'ended';
      cancel();
      archive('blocked');
    }
  }

  function aimOrigin(state: Float32Array, poolOffset = numberedDropOffset(state, selectedPool)) {
    if (selectedPool !== null) {
      return poolOffset < 0 ? null : { x: state[poolOffset + 2], y: state[poolOffset + 3], pool: true };
    }
    if (selected < 0 || !rackLevel(state, selected)) return null;
    return {
      ...rackEntry(state, selected),
      blocked: !(state[0] & (1 << selected)),
    };
  }

  function setAim(dx: number, dy: number, power: number) {
    const state = engine?.snapshot();
    const length = Math.hypot(dx, dy);
    const origin = state ? aimOrigin(state) : null;
    aim = origin && length > 0 ? { ...origin, dx: dx / length, dy: dy / length, power } : null;
    dirty = true;
    publish(state);
  }

  function shoot() {
    const released = aim;
    cancel();
    if (!released || !engine || phase !== 'playing') return;
    if (released.pool) {
      if (selectedPool !== null && engine.core.throw_drop(selectedPool, released.dx, released.dy, released.power)) {
        play('launch');
      }
    } else if (engine.core.launch(selected, released.dx, released.dy, released.power)) {
      message = '';
      play('launch');
    } else {
      message = '发射口被挡住了，试试另一滴';
    }
    publish();
  }

  function select(slot: number) {
    if (phase !== 'playing' || !engine) return;
    if (!rackLevel(engine.snapshot(), slot)) return;
    cancel();
    selected = slot;
    selectedPool = null;
    message = '';
    publish();
  }

  function cancelAction() {
    if (input) cancel();
    else if (selectedPool !== null) {
      selectedPool = null;
      cancel();
    } else pause();
  }

  function pointerDown(event: PointerEvent, slot: number | undefined, target: Element) {
    if (!event.isPrimary || event.button !== 0 || (round && phase !== 'playing') || pointer) return;
    let dropId: number | null = null;
    if (slot !== undefined) {
      select(slot);
      if (slot !== selected) return;
    } else if (round && engine && ctx) {
      const position = arenaPosition(event);
      const state = engine.snapshot();
      if (position) dropId = findArenaDrop(ctx, state, position.x, position.y);
      if (dropId !== null) {
        selected = -1;
        selectedPool = numberedDropOffset(state, dropId) >= 0 ? dropId : null;
        message = '';
      }
    }
    cancel();
    target.setPointerCapture(event.pointerId);
    pointer = {
      id: event.pointerId, target, x: event.clientX, y: event.clientY,
      moved: false, fromSlot: slot !== undefined, dropId,
    };
    input = 'pointer';
  }

  function arenaPosition(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: (event.clientX - bounds.left) * ARENA_WIDTH / bounds.width,
      y: (event.clientY - bounds.top) * ARENA_HEIGHT / bounds.height,
      scaleX: ARENA_WIDTH / bounds.width,
      scaleY: ARENA_HEIGHT / bounds.height,
    };
  }

  function pointerMove(event: PointerEvent) {
    const titleHover = !round && event.pointerType === 'mouse';
    if (!titleHover && pointer?.id !== event.pointerId) return;
    const position = arenaPosition(event);
    if (!position) return;
    if (titleHover && ctx && !options.reducedMotion) trackLiquidIntro(ctx, position.x, position.y);
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = (event.clientX - pointer.x) * position.scaleX;
    const dy = (event.clientY - pointer.y) * position.scaleY;
    const distance = Math.hypot(dx, dy);
    pointer.moved ||= distance >= DRAG_THRESHOLD;
    if (!round || (selectedPool === null && selected < 0)) return;
    if (distance < DRAG_THRESHOLD) {
      aim = null;
      publish();
    } else {
      setAim(dx, dy, clamp(distance / (selectedPool === null ? FULL_PULL : FULL_POOL_PULL)));
    }
  }

  function pointerUp(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-liquid-cancel]')) {
      cancel();
      return;
    }
    pointerMove(event);
    const { dropId, moved, fromSlot } = pointer;
    if (moved) {
      shoot();
      return;
    }
    const position = arenaPosition(event);
    if (position && !fromSlot) {
      if (dropId !== null && phase === 'playing') {
        engine?.core.splash(dropId, position.x, position.y);
      } else if (!round && ctx && !options.reducedMotion) {
        burstLiquidIntro(ctx, position.x, position.y, options.reducedMotion);
      } else if (dropId === null) {
        selectedPool = null;
      }
    }
    cancel();
  }

  function pointerCancel(event: PointerEvent) {
    if (pointer?.id === event.pointerId) cancel();
  }

  function pointerLeave() {
    if (!round && ctx) clearLiquidIntroPointer(ctx);
  }

  function contextMenu(event: MouseEvent) {
    if (phase !== 'playing') return;
    event.preventDefault();
    cancel();
  }

  function cycleSlot(offset: number) {
    const state = engine?.snapshot();
    if (!state) return;
    const start = selected >= 0 ? selected : offset > 0 ? -1 : 0;
    for (let i = 1; i <= SLOT_COUNT; i++) {
      const slot = (start + offset * i + SLOT_COUNT) % SLOT_COUNT;
      if (rackLevel(state, slot)) {
        select(slot);
        break;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || phase !== 'playing' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea,select,[contenteditable],dialog')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!event.repeat) cancelAction();
      return;
    }
    if (/^[1-4]$/.test(event.key) && !event.repeat) select(Number(event.key) - 1);
    if (event.code === 'Space' && !(target?.closest('button,a') && input !== 'keyboard')) {
      event.preventDefault();
      if (event.repeat || pointer) return;
      if (selected >= 0 || selectedPool !== null) {
        cancel();
        input = 'keyboard';
        setAim(keyboardDirection.x, keyboardDirection.y, keyboardPower);
      }
    }
    if (DIRECTIONS[event.key] && !pointer) {
      event.preventDefault();
      heldDirections.add(event.key);
      let x = 0;
      let y = 0;
      for (const key of heldDirections) {
        x += DIRECTIONS[key].x;
        y += DIRECTIONS[key].y;
      }
      if (x || y) keyboardDirection = { x, y };
      if (input === 'keyboard') setAim(keyboardDirection.x, keyboardDirection.y, keyboardPower);
    }
    if ((event.key === '+' || event.key === '=' || event.key === '-') && !pointer) {
      event.preventDefault();
      keyboardPower = clamp(keyboardPower + (event.key === '-' ? -0.1 : 0.1));
      if (input === 'keyboard') setAim(keyboardDirection.x, keyboardDirection.y, keyboardPower);
    }
  }

  function onKeyUp(event: KeyboardEvent) {
    heldDirections.delete(event.key);
    if (event.code === 'Space' && input === 'keyboard') {
      event.preventDefault();
      shoot();
    }
  }

  function pollPad(elapsed: number) {
    const pads = Array.from(navigator.getGamepads?.() ?? []);
    const pad = pads.find(item => item?.connected && item.index === padInput?.index && item.id === padInput?.id)
      ?? pads.find(item => item?.connected && item.mapping === 'standard');
    if (!pad) {
      if (input === 'pad') cancel();
      padInput = null;
      padStatus = pads.some(item => item?.connected) ? 'unknown' : 'none';
      return;
    }
    padStatus = 'standard';
    const now = pad.buttons.map(button => button.pressed);
    const last = padInput?.index === pad.index && padInput.id === pad.id ? padInput.buttons : now;
    padInput = { index: pad.index, id: pad.id, buttons: now };
    const down = (button: number) => now[button] && !last[button];
    if (down(9)) {
      if (phase === 'playing') pause();
      else if (phase === 'paused' && document.querySelector('dialog[open][data-panel="pause"]')) resume();
      return;
    }
    if (phase !== 'playing') return;
    if (down(1)) {
      if (input) cancel();
      return;
    }
    if (pointer || input === 'keyboard') return;
    if (down(4)) cycleSlot(-1);
    if (down(5)) cycleSlot(1);
    if (down(0) && (selected >= 0 || selectedPool !== null)) input = 'pad';
    if (input !== 'pad') return;
    if (!now[0]) {
      if (last[0]) shoot();
      else cancel();
      return;
    }
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    const strength = pad.axes[3] ?? 0;
    const dx = Math.hypot(x, y) > 0.2 ? x : aim?.dx ?? 0;
    const dy = Math.hypot(x, y) > 0.2 ? y : aim?.dy ?? 1;
    const power = clamp((aim?.power ?? 0.48) + (Math.abs(strength) > 0.2 ? -strength * elapsed * 0.00085 : 0));
    setAim(dx, dy, power);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === width && canvas.height === height) return;
    if (pointer) cancel();
    canvas.width = width;
    canvas.height = height;
    dirty = true;
  }

  function tick(now: number) {
    const elapsed = clamp(now - previous, 0, 50);
    previous = now;
    if (!document.hidden) {
      pollPad(elapsed);
      if (phase === 'playing' && engine) {
        clock += elapsed;
        lag += elapsed;
        while (lag >= TICK_MS) {
          engine.core.step();
          lag -= TICK_MS;
        }
      } else if (!round && !options.reducedMotion) {
        clock += elapsed;
      }
      const state = round ? engine?.snapshot() : null;
      if (state && phase === 'playing') {
        const poolOffset = numberedDropOffset(state, selectedPool);
        if (selectedPool !== null && poolOffset < 0) {
          selectedPool = null;
          cancel();
        }
        process(state);
        if (aim) {
          const origin = aimOrigin(state, poolOffset);
          if (origin) Object.assign(aim, origin);
          else cancel();
        }
      }
      if (ctx && (dirty || phase === 'playing' || (!round && !options.reducedMotion))) {
        ctx.setTransform(canvas.width / ARENA_WIDTH, 0, 0, canvas.height / ARENA_HEIGHT, 0, 0);
        const mergeEvents = state ? engine?.mergeEvents() : undefined;
        const rackHulls = state ? engine?.rackHulls() : undefined;
        drawArena(ctx, state ?? null, aim, options.theme, clock, options.reducedMotion, mergeEvents, selected, rackHulls, selectedPool);
        if (mergeEvents?.length) engine?.core.clear_merge_events();
        dirty = false;
      }
      publish(state);
    }
    frame = requestAnimationFrame(tick);
  }

  function onHide() {
    if (document.hidden) pause();
  }

  function onBlur() {
    heldDirections.clear();
    cancel();
    pointerLeave();
  }

  function onPageHide() {
    if (phase !== 'ended') archive('aborted');
    pause();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onHide);
  frame = requestAnimationFrame(tick);
  void initialize();

  return {
    retry: initialize, start, select, pause, resume, cancel,
    pointerDown, pointerMove, pointerUp, pointerCancel, pointerLeave, contextMenu,
    leave: () => { if (phase !== 'ended') archive('aborted'); },
    update(next: GameOptions) {
      if (next.sound && !options.sound) sound.enable();
      options = next;
      dirty = true;
    },
    destroy() {
      closed = true;
      load?.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onHide);
      if (ctx) clearLiquidIntro(ctx);
      sound.close();
    },
  };
}

export type GameControls = ReturnType<typeof mountGame>;
