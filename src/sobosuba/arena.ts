import { smoothPuddlePath, tracePuddleField } from './liquid-field';
import { advanceLiquidFlow } from './liquid-flow';
import type { LiquidFlow } from './liquid-flow';
import { paintLiquidIntro } from './liquid-intro';
import { fitLiquidSurface, fitWetContacts, measureSurface } from './liquid-surface';
import type { LiquidSurface } from './liquid-surface';
import {
  BODY_HULL_NODES as NODES, BODY_IMPACT_OFFSET, MERGE_EVENT_STRIDE, RACK_HULL_STRIDE, rackIdentity, rackLevel,
  rackSlot, SLOT_COUNT, SNAPSHOT_BODY_STRIDE as STRIDE, SNAPSHOT_HEADER,
} from './rack';
import type { RackSlot } from './rack';

export const ARENA_WIDTH = 640;
export const ARENA_HEIGHT = 700;

const FLOOR = 676;
const CEILING = 8;
const WALL_INSET = 32;
const WALL_TRAVEL = 18;
const LAUNCH_MIN_SPEED = 150;
const LAUNCH_SPEED_RANGE = 1220;
const FLIGHT_SPEED_LIMIT = 1500;
const FUSION_MS = 430;
const LABEL_FONT = '"Space Grotesk Variable", system-ui, sans-serif';
const radii = [24, 30, 37, 45, 54, 64, 75, 86, 97, 107, 116, 124];

export interface ArenaAim {
  x: number;
  y: number;
  dx: number;
  dy: number;
  power: number;
  blocked?: boolean;
  pool?: boolean;
}

export interface ArenaTheme {
  colors: readonly string[];
  accent: string;
  danger: string;
  board: string;
  grid: string;
}

interface Fusion {
  dx: number;
  dy: number;
  mix: number;
}

interface Shape {
  x: number;
  y: number;
  radius: number;
  level: number;
  seed: number;
  phase: number;
  flowX?: number;
  flowY?: number;
  flow?: LiquidFlow;
  xx?: number;
  xy?: number;
  yy?: number;
  surface?: LiquidSurface;
  held?: { left: number; right: number };
  fusion?: Fusion;
  selected?: boolean;
}

interface Motion {
  x: number;
  y: number;
  level: number | null;
  vx: number;
  vy: number;
  flow?: LiquidFlow;
}

interface HeldSurface {
  surface: LiquidSurface;
  angle: number;
  rx: number;
  ry: number;
}

interface MergeVisual {
  start: number;
  dx: number;
  dy: number;
  level: number;
}

interface ArenaPaint {
  time: number;
  event: number;
  motions: Map<number, Motion>;
  heldMotions: Map<number, Motion>;
  merges: Map<number, MergeVisual>;
  heldMerges: Map<number, MergeVisual>;
  outlines: Map<number, Float32Array>;
  plate: number;
}

const paints = new WeakMap<CanvasRenderingContext2D, ArenaPaint>();
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function shapeAxes(angle: number, rx: number, ry: number) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { xx: rx * cos * cos + ry * sin * sin, xy: (rx - ry) * cos * sin, yy: rx * sin * sin + ry * cos * cos };
}

function radiusForLevel(level: number) {
  const index = Math.max(0, level - 1);
  return radii[index] ?? 154 - 30 / (1 + 0.16 * (index - radii.length + 1));
}

export function dropColor(level: number, theme: ArenaTheme) {
  if (level < 1) return theme.accent;
  const color = theme.colors[level - 1];
  if (color) return color;

  // An odd multiplier permutes 17 bits, enough for every rank in a saved round.
  // The bright RGB lattice (even red/green, blue 130 + 4n) is reserved for this fallback.
  const mixed = Math.imul(level, 0x9e3779b1);
  const red = 128 + (mixed & 63) * 2;
  const green = 128 + ((mixed >>> 6) & 63) * 2;
  const blue = 130 + ((mixed >>> 12) & 31) * 4;
  return `rgb(${red}, ${green}, ${blue})`;
}

