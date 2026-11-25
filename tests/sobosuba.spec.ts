import { devices, expect, test, type Page } from '@playwright/test';
import { dropColor } from '../src/sobosuba/arena';
import { themes } from '../src/sobosuba/profile';
import {
  RACK_HULL_STRIDE, SLOT_COUNT, SNAPSHOT_BODY_STRIDE, SNAPSHOT_HEADER, rackEntry, rackIdentity, rackLevel, rackSlot,
} from '../src/sobosuba/rack';

const gamePath = '/';
const startButton = (page: Page) => page.getByRole('button', { name: '开始游戏', exact: true });
const slotButton = (page: Page, slot: number) => page.getByRole('button', { name: new RegExp(`待发 ${slot}`) });
const canvas = (page: Page) => page.getByTestId('arena');
const shots = (page: Page) => page.getByTestId('shots');
async function openAchievements(page: Page) {
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.getByRole('button', { name: '成就与配色', exact: true }).click();
}
const mintTheme = (page: Page) => page.getByRole('dialog', { name: '成就与配色', exact: true })
  .getByRole('button', { name: '薄荷汽水', exact: true });
function isWasmBinary(url: URL) {
  return /sobosuba_engine[^/]*\.wasm$/.test(url.pathname) &&
    !url.searchParams.has('import') && !url.searchParams.has('url');
}

async function useRoundSeed(page: Page, seed: number) {
  await page.addInitScript(roundSeed => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = array => {
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = roundSeed;
        return array;
      }
      return getRandomValues(array);
    };
  }, seed);
}

async function canvasStart(page: Page) {
  const bounds = await canvas(page).boundingBox();
  if (!bounds) throw new Error('Expected a visible liquid2048 playfield');
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
    width: bounds.width,
    height: bounds.height,
  };
}

type SnapshotWindow = Window & {
  readLiquidSnapshot?: () => Float32Array;
  readLiquidRackHulls?: () => Float32Array;
  readPaintedDrop?: () => number[];
};

async function observeLiquidBodies(page: Page) {
  await page.addInitScript(rackHullLength => {
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = (async (source: BufferSource, imports?: WebAssembly.Imports) => {
      const result = await instantiate(source, imports);
      const core = result.instance?.exports;
      if (core?.memory instanceof WebAssembly.Memory && typeof core.splash === 'function' &&
          typeof core.snapshot_ptr === 'function' && typeof core.snapshot_len === 'function') {
        const { memory, snapshot_ptr, snapshot_len, rack_hulls_ptr } = core;
        const windowWithEngine = window as SnapshotWindow;
        windowWithEngine.readLiquidSnapshot = () => new Float32Array(memory.buffer, snapshot_ptr(), snapshot_len());
        if (typeof rack_hulls_ptr === 'function') {
          windowWithEngine.readLiquidRackHulls = () => new Float32Array(memory.buffer, rack_hulls_ptr(), rackHullLength);
        }
      }
      return result;
    }) as typeof WebAssembly.instantiate;
  }, SLOT_COUNT * RACK_HULL_STRIDE);

  return () => page.evaluate(({ header, stride }) => {
    const state = (window as SnapshotWindow).readLiquidSnapshot?.();
    if (!state) return [];
    return Array.from({ length: state[11] }, (_, i) => {
      const offset = header + i * stride;
      const [id, level, x, y, , rx, ry] = state.subarray(offset, offset + 7);
      return { id, level, x, y, rx, area: rx * ry, fragment: state[offset + stride - 1] > 0 };
    });
  }, { header: SNAPSHOT_HEADER, stride: SNAPSHOT_BODY_STRIDE });
}

async function observeRackHull(page: Page, slot: number) {
  return page.evaluate(({ start, length }) => {
    const hulls = (window as SnapshotWindow).readLiquidRackHulls?.();
    return hulls ? Array.from(hulls.subarray(start, start + length)) : [];
  }, { start: slot * RACK_HULL_STRIDE, length: RACK_HULL_STRIDE });
}