export function dropLabel(level: number) {
  return level <= 20 ? String(2 ** level) : `2^${level}`;
}

function paintLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  ctx.font = `700 ${size}px ${LABEL_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#151208';
  ctx.fillText(text, x, y);
}

function insideOutline(outline: Float32Array, x: number, y: number) {
  let inside = false;
  for (let i = 0, j = outline.length - 2; i < outline.length; j = i, i += 2) {
    const a = outline[i + 1], b = outline[j + 1];
    if ((a > y) !== (b > y) && x < outline[i] + (outline[j] - outline[i]) * ((y - a) / (b - a))) {
      inside = !inside;
    }
  }
  return inside;
}

export function findArenaDrop(ctx: CanvasRenderingContext2D, state: Float32Array, x: number, y: number): number | null {
  const paint = paints.get(ctx);
  if (x < WALL_INSET - WALL_TRAVEL * state[4] || x > ARENA_WIDTH - WALL_INSET + WALL_TRAVEL * state[5] || y < CEILING || y > FLOOR) return null;
  for (let i = state[11] - 1; i >= 0; i--) {
    const offset = SNAPSHOT_HEADER + i * STRIDE;
    const id = state[offset];
    const outline = paint?.outlines.get(id) ?? state.subarray(offset + 8, offset + 8 + NODES * 2);
    if (insideOutline(outline, x, y)) return id;
  }
  return null;
}

function paintPuddle(ctx: CanvasRenderingContext2D, shape: Shape, theme: ArenaTheme, label = true) {
  const {
    x, y, radius, level, seed, phase, flowX = 0, flowY = 0, flow, fusion,
    xx = radius, xy = 0, yy = radius,
  } = shape;
  const field = tracePuddleField({ seed, phase, flowX, flowY, flow, fusion });
  const outline = shape.surface
    ? fitLiquidSurface(field, shape.surface, xx, xy, yy, fusion?.mix ?? 0, shape.held)
    : field;
  const scale = shape.surface || shape.held ? 1 : 0.87;
  for (let i = 0; i < outline.length; i += 2) {
    const u = outline[i] * scale, v = outline[i + 1] * scale;
    const screenX = x + u * xx + v * xy;
    outline[i] = shape.held ? Math.max(shape.held.left, Math.min(shape.held.right, screenX)) : screenX;
    outline[i + 1] = y + u * xy + v * yy;
  }
  ctx.beginPath();
  smoothPuddlePath(outline, (a, b) => ctx.moveTo(a, b), (a, b, c, d) => ctx.quadraticCurveTo(a, b, c, d));
  ctx.closePath();
  if (shape.selected) {
    ctx.lineWidth = shape.held ? 5 : 7;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff5d8';
    ctx.stroke();
  }
  ctx.fillStyle = dropColor(level, theme);
  ctx.fill('evenodd');
  if (label) {
    const text = dropLabel(level);
    const size = Math.max(16, Math.min(Math.min(xx, yy) * 0.93, xx * 3.1 / text.length));
    paintLabel(ctx, text, x, y + radius * 0.03, size);
  }
  return outline;
}

export function drawDrop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  level: number,
  theme: ArenaTheme,
  time = 0,
  selected = false,
) {
  ctx.save();
  paintPuddle(ctx, { x, y, radius, level, seed: level, phase: time * 0.0025, selected }, theme);
  ctx.restore();
}

function paintFrame(ctx: CanvasRenderingContext2D, theme: ArenaTheme, leftLoad: number, rightLoad: number, pulse: number) {
  const left = WALL_INSET - WALL_TRAVEL * leftLoad;
  const right = ARENA_WIDTH - WALL_INSET + WALL_TRAVEL * rightLoad;
  ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  ctx.beginPath();
  ctx.roundRect(left - 14, 0, right - left + 28, FLOOR + 17, [17, 17, 25, 25]);
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.fillStyle = theme.board;
  ctx.fillRect(left, CEILING, right - left, FLOOR - CEILING);
  // The horizontal bumper recoils toward the frame when the ceiling is struck.
  ctx.beginPath();
  ctx.roundRect(left + 18, CEILING - 5 - pulse * 4, right - left - 36, 10, 5);
  ctx.fillStyle = theme.grid;
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(left + 29, CEILING - 2 - pulse * 4, right - left - 58, 3, 1.5);
  ctx.globalAlpha = 0.36 + pulse * 0.64;
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.board;
  for (const [x, load] of [[left - 9.5, leftLoad], [right + 4.5, rightLoad]]) {
    ctx.beginPath();
    ctx.roundRect(x, 245, 5, 160, 2.5);
    ctx.fill();
    if (load > 0.01) {
      ctx.beginPath();
      ctx.roundRect(x, 405 - 160 * load, 5, 160 * load, 2.5);
      ctx.fillStyle = load > 0.93 ? theme.danger : theme.grid;
      ctx.fill();
      ctx.fillStyle = theme.board;
    }
  }
  return { left, right };
}

function paintReboundGuide(
  ctx: CanvasRenderingContext2D,
  aim: ArenaAim,
  held: RackSlot[],
  selected: number,
  ux: number,
  uy: number,
  radius: number,
  charge: number,
  left: number,
  right: number,
  color: string,
) {
  if (aim.blocked || uy >= -0.14) return;
  // Follow the unobstructed shot to the ceiling and show one rebound. Contact
  // deforms the real drop, so this continuation stays an approximate guide.
  const tick = 1 / 120;
  const speed = LAUNCH_MIN_SPEED + LAUNCH_SPEED_RANGE * charge;
  const drag = 1 - (0.09 + 4.56 / radius) * tick;
  const level = held[selected].level;
  const rackY = held[selected].y;
  const top = CEILING + radius;
  let { x, y } = aim;
  let vx = speed * ux, vy = speed * uy;
  const samples: { x: number; y: number }[] = [];
  for (let step = 0; step < 108; step++) {
    vy += 1120 * tick;
    const scale = drag / Math.max(1, Math.hypot(vx, vy) / FLIGHT_SPEED_LIMIT);
    vx *= scale;
    vy *= scale;
    x += vx * tick;
    y += vy * tick;
    if (x < left + radius || x > right - radius || y > rackY + radius + 50) break;
    if (!samples.length) {
      if (vy >= -42) break;
      if (y > top) continue;
      y = top;
      vx -= Math.sign(vx) * Math.min(Math.abs(vx), -vy * 0.025);
      vy *= -0.58;
      samples.push({ x, y });
      continue;
    }
    samples.push({ x, y });
    const reachedRack = held.some((target, slot) => slot !== selected && target.level === level && target.radius > 0 &&
      Math.hypot(x - target.x, y - target.y) < radius + target.radius);
    if (reachedRack) break;
  }
  if (samples.length <= 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(samples[0].x, samples[0].y);
  for (const sample of samples.slice(1)) ctx.lineTo(sample.x, sample.y);
  ctx.setLineDash([5, 6]);
  ctx.globalAlpha = 0.46 + charge * 0.30;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 + charge * 1.2;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
  return samples[0];
}

function paintAim(
  ctx: CanvasRenderingContext2D,
  aim: ArenaAim,
  state: Float32Array,
  theme: ArenaTheme,
  time: number,
  selected: number,
  left: number,
  right: number,
  rackHulls: Float32Array,
) {
  if (selected < 0 || selected >= SLOT_COUNT) return;
  const { x, y, blocked, power } = aim;
  const length = Math.hypot(aim.dx, aim.dy);
  const ux = length ? aim.dx / length : 0;
  const uy = length ? aim.dy / length : 1;
  const pull = clamp(power);
  // Mirror the engine's launch_speed curve for the guide's reach and rebound.
  const charge = pull * (0.42 + 0.58 * pull);
  const color = blocked ? theme.danger : theme.accent;
  const level = rackLevel(state, selected) || 1;
  const rack = Array.from({ length: SLOT_COUNT }, (_, slot) => rackSlot(state, slot, rackHulls));
  const held = rack[selected];
  const flightRadius = radiusForLevel(level);
  const radius = held.radius || Math.min(43, flightRadius);
  const heldOrigin = held.radius > 0 && Math.hypot(x - held.x, y - held.y) <= held.radius;
  const rebound = heldOrigin && flightRadius > held.radius + 0.01 ? undefined
    : paintReboundGuide(ctx, aim, rack, selected, ux, uy, flightRadius, charge, left, right, color);
  const exitX = ux > 0 ? (right - 13 - x) / ux : ux < 0 ? (left + 13 - x) / ux : Infinity;
  const exitY = uy > 0 ? (FLOOR - 13 - y) / uy : uy < 0 ? (CEILING + 13 - y) / uy : Infinity;
  const reboundReach = rebound ? Math.hypot(rebound.x - x, rebound.y - y) : Infinity;
  const end = Math.min(radius * 0.84 + 33 + (blocked ? 0 : charge * 164), exitX, exitY, reboundReach);
  const start = Math.max(0, Math.min(radius * 0.84, end - 20));
  if (end > 8) {
    const feather = Math.min(6 + charge * 4, end / 4);
    const head = Math.min(13 + charge * 6, end / 2);
    const tipX = rebound && end === reboundReach ? rebound.x : x + ux * end;
    const tipY = rebound && end === reboundReach ? rebound.y : y + uy * end;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + ux * start, y + uy * start);
    ctx.lineTo(tipX, tipY);
    if (!blocked) {
      ctx.moveTo(tipX - ux * head - uy * feather, tipY - uy * head + ux * feather);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(tipX - ux * head + uy * feather, tipY - uy * head - ux * feather);
    }
    ctx.globalAlpha = blocked ? 1 : 0.62 + charge * 0.38;
    ctx.lineWidth = blocked ? 4 : 3 + charge * 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  if (!heldOrigin) {
    ctx.save();
    ctx.globalAlpha = blocked ? 0.34 : 0.84;
    paintPuddle(ctx, { x, y, radius, level, seed: 13, phase: time * 0.0023, flowX: ux * 0.4, flowY: uy * 0.4 }, theme);
    ctx.restore();
  }
}

function paintPoolSelection(ctx: CanvasRenderingContext2D, outline: Float32Array) {
  ctx.save();
  ctx.beginPath();
  smoothPuddlePath(outline, (x, y) => ctx.moveTo(x, y), (x, y, endX, endY) => ctx.quadraticCurveTo(x, y, endX, endY));
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#151208';
  ctx.stroke();
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = '#fff5d8';
  ctx.stroke();
  ctx.restore();
}

function paintPoolAim(
  ctx: CanvasRenderingContext2D,
  aim: ArenaAim,
  body: Motion,
  outline: Float32Array,
  left: number,
  right: number,
) {
  const direction = Math.hypot(aim.dx, aim.dy);
  if (!direction) return;
  // Match the opening direction of the short throw, including its carry-over of momentum.
  const impulse = (210 + 320 * clamp(aim.power)) / direction;
  const carry = 0.18 / Math.max(1, Math.hypot(body.vx, body.vy) / 380);
  const vx = aim.dx * impulse + body.vx * carry;
  const vy = aim.dy * impulse + body.vy * carry;
  const speed = Math.hypot(vx, vy);
  const ux = vx / speed, uy = vy / speed;
  const { x, y } = body;
  let edge = 0;
  for (let i = 0; i < outline.length; i += 2) {
    edge = Math.max(edge, (outline[i] - x) * ux + (outline[i + 1] - y) * uy);
  }
  const exitX = ux > 0 ? (right - 7 - x) / ux : ux < 0 ? (left + 7 - x) / ux : Infinity;
  const exitY = uy > 0 ? (FLOOR - 7 - y) / uy : uy < 0 ? (CEILING + 7 - y) / uy : Infinity;
  const end = Math.min(edge + 5 + Math.min(speed, 550) * 0.15, exitX, exitY);
  if (end < edge + 9) return;
  const tipX = x + ux * end, tipY = y + uy * end;
  const head = Math.min(12, (end - edge) * 0.55);
  const feather = head * 0.54;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + ux * (edge + 5), y + uy * (edge + 5));
  ctx.lineTo(tipX, tipY);
  ctx.moveTo(tipX - ux * head - uy * feather, tipY - uy * head + ux * feather);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tipX - ux * head + uy * feather, tipY - uy * head - ux * feather);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5.4;
  ctx.strokeStyle = '#151208';
  ctx.stroke();
  ctx.lineWidth = 2.8;
  ctx.strokeStyle = '#fff5d8';
  ctx.stroke();
  ctx.restore();
}

function rememberMerges(
  paint: ArenaPaint,
  state: Float32Array,
  events: Float32Array | undefined,
  time: number,
) {
  const latest = events ?? state.subarray(12, 16);
  const stride = events ? MERGE_EVENT_STRIDE : 4;
  let liveIds: Set<number> | undefined;
  for (let event = 0; event + stride <= latest.length; event += stride) {
    const id = latest[event];
    const x = latest[event + 1];
    const y = latest[event + 2];
    const level = latest[event + 3];
    if (id <= paint.event || x < 0 || y < 0) continue;
    const slot = events ? latest[event + 4] : id === state[17] ? state[16] : -1;
    let best = Math.max(16, radiusForLevel(level));
    let successor = -1;
    if (slot < 0) {
      for (let i = 0; i < state[11]; i++) {
        const offset = SNAPSHOT_HEADER + i * STRIDE;
        if (state[offset + 1] !== level || paint.motions.has(state[offset]) || paint.merges.has(state[offset])) continue;
        const distance = Math.hypot(state[offset + 2] - x, state[offset + 3] - y);
        if (distance < best) {
          successor = state[offset];
          best = distance;
        }
      }
      if (successor < 0) continue;
    }
    let dx = slot < 0 ? 1 : -0.4;
    let dy = slot < 0 ? -0.29 : 1;
    let closest = best * 2 + radiusForLevel(level) * 1.7;
    if (!liveIds) {
      liveIds = new Set<number>();
      for (let i = 0; i < state[11]; i++) liveIds.add(state[SNAPSHOT_HEADER + i * STRIDE]);
    }
    for (const [dropId, drop] of paint.motions) {
      if (drop.level === null || drop.level + 1 !== level || liveIds.has(dropId)) continue;
      const px = drop.x - x, py = drop.y - y;
      const distance = Math.hypot(px, py);
      if (distance > 2 && distance < closest) {
        dx = px / distance;
        dy = py / distance;
        closest = distance;
      }
    }
    const magnitude = Math.hypot(dx, dy);
    const visual = { start: time, dx: dx / magnitude, dy: dy / magnitude, level };
    if (slot >= 0) paint.heldMerges.set(slot, visual);
    else paint.merges.set(successor, visual);
  }
  paint.event = state[12];
  for (const [id, effect] of paint.merges) {
    if (time - effect.start > FUSION_MS) paint.merges.delete(id);
  }
  for (const [slot, effect] of paint.heldMerges) {
    if (time - effect.start > FUSION_MS) paint.heldMerges.delete(slot);
  }
}

function fusionField(effect: MergeVisual | undefined, time: number) {
  if (!effect) return undefined;
  const age = clamp((time - effect.start) / FUSION_MS);
  const reach = 0.69 - age * 0.36;
  return { dx: effect.dx * reach, dy: effect.dy * reach, mix: (1 - age) ** 1.45 };
}

function paintDrops(
  ctx: CanvasRenderingContext2D,
  state: Float32Array,
  theme: ArenaTheme,
  time: number,
  reducedMotion: boolean,
  left: number,
  right: number,
  rackHulls: Float32Array,
  events?: Float32Array,
) {
  let paint = paints.get(ctx);
  if (!paint || paint.time > time || paint.event > state[12]) {
    paint = { time, event: 0, motions: new Map(), heldMotions: new Map(), merges: new Map(), heldMerges: new Map(),
      outlines: new Map(), plate: 0 };
    paints.set(ctx, paint);
  }
  if (reducedMotion) {
    paint.event = state[12];
    paint.merges.clear();
    paint.heldMerges.clear();
  } else {
    rememberMerges(paint, state, events, time);
  }
  const fresh = new Map<number, Motion>();
  const seconds = (time - paint.time) * 0.001;
  paint.outlines.clear();
  paint.plate = reducedMotion ? 0 : paint.plate * Math.exp(-seconds * 13);
  const surfaces: LiquidSurface[] = [];
  for (let i = 0; i < state[11]; i++) {
    const offset = SNAPSHOT_HEADER + i * STRIDE;
    const radius = Math.sqrt(state[offset + 5] * state[offset + 6]);
    const hull = state.subarray(offset + 8, offset + 8 + NODES * 2);
    const impact = offset + BODY_IMPACT_OFFSET;
    const depth = state[impact + 2], width = state[impact + 3];
    surfaces.push(measureSurface(state[offset + 2], state[offset + 3], radius, hull, state[offset + STRIDE - 1] > 0,
      width > 0 && Math.abs(depth) > 0.02 ? { nx: state[impact], ny: state[impact + 1], depth, width } : undefined));
  }
  const rack = Array.from({ length: SLOT_COUNT }, (_, slot): HeldSurface | null => {
    const offset = slot * RACK_HULL_STRIDE;
    const [x, y, angle, rx, ry] = rackHulls.subarray(offset, offset + 5);
    if (rx <= 0 || ry <= 0) return null;
    const hull = rackHulls.subarray(offset + 5, offset + RACK_HULL_STRIDE);
    return { surface: measureSurface(x, y, Math.sqrt(rx * ry), hull), angle, rx, ry };
  });
  fitWetContacts(surfaces, rack.map(held => held?.surface ?? null), left, right, CEILING, FLOOR);

  for (let i = 0; i < state[11]; i++) {
    const offset = SNAPSHOT_HEADER + i * STRIDE;
    const id = state[offset];
    const level = state[offset + 1];
    const fragmentPalette = state[offset + STRIDE - 1];
    const x = state[offset + 2], y = state[offset + 3];
    const angle = state[offset + 4];
    const rx = state[offset + 5], ry = state[offset + 6];
    const surface = surfaces[i];
    const { radius, hull } = surface;
    const previous = paint.motions.get(id);
    let vx = previous?.vx ?? 0, vy = previous?.vy ?? 0;
    if (previous && seconds > 0.002) {
      const response = 1 - Math.exp(-seconds * 19);
      vx += ((x - previous.x) / seconds - vx) * response;
      vy += ((y - previous.y) / seconds - vy) * response;
    }
    const speedScale = 1 / Math.max(650, Math.hypot(vx, vy));
    const impact = state[offset + 7];
    const phase = reducedMotion ? 0 : time * (0.002 + (id % 4) * 0.00041) + id * 2.39996;
    const flow = advanceLiquidFlow(reducedMotion ? undefined : previous?.flow, reducedMotion ? 0 : seconds, phase, vx, vy);
    fresh.set(id, { x, y, level: surface.fragment ? null : level, vx, vy, flow });
    if (!reducedMotion && impact > 0.12) {
      for (let n = 1; n < hull.length; n += 2) {
        if (hull[n] <= CEILING + 12) {
          paint.plate = Math.max(paint.plate, impact);
          break;
        }
      }
    }
    const outline = paintPuddle(ctx, {
      x, y, radius, level: surface.fragment ? fragmentPalette - 1 : level, seed: id,
      phase, flow,
      flowX: reducedMotion ? 0 : vx * speedScale,
      flowY: reducedMotion ? 0 : vy * speedScale,
      ...shapeAxes(angle, rx, ry), surface,
      fusion: fusionField(paint.merges.get(id), time),
    }, theme, !surface.fragment);
    paint.outlines.set(id, outline);
  }
  paint.motions = fresh;
  paint.time = time;
  return { paint, seconds, rack };
}

function paintHeld(
  ctx: CanvasRenderingContext2D,
  state: Float32Array,
  theme: ArenaTheme,
  time: number,
  seconds: number,
  reducedMotion: boolean,
  selected: number,
  paint: ArenaPaint,
  rack: (HeldSurface | null)[],
) {
  const positions = rack.flatMap((held, slot) => held ? [{ ...held, slot }] : []);
  // The selected drop's bright stroke remains on the free edge; neighboring
  // fills establish the seam where the suspension squeezes the drops together.
  const order = positions.map((_, index) => index);
  const active = positions.findIndex(held => held.slot === selected);
  if (active > 0) order.unshift(...order.splice(active, 1));
  const fresh = new Map<number, Motion>();
  for (const index of order) {
    const { slot, surface, angle, rx, ry } = positions[index];
    const { x, y, radius } = surface;
    const level = rackLevel(state, slot);
    const identity = rackIdentity(state, slot);
    const leftEdge = positions[index - 1]?.surface.right ?? -Infinity;
    const rightEdge = positions[index + 1]?.surface.left ?? Infinity;
    const left = surface.left - leftEdge < 4 ? (leftEdge + surface.left) * 0.5 + 0.52 : -Infinity;
    const right = rightEdge - surface.right < 4 ? (rightEdge + surface.right) * 0.5 - 0.52 : Infinity;
    const effect = paint.heldMerges.get(slot);
    const motion = paint.heldMotions.get(identity);
    const phase = time * (0.0014 + identity % 4 * 0.00015) + identity * 2.4;
    const velocityScale = motion?.level === level && seconds > 0.002 ? 1 / seconds : 0;
    const vx = (x - (motion?.x ?? x)) * velocityScale;
    const vy = (y - (motion?.y ?? y)) * velocityScale;
    const flow = advanceLiquidFlow(reducedMotion || motion?.level !== level ? undefined : motion.flow,
      reducedMotion ? 0 : seconds, phase, vx, vy);
    fresh.set(identity, { x, y, level, vx, vy, flow });
    paintPuddle(ctx, {
      x, y, radius, level, surface, held: { left, right }, seed: identity + 21, phase, flow, ...shapeAxes(angle, rx, ry),
      selected: selected === slot, fusion: fusionField(effect?.level === level ? effect : undefined, time),
    }, theme);
  }
  paint.heldMotions = fresh;
}

export function drawArena(
  ctx: CanvasRenderingContext2D,
  state: Float32Array | null,
  aim: ArenaAim | null,
  theme: ArenaTheme,
  time: number,
  reducedMotion: boolean,
  events?: Float32Array,
  selected = -1,
  rackHulls?: Float32Array,
  selectedPool: number | null = null,
) {
  ctx.save();
  const plate = state && !reducedMotion ? paints.get(ctx)?.plate ?? 0 : 0;
  const { left, right } = paintFrame(ctx, theme, state?.[4] ?? 0, state?.[5] ?? 0, plate);
  ctx.beginPath();
  ctx.rect(left, CEILING, right - left, FLOOR - CEILING);
  ctx.clip();
  const motionTime = reducedMotion ? 0 : time;
  if (!state || !rackHulls) {
    paints.delete(ctx);
    paintLiquidIntro(ctx, theme, motionTime, reducedMotion);
  } else {
    const { paint, seconds, rack } = paintDrops(ctx, state, theme, time, reducedMotion, left, right, rackHulls, events);
    if (selectedPool !== null) {
      const body = paint.motions.get(selectedPool);
      const outline = paint.outlines.get(selectedPool);
      if (body && body.level !== null && outline) {
        paintPoolSelection(ctx, outline);
        if (aim?.pool) paintPoolAim(ctx, aim, body, outline, left, right);
      }
    }
    if (aim && !aim.pool) paintAim(ctx, aim, state, theme, motionTime, selected, left, right, rackHulls);
    paintHeld(ctx, state, theme, motionTime, seconds, reducedMotion, selected, paint, rack);
  }
  ctx.restore();
}