async function readRack(page: Page) {
  const { state, hulls } = await page.evaluate(header => {
    const arena = window as SnapshotWindow;
    return {
      state: Array.from(arena.readLiquidSnapshot?.().subarray(0, header) ?? []),
      hulls: Array.from(arena.readLiquidRackHulls?.() ?? []),
    };
  }, SNAPSHOT_HEADER);
  if (state.length !== SNAPSHOT_HEADER) throw new Error('Expected the active liquid2048 snapshot');
  const snapshot = Float32Array.from(state);
  return Array.from({ length: SLOT_COUNT }, (_, slot) => ({
    id: rackIdentity(snapshot, slot),
    level: rackLevel(snapshot, slot),
    targetX: rackSlot(snapshot, slot).targetX,
    entry: rackEntry(snapshot, slot),
    x: hulls[slot * RACK_HULL_STRIDE],
  }));
}

async function observePaintedSurface(page: Page, color: string) {
  await page.addInitScript(color => {
    const context = CanvasRenderingContext2D.prototype;
    const { beginPath, clearRect, quadraticCurveTo, fill } = context;
    const isArena = (ctx: CanvasRenderingContext2D) => ctx.canvas.dataset.testid === 'arena';
    let path: number[] = [];
    let painted: number[] = [];
    context.clearRect = function (...args) {
      if (isArena(this)) painted = [];
      clearRect.apply(this, args);
    };
    context.beginPath = function () {
      if (isArena(this)) path = [];
      beginPath.call(this);
    };
    context.quadraticCurveTo = function (...args) {
      if (isArena(this)) path.push(args[2], args[3]);
      quadraticCurveTo.apply(this, args);
    };
    context.fill = function (...args: [CanvasFillRule?] | [Path2D, CanvasFillRule?]) {
      if (isArena(this) && args[0] === 'evenodd' && this.fillStyle === color && !painted.length) {
        painted = path.slice();
      }
      Reflect.apply(fill, this, args);
    };
    (window as SnapshotWindow).readPaintedDrop = () => painted;
  }, color);

  return (x: number, radius: number) => page.evaluate(({ x, radius }) => {
    const points = (window as SnapshotWindow).readPaintedDrop?.() ?? [];
    let center = Infinity, left = Infinity, right = Infinity;
    for (let index = 0; index < points.length; index += 2) {
      const across = (points[index] - x) / radius;
      const y = points[index + 1];
      if (Math.abs(across) < 0.14) center = Math.min(center, y);
      if (across < -0.35 && across > -0.74) left = Math.min(left, y);
      if (across > 0.35 && across < 0.74) right = Math.min(right, y);
    }
    return { center, cup: center - (left + right) / 2 };
  }, { x, radius });
}

test('each theme assigns distinct colors to numbers from 2 through 65536', () => {
  for (const theme of Object.values(themes)) {
    const colors = Array.from({ length: 16 }, (_, index) => dropColor(index + 1, theme));
    expect(dropColor(4, theme), theme.name).not.toBe(dropColor(10, theme));
    expect(new Set(colors).size, theme.name).toBe(colors.length);
  }
});

test('the four marked launch positions refill by sliding the preceding drops in from the left', async ({ page }) => {
  await useRoundSeed(page, 11);
  await observeLiquidBodies(page);
  await page.clock.install();
  await page.goto(gamePath);
  await startButton(page).click();
  const rack = page.getByRole('group', { name: '待发液滴' });
  const markers = rack.locator('.sb-rack-marker');
  await expect(rack.getByRole('button')).toHaveCount(4);
  await expect(markers).toHaveCount(4);
  const bounds = await canvas(page).boundingBox();
  if (!bounds) throw new Error('Expected the liquid2048 playfield');
  const checkMarkers = async (row: Awaited<ReturnType<typeof readRack>>) => {
    for (let slot = 0; slot < row.length; slot++) {
      const marker = await markers.nth(slot).boundingBox();
      if (!marker) throw new Error('Expected a mark for each launch position');
      expect(Math.abs(marker.x + marker.width / 2 - bounds.x - bounds.width * row[slot].targetX / 640)).toBeLessThan(2);
    }
  };
  const before = await readRack(page);
  expect(new Set(before.map(held => held.id)).size).toBe(4);
  expect(before.every(held => held.id > 0 && held.level > 0)).toBe(true);
  await checkMarkers(before);
  await canvas(page).press('4');
  await expect(slotButton(page, 4)).toHaveAttribute('aria-pressed', 'true');

  await slotButton(page, 3).click();
  const { x, y, height } = await canvasStart(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + height * 220 / 700, { steps: 5 });
  await page.mouse.up();
  await expect(shots(page)).toHaveText('1');

  const samples = [await readRack(page)];
  for (let frame = 0; frame < 30; frame++) {
    await page.clock.runFor(16);
    samples.push(await readRack(page));
  }
  const settled = samples.at(-1)!;
  const previousIds = before.map(held => held.id);
  expect(settled.slice(1).map(held => held.id)).toEqual([before[0].id, before[1].id, before[3].id]);
  expect(settled[0].id).toBeGreaterThan(0);
  expect(previousIds).not.toContain(settled[0].id);
  await checkMarkers(settled);
  for (const [initial, replacement] of [[before[0], settled[1]], [before[1], settled[2]]]) {
    expect(replacement.x).toBeGreaterThan(initial.x + 16);
    const path = samples.map(row => row.find(held => held.id === initial.id)?.x ?? NaN);
    expect(path.some(position => position > initial.x + 6 && position < replacement.x - 6)).toBe(true);
  }
  const arrived = samples.find(row => row[0].id === settled[0].id);
  expect(arrived?.[0].x).toBeLessThan(settled[0].x - 14);
  expect(Math.abs(settled[3].x - before[3].x)).toBeLessThan(3);
});

test('an impact visibly pushes down the receiving surface and it springs back over several frames', async ({ page }) => {
  await useRoundSeed(page, 11);
  const bodies = await observeLiquidBodies(page);
  const surface = await observePaintedSurface(page, dropColor(2, themes.soda));
  await page.clock.install();
  await page.goto(gamePath);
  await startButton(page).click();
  const { x, y, width, height } = await canvasStart(page);
  const pullY = 235;
  const fire = async (slot: number, pullX: number) => {
    await slotButton(page, slot).click();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + width * pullX / 640, y + height * pullY / 700, { steps: 5 });
    await page.mouse.up();
    await expect(shots(page)).toHaveText(String(slot));
  };
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await fire(1, 0);
  await page.clock.runFor(1800);
  const [receiver] = await bodies();
  expect(receiver.level).toBe(2);
  const rest = await surface(receiver.x, receiver.rx);
  expect(Number.isFinite(rest.center)).toBe(true);
  const { entry } = (await readRack(page))[1];
  const aimX = (receiver.x + 8 - entry.x) * pullY / (receiver.y - 28 - entry.y);
  await fire(2, aimX);

  const frames: { center: number; cup: number; ms: number }[] = [];
  for (let ms = 16; ms <= 752; ms += 16) {
    await page.clock.runFor(16);
    const [current] = await bodies();
    expect(current.id).toBe(receiver.id);
    frames.push({ ...await surface(current.x, current.rx), ms });
  }
  const peak = frames.filter(frame => Number.isFinite(frame.center) && Number.isFinite(frame.cup))
    .reduce((deepest, frame) => frame.center > deepest.center ? frame : deepest);
  expect(peak.center - rest.center).toBeGreaterThan(11);
  expect(peak.cup).toBeGreaterThan(3.5);
  const stillLoaded = frames.find(frame => frame.ms >= peak.ms + 80)!;
  const recovered = frames.find(frame => frame.ms >= peak.ms + 240)!;
  expect(stillLoaded.center - rest.center).toBeGreaterThan(6);
  expect(peak.center - recovered.center).toBeGreaterThan(9);
});

test.describe('desktop', () => {
  test.use({ reducedMotion: 'reduce' });

  test('standalone page loads liquid2048, and a real upward shot merges into a held drop', async ({ page }) => {
    await useRoundSeed(page, 1);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const wasm = page.waitForResponse(response => isWasmBinary(new URL(response.url())));
    await page.goto(gamePath);
    await expect(page).toHaveTitle('liquid2048 · 液滴合成');
    await expect(page.getByRole('heading', { name: 'liquid2048', exact: true })).toBeVisible();
    const response = await wasm;
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('application/wasm');
    await startButton(page).click();

    await expect(slotButton(page, 1)).toHaveAttribute('data-level', '2');
    await expect(slotButton(page, 2)).toHaveAttribute('data-level', '2');
    await slotButton(page, 1).click();
    const { x, y, width, height } = await canvasStart(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // A steep aim passes above the close-packed neighbor, then meets it on the rebound.
    await page.mouse.move(x + width * 22 / 640, y - height * 172 / 700, { steps: 5 });
    await page.mouse.up();
    await expect(shots(page)).toHaveText('1');
    await expect(page.getByTestId('merges')).toHaveText('1');
    await expect(page.getByTestId('score')).toHaveText('8');
    await expect(slotButton(page, 2)).toHaveAttribute('data-level', '3');
    await expect(page.getByText('预合成成功', { exact: true })).toHaveCount(0);
    await expect(page.getByText('已解锁 薄荷汽水', { exact: true })).toHaveCount(0);
    await openAchievements(page);
    await mintTheme(page).click();
    await expect(mintTheme(page)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '返回菜单', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '游戏暂停' }).getByRole('link', { name: '返回游戏大厅', exact: true }))
      .toHaveAttribute('href', 'https://game.grace-spring.top/');
    await page.reload();
    await expect(startButton(page)).toBeEnabled();
    const profile = await page.evaluate(() => JSON.parse(localStorage.getItem('sobosuba.profile.v1') ?? '{}'));
    expect(profile).toMatchObject({ best: '8', totalMerges: 1, achievements: ['first'], theme: 'mint' });
    expect(profile.rounds).toHaveLength(1);
    expect(profile.rounds[0]).toMatchObject({ score: '8', merges: 1, shots: 1, reason: 'aborted' });
    await openAchievements(page);
    await expect(mintTheme(page)).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('an angled launch can reach the far held drop across the middle position', async ({ page }) => {
    await useRoundSeed(page, 11);
    await page.goto(gamePath);
    await startButton(page).click();
    await expect(slotButton(page, 1)).toHaveAttribute('data-level', '2');
    await expect(slotButton(page, 2)).toHaveAttribute('data-level', '1');
    await expect(slotButton(page, 3)).toHaveAttribute('data-level', '2');
    await slotButton(page, 1).click();
    const { x, y, width, height } = await canvasStart(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + width * 69 / 640, y - height * 181 / 700, { steps: 6 });
    await page.mouse.up();
    await expect(shots(page)).toHaveText('1');
    await expect(slotButton(page, 2)).toHaveAttribute('data-level', '1');
    await expect(slotButton(page, 3)).toHaveAttribute('data-level', '3');
    await expect(page.getByTestId('score')).toHaveText('8');
    await expect(page.getByText('预合成成功', { exact: true })).toHaveCount(0);
  });

  test('a full pull fires much faster than a short pull in the same direction', async ({ page }) => {
    await useRoundSeed(page, 11);
    const bodies = await observeLiquidBodies(page);
    await page.clock.install();
    const travelAfterRelease = async (pullLength: number) => {
      await page.goto(gamePath);
      await startButton(page).click();
      await slotButton(page, 2).click();
      const { x, y, height } = await canvasStart(page);
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + height * pullLength / 700, { steps: 5 });
      await page.mouse.up();
      await expect(shots(page)).toHaveText('1');
      const [start] = await bodies();
      await page.clock.runFor(200);
      const [end] = await bodies();
      await page.clock.resume();
      return end.y - start.y;
    };

    const shortPull = await travelAfterRelease(31);
    const fullPull = await travelAfterRelease(235);
    expect(shortPull).toBeGreaterThan(30);
    expect(fullPull).toBeGreaterThan(240);
    expect(fullPull).toBeGreaterThan(shortPull * 3);
  });

  test('a downward graze moves and reshapes the held neighbour while continuing across the pool', async ({ page }) => {
    await useRoundSeed(page, 11);
    const bodies = await observeLiquidBodies(page);
    await page.clock.install();
    await page.goto(gamePath);
    await startButton(page).click();
    await slotButton(page, 1).click();
    const { x, y, width, height } = await canvasStart(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    const before = await observeRackHull(page, 1);
    expect(before).toHaveLength(RACK_HULL_STRIDE);

    const pullX = 142, pullY = 148;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + width * pullX / 640, y + height * pullY / 700, { steps: 6 });
    await page.mouse.up();
    await expect(shots(page)).toHaveText('1');
    const [start] = await bodies();
    let furthestShift = 0;
    let deepestDeformation = 0;
    for (let frame = 0; frame < 12; frame++) {
      await page.clock.runFor(16);
      const hull = await observeRackHull(page, 1);
      const shiftX = hull[0] - before[0], shiftY = hull[1] - before[1];
      furthestShift = Math.max(furthestShift, Math.hypot(shiftX, shiftY));
      for (let node = 5; node + 1 < hull.length; node += 2) {
        const dx = hull[node] - before[node] - shiftX;
        const dy = hull[node + 1] - before[node + 1] - shiftY;
        deepestDeformation = Math.max(deepestDeformation, Math.hypot(dx, dy));
      }
    }
    const [end] = await bodies();
    expect(furthestShift).toBeGreaterThan(1);
    expect(deepestDeformation).toBeGreaterThan(1);
    const travelX = end.x - start.x, travelY = end.y - start.y;
    expect(travelX).toBeGreaterThan(55);
    expect(travelY).toBeGreaterThan(90);
    expect(Math.abs(Math.atan2(travelY, travelX) - Math.atan2(pullY, pullX))).toBeLessThan(Math.PI / 9);
    await expect(slotButton(page, 2)).toHaveAttribute('data-level', '1');
  });

  test('clicking unlocks the rack and fast taps split a 4 into two independent 2s', async ({ page }) => {
    await useRoundSeed(page, 1);
    const bodies = await observeLiquidBodies(page);
    await page.clock.install();
    await page.goto(gamePath);
    await startButton(page).click();
    await canvas(page).press('Space');
    await expect(shots(page)).toHaveText('1');
    await expect.poll(async () => (await bodies()).some(body => body.level === 2 && !body.fragment && body.y > 637)).toBe(true);

    const box = await canvas(page).boundingBox();
    if (!box) throw new Error('Expected a visible liquid2048 playfield');
    const pointerAtDrop = async () => {
      const main = (await bodies()).find(body => !body.fragment);
      if (!main) throw new Error('Expected a numbered drop in play');
      return { x: box.x + box.width * main.x / 640, y: box.y + box.height * main.y / 700 };
    };
    const rack = page.getByRole('button', { name: /^待发 / });
    const locked = rack.and(page.locator('[aria-pressed="true"]'));
    await slotButton(page, 2).click();
    await expect(locked).toHaveCount(1);
    const landed = await pointerAtDrop();
    await page.mouse.move(landed.x, landed.y);
    await page.mouse.down();
    await expect(locked).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(shots(page)).toHaveText('1');

    const [original] = await bodies();
    const tap = async () => {
      const { x, y } = await pointerAtDrop();
      // Aim off-centre so pixel rounding cannot send the split straight up into its own return path.
      await page.mouse.click(x + box.width * 8 / 640, y);
    };
    await tap();
    const splashed = await bodies();
    expect(splashed.filter(body => body.fragment).length).toBeGreaterThan(1);
    await tap();
    await tap();
    const split = await bodies();
    const numbered = split.filter(body => !body.fragment);
    expect(numbered.map(body => body.level)).toEqual([1, 1]);
    expect(new Set(numbered.map(body => body.id)).size).toBe(2);
    expect(numbered.every(body => body.area / original.area > 0.3)).toBe(true);
    expect(split.reduce((total, body) => total + body.area, 0)).toBeCloseTo(original.area, 1);
    await expect(page.getByTestId('score')).toHaveText('0');

    const { x, y, width, height } = await canvasStart(page);
    const dragToAim = async (towardX = 0) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + width * towardX / 640, y + height * 106 / 700, { steps: 4 });
      await page.mouse.up();
    };
    await page.clock.runFor(2500);
    const settled = (await bodies()).filter(body => !body.fragment);
    expect(settled.map(({ id, level }) => ({ id, level })))
      .toEqual(numbered.map(({ id, level }) => ({ id, level })));
    expect(Math.abs(settled[0].x - settled[1].x)).toBeGreaterThan(100);
    await expect(page.getByTestId('score')).toHaveText('0');

    await expect(slotButton(page, 3)).toHaveAttribute('data-level', '1');
    await slotButton(page, 3).click();
    await dragToAim(10);
    await expect(shots(page)).toHaveText('2');
    await page.clock.runFor(1100);
    // The launched 2 contributes fresh points. The split half has already reached 4.
    await expect(page.getByTestId('score')).toHaveText('2');
    expect((await bodies()).filter(body => !body.fragment).map(body => body.level).sort()).toEqual([1, 2]);
  });

  test('throwing split halves back together restores their number without farming points', async ({ page }) => {
    await useRoundSeed(page, 1);
    const bodies = await observeLiquidBodies(page);
    const numbered = async () => (await bodies()).filter(body => !body.fragment);
    await page.clock.install();
    await page.goto(gamePath);
    await startButton(page).click();
    await canvas(page).press('Space');
    await expect.poll(async () => (await numbered()).some(body => body.level === 2 && body.y > 637)).toBe(true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 150));

    const box = await canvas(page).boundingBox();
    if (!box) throw new Error('Expected a visible liquid2048 playfield');
    const point = (x: number, y: number) => ({ x: box.x + box.width * x / 640, y: box.y + box.height * y / 700 });
    for (let tap = 0; tap < 3; tap++) {
      const [drop] = await numbered();
      const hit = point(drop.x + 8, drop.y);
      await page.mouse.click(hit.x, hit.y);
    }
    await page.clock.runFor(2500);
    const halves = (await numbered()).sort((left, right) => left.x - right.x);
    expect(halves.map(body => body.level)).toEqual([1, 1]);
    const [left, right] = halves;
    expect(right.x - left.x).toBeGreaterThan(100);
    const from = point(left.x, left.y);
    const to = point(left.x + 140, left.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.clock.runFor(1800);

    expect((await numbered()).map(body => body.level)).toEqual([2]);
    await expect(shots(page)).toHaveText('1');
    await expect(page.getByTestId('merges')).toHaveText('1');
    await expect(page.getByTestId('score')).toHaveText('0');
    await openAchievements(page);
    await expect(mintTheme(page)).toBeDisabled();
  });

  test('a later tap can splash again while older fragments are still in the pool', async ({ page }) => {
    await useRoundSeed(page, 11);
    const bodies = await observeLiquidBodies(page);
    await page.clock.install();
    await page.goto(gamePath);
    await startButton(page).click();
    await slotButton(page, 2).click();
    await canvas(page).press('Space');
    await expect.poll(async () => (await bodies()).some(body => !body.fragment && body.level === 1 && body.y > 637))
      .toBe(true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 150));

    const box = await canvas(page).boundingBox();
    if (!box) throw new Error('Expected a visible liquid2048 playfield');
    const [original] = await bodies();
    const tap = async () => {
      const drop = (await bodies()).find(body => body.id === original.id);
      if (!drop) throw new Error('Expected the original numbered drop in play');
      await page.mouse.click(box.x + box.width * (drop.x + 8) / 640, box.y + box.height * drop.y / 700);
    };

    await tap();
    await page.clock.runFor(600);
    const lingering = new Set((await bodies()).filter(body => body.fragment).map(body => body.id));
    expect(lingering.size).toBeGreaterThan(0);

    await tap();
    const renewed = await bodies();
    expect(renewed.some(body => body.fragment && !lingering.has(body.id))).toBe(true);
    expect(renewed.filter(body => !body.fragment).map(({ id, level }) => ({ id, level })))
      .toEqual([{ id: original.id, level: 1 }]);
    expect(renewed.reduce((total, body) => total + body.area, 0)).toBeCloseTo(original.area, 1);
    await expect(shots(page)).toHaveText('1');
    await expect(page.getByTestId('score')).toHaveText('0');
  });

  test('2 stays the minimum and a selected pool drop can be short-thrown without firing the rack', async ({ page }) => {
    await useRoundSeed(page, 11);
    const bodies = await observeLiquidBodies(page);
    const numbered = async () => (await bodies()).filter(body => !body.fragment);
    await page.clock.install();
    await page.goto(gamePath);
    await startButton(page).click();
    await expect(slotButton(page, 2)).toHaveAttribute('data-level', '1');
    await slotButton(page, 2).click();
    await canvas(page).press('Space');
    await expect.poll(async () => (await bodies()).some(body => body.level === 1 && !body.fragment && body.y > 637)).toBe(true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));

    const box = await canvas(page).boundingBox();
    if (!box) throw new Error('Expected a visible liquid2048 playfield');
    const point = (x: number, y: number) => ({ x: box.x + box.width * x / 640, y: box.y + box.height * y / 700 });
    const drag = async (fromX: number, fromY: number, dx: number, dy: number) => {
      const from = point(fromX, fromY);
      const to = point(fromX + dx, fromY + dy);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 6 });
      await page.mouse.up();
    };
    const [original] = await numbered();
    for (let tap = 0; tap < 3; tap++) {
      const main = (await numbered()).find(body => body.id === original.id);
      if (!main) throw new Error('Expected the original drop to still be in play');
      const hit = point(main.x + 8, main.y);
      await page.mouse.click(hit.x, hit.y);
    }
    await page.clock.runFor(20);

    const splashed = await bodies();
    expect(splashed.filter(body => !body.fragment).map(body => [body.id, body.level])).toEqual([[original.id, 1]]);
    expect(splashed.some(body => body.fragment)).toBe(true);
    expect(splashed.reduce((total, body) => total + body.area, 0)).toBeCloseTo(original.area, 1);

    const locked = page.getByRole('button', { name: /^待发 / }).and(page.locator('[aria-pressed="true"]'));
    await expect(locked).toHaveCount(0);
    const [before] = await numbered();
    await drag(315, 350, 80, -150);
    await page.clock.runFor(150);
    const [after] = await numbered();
    expect(after.id).toBe(original.id);
    expect(after.x).toBeGreaterThan(before.x + 15);
    expect(after.y).toBeLessThan(before.y - 24);
    await expect(shots(page)).toHaveText('1');

    await page.clock.runFor(1000);
    await slotButton(page, 1).click();
    await expect(locked).toHaveCount(1);
    const [resting] = await numbered();
    await drag(resting.x, resting.y, -65, -135);
    await page.clock.runFor(150);
    const [thrown] = await numbered();
    expect(thrown.id).toBe(original.id);
    expect(thrown.x).toBeLessThan(resting.x - 15);
    expect(thrown.y).toBeLessThan(resting.y - 24);
    await expect(locked).toHaveCount(0);
    await expect(shots(page)).toHaveText('1');
    await expect(page.getByTestId('score')).toHaveText('0');
  });

  test('direct and refreshed URLs load, and right click cancels pointer release', async ({ page }) => {
    await page.goto('/?test=direct');
    await expect(page).toHaveURL('/?test=direct');
    await expect(startButton(page)).toBeEnabled();
    await page.reload();
    await startButton(page).click();
    await slotButton(page, 1).click();
    await expect(shots(page)).toHaveText('0');

    const { x, y } = await canvasStart(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 100, { steps: 5 });
    await page.mouse.click(x, y + 100, { button: 'right' });
    await page.mouse.up();
    await expect(shots(page)).toHaveText('0');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 100, { steps: 5 });
    await page.mouse.up();
    await expect(shots(page)).toHaveText('1');
  });

  test('a failed WASM fetch can retry and start the game', async ({ page }) => {
    await page.route(isWasmBinary, route => route.abort());
    await page.goto(gamePath);
    await expect(page.getByRole('alert')).toHaveText('物理引擎加载失败。');
    await expect(startButton(page)).toBeHidden();
    await page.unroute(isWasmBinary);
    await page.getByRole('button', { name: '重试加载', exact: true }).click();
    await startButton(page).click();
    await expect(slotButton(page, 1)).toBeEnabled();
  });

  test('standard gamepad release launches once and two real drops merge on contact', async ({ page }) => {
    await useRoundSeed(page, 8);
    await page.goto(gamePath);
    await startButton(page).click();
    const buttons = async (pressed: number[] | null) => {
      await page.evaluate(async (active) => {
        Object.defineProperty(navigator, 'getGamepads', {
          configurable: true,
          value: () => active && [{
            id: 'Simulated standard gamepad', index: 0, connected: true,
            mapping: 'standard', axes: [0, 1, 0, 0],
            buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: active.includes(index) })),
          }],
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, pressed);
    };
    await buttons([]);
    await expect(page.getByText('手柄已连接')).toBeAttached();
    await buttons([0]);
    await buttons(null);
    await expect(page.getByText('手柄已连接')).not.toBeAttached();
    await buttons([]);
    await expect(shots(page)).toHaveText('0');

    await buttons([0]);
    await buttons([0, 1]);
    await buttons([]);
    await expect(shots(page)).toHaveText('0');

    await expect(slotButton(page, 1)).toHaveAttribute('data-level', '2');
    await buttons([0]);
    await expect(shots(page)).toHaveText('0');
    await buttons([]);
    await expect(shots(page)).toHaveText('1');

    await expect(slotButton(page, 1)).toHaveAttribute('data-level', '2');
    await expect.poll(async () => {
      await buttons([0]);
      await buttons([]);
      return Number(await shots(page).textContent());
    }).toBe(2);
    await expect(page.getByTestId('merges')).toHaveText('1');
    await expect(page.getByTestId('score')).toHaveText('8');
  });
});

test.describe('mobile', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 7'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, reducedMotion: 'reduce' });

  test('a touch cancellation preserves the pending ball and one drag fires exactly once', async ({ page }) => {
    await page.goto(gamePath);
    await startButton(page).tap();
    const board = await canvas(page).boundingBox();
    const slots = await Promise.all([1, 2, 3, 4].map(async index => {
      const slot = await slotButton(page, index).boundingBox();
      if (!slot) throw new Error('Expected all four liquid slots');
      return slot;
    }));
    if (!board) throw new Error('Expected the liquid2048 playfield');
    for (const slot of slots) {
      expect(slot.y).toBeGreaterThan(board.y);
      expect(slot.y + slot.height).toBeLessThan(board.y + board.height * 0.25);
    }
    for (let index = 1; index < slots.length; index++) {
      const left = slots[index - 1];
      const right = slots[index];
      expect(right.x - left.x - left.width).toBeGreaterThanOrEqual(-1);
      const centerDistance = (right.x + right.width / 2) - (left.x + left.width / 2);
      expect(centerDistance).toBeLessThan(72 * board.width / 640);
    }
    for (const index of [2, 3, 4]) {
      await slotButton(page, index).tap();
      await expect(slotButton(page, index)).toHaveAttribute('aria-pressed', 'true');
    }
    await slotButton(page, 1).tap();
    const { x, y } = await canvasStart(page);
    const touch = await page.context().newCDPSession(page);
    const drag = async (end: 'touchEnd' | 'touchCancel') => {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 78, id: 0 }] });
      await touch.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
    };
    await drag('touchCancel');
    await expect(shots(page)).toHaveText('0');
    await drag('touchEnd');
    await expect(shots(page)).toHaveText('1');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
});
