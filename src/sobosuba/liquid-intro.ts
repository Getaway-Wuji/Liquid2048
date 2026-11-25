// The inverse-distance field, click impulse and shape strain adapt React Bits Meta Balls,
// © 2026 David Haz. See public/licenses/REACT-BITS.txt.
import type { ArenaTheme } from './arena';
import { spawnVisualRandom } from './liquid-random';

const CENTER_X = 320;
const CENTER_Y = 326;
const RASTER_LEFT = 52;
const RASTER_TOP = 102;
const RASTER_SCALE = 1.25;
const RASTER_WIDTH = 429;
const RASTER_HEIGHT = 354;
const SUBSTEP = 1 / 180;
const FIELD_LIMIT = 4.4;
const FIELD_TAIL = 1 / FIELD_LIMIT ** 3;

const ANCHORS = [
  { x: -10, y: 9, radius: 47, orbit: 13, speed: 0.79, phase: 0.25 },
  { x: -65, y: -14, radius: 30, orbit: 26, speed: 0.96, phase: 1.7 },
  { x: 53, y: -31, radius: 28, orbit: 29, speed: 0.75, phase: 4.2 },
  { x: -24, y: -65, radius: 23, orbit: 20, speed: 0.61, phase: 3.4 },
  { x: 34, y: 51, radius: 24, orbit: 29, speed: 0.87, phase: 0.1 },
  { x: -77, y: 65, radius: 15, orbit: 23, speed: 1.04, phase: 3.9 },
  { x: 92, y: 38, radius: 13, orbit: 31, speed: 1.16, phase: 2.4 },
  { x: 88, y: -83, radius: 12, orbit: 19, speed: 1.03, phase: 5.1 },
  { x: -108, y: -49, radius: 11, orbit: 19, speed: 0.95, phase: 2.2 },
];

type Point = { x: number; y: number };
type Strain = { a: number; b: number; va: number; vb: number };
type Body = Strain & Point & { vx: number; vy: number; radius: number };
type Drop = Body & {
  anchor: typeof ANCHORS[number];
  burstRadius: number;
  burstCurl: number;
  fx: number;
  fy: number;
};
type Raster = { ctx: CanvasRenderingContext2D; field: Float32Array; pixels: ImageData };

interface Intro {
  bodies: Drop[];
  cursor: Body;
  pointer: Point | null;
  time: number;
  sinceBurst: number;
  reduced: boolean;
  raster: Raster;
}

const states = new WeakMap<CanvasRenderingContext2D, Intro>();

function newBody(x: number, y: number, radius: number): Body {
  return { x, y, radius, vx: 0, vy: 0, a: 0, b: 0, va: 0, vb: 0 };
}

function makeIntro(time: number, reduced: boolean): Intro | null {
  const canvas = document.createElement('canvas');
  canvas.width = RASTER_WIDTH;
  canvas.height = RASTER_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return {
    bodies: ANCHORS.map(anchor => ({
      ...newBody(CENTER_X + anchor.x, CENTER_Y + anchor.y, anchor.radius),
      anchor,
      burstRadius: anchor.radius,
      burstCurl: 0,
      fx: 0,
      fy: 0,
    })),
    cursor: newBody(CENTER_X, CENTER_Y, 0),
    pointer: null,
    time,
    sinceBurst: Infinity,
    reduced,
    raster: {
      ctx,
      field: new Float32Array(RASTER_WIDTH * RASTER_HEIGHT),
      pixels: ctx.createImageData(RASTER_WIDTH, RASTER_HEIGHT),
    },
  };
}

function deform(body: Body, dt: number) {
  const speedSquared = body.vx ** 2 + body.vy ** 2;
  let targetA = 0;
  let targetB = 0;
  if (speedSquared > 0.01) {
    const strength = 0.45 * Math.tanh(Math.sqrt(speedSquared) / 260) / speedSquared;
    targetA = strength * (body.vx ** 2 - body.vy ** 2);
    targetB = strength * 2 * body.vx * body.vy;
  }
  body.va += ((targetA - body.a) * 169 - body.va * 14) * dt;
  body.vb += ((targetB - body.b) * 169 - body.vb * 14) * dt;
  body.a += body.va * dt;
  body.b += body.vb * dt;
}

// The outer band attracts nearby field sources. The inner band pushes them apart
// to retain thickness and keep neighboring droplets from sharing one center.
function tension(distance: number, radiusSum: number, weight: number) {
  const core = radiusSum * 0.58;
  if (distance < core) return -27 * (core - distance);
  const t = (distance - core) / (radiusSum * 1.43 - core);
  return t < 1 ? 45 * weight * t * (1 - t) ** 2 : 0;
}

function simulate(intro: Intro, dt: number, time: number) {
  const { bodies, cursor, pointer } = intro;
  const followsPointer = pointer && Math.hypot(pointer.x - CENTER_X, pointer.y - CENTER_Y) < 224;
  if (followsPointer && pointer) {
    const fraction = 1 - Math.exp(-dt * 16);
    cursor.vx = (pointer.x - cursor.x) * fraction / dt;
    cursor.vy = (pointer.y - cursor.y) * fraction / dt;
    cursor.x += cursor.vx * dt;
    cursor.y += cursor.vy * dt;
  }
  const cursorSize = followsPointer ? 29 * Math.min(1, 0.38 + intro.sinceBurst / 0.55) : 0;
  cursor.radius += (cursorSize - cursor.radius) * (1 - Math.exp(-dt * 12));
  deform(cursor, dt);

  const radiusBlend = Math.max(0, Math.min(1, (0.88 - intro.sinceBurst) / 0.62));
  const radiusFollow = 1 - Math.exp(-dt * 17);
  const curlBlend = Math.max(0, 1 - intro.sinceBurst / 0.42);
  for (const drop of bodies) {
    const radius = drop.anchor.radius + radiusBlend * (drop.burstRadius - drop.anchor.radius);
    const curl = curlBlend * drop.burstCurl;
    drop.radius += (radius - drop.radius) * radiusFollow;
    const angle = time * drop.anchor.speed + drop.anchor.phase;
    const targetX = CENTER_X + drop.anchor.x + Math.sin(angle) * drop.anchor.orbit;
    const targetY = CENTER_Y + drop.anchor.y + Math.cos(angle * 1.27) * drop.anchor.orbit * 0.81;
    drop.fx = 18 * (targetX - drop.x) - 4.9 * drop.vx - curl * drop.vy;
    drop.fy = 18 * (targetY - drop.y) - 4.9 * drop.vy + curl * drop.vx;
    if (cursor.radius > 0.25) {
      const dx = cursor.x - drop.x;
      const dy = cursor.y - drop.y;
      const distance = Math.hypot(dx, dy) || 0.0001;
      const force = tension(distance, drop.radius + cursor.radius, Math.min(drop.radius, cursor.radius));
      drop.fx += dx * force / distance;
      drop.fy += dy * force / distance;
    }
  }
  for (let i = 0; i < bodies.length; i++) {
    const left = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const right = bodies[j];
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const distance = Math.hypot(dx, dy) || 0.0001;
      const force = tension(distance, left.radius + right.radius, Math.min(left.radius, right.radius));
      const fx = dx * force / distance;
      const fy = dy * force / distance;
      const massLeft = 0.7 + (left.radius / 28) ** 2;
      const massRight = 0.7 + (right.radius / 28) ** 2;
      left.fx += fx / massLeft;
      left.fy += fy / massLeft;
      right.fx -= fx / massRight;
      right.fy -= fy / massRight;
    }
  }
  for (const drop of bodies) {
    drop.vx += drop.fx * dt;
    drop.vy += drop.fy * dt;
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;
    deform(drop, dt);
  }
  intro.sinceBurst += dt;
}

function addField(field: Float32Array, source: Body) {
  const magnitude = Math.hypot(source.a, source.b);
  const c = Math.cosh(magnitude);
  const k = magnitude > 0.0001 ? Math.sinh(magnitude) / magnitude : 1;
  const xx = c - k * source.a;
  const xy = -k * source.b;
  const yy = c + k * source.a;
  const x = (source.x - RASTER_LEFT) / RASTER_SCALE;
  const y = (source.y - RASTER_TOP) / RASTER_SCALE;
  const radius = source.radius / RASTER_SCALE;
  const radiusSquared = radius ** 2;
  const reach = radius * FIELD_LIMIT * Math.exp(magnitude);
  const minX = Math.max(0, Math.floor(x - reach));
  const maxX = Math.min(RASTER_WIDTH - 1, Math.ceil(x + reach));
  const minY = Math.max(0, Math.floor(y - reach));
  const maxY = Math.min(RASTER_HEIGHT - 1, Math.ceil(y + reach));
  for (let row = minY; row <= maxY; row++) {
    const dy = row + 0.5 - y;
    let qx = xx * (minX + 0.5 - x) + xy * dy;
    let qy = xy * (minX + 0.5 - x) + yy * dy;
    for (let index = row * RASTER_WIDTH + minX; index <= row * RASTER_WIDTH + maxX; index++) {
      const squared = qx * qx + qy * qy;
      const weight = radiusSquared / Math.max(radiusSquared * 0.001, squared);
      const contribution = weight * Math.sqrt(weight) - FIELD_TAIL;
      if (contribution > 0) field[index] += contribution;
      qx += xx;
      qy += xy;
    }
  }
}

function paintField(ctx: CanvasRenderingContext2D, intro: Intro, color: string) {
  const { raster, bodies, cursor } = intro;
  const { field, pixels } = raster;
  field.fill(0);
  for (const drop of bodies) addField(field, drop);
  if (cursor.radius > 1) addField(field, cursor);

  const rgb = Number.parseInt(color.slice(1), 16);
  const red = (rgb >> 16) & 255;
  const green = (rgb >> 8) & 255;
  const blue = rgb & 255;
  const data = pixels.data;
  for (let i = 0; i < field.length; i++) {
    const value = field[i];
    const offset = i * 4;
    if (value < 0.58) {
      data[offset + 3] = 0;
      continue;
    }
    let alpha = 1;
    if (value < 1.55) {
      const dx = ((field[i + 1] ?? value) - (field[i - 1] ?? value)) * 0.5;
      const dy = ((field[i + RASTER_WIDTH] ?? value) - (field[i - RASTER_WIDTH] ?? value)) * 0.5;
      const slope = Math.sqrt(dx * dx + dy * dy);
      alpha = 0.5 + (value - 1) / Math.max(slope, 0.027);
    }
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = alpha * 255;
  }
  raster.ctx.putImageData(pixels, 0, 0);
  ctx.drawImage(
    raster.ctx.canvas,
    RASTER_LEFT,
    RASTER_TOP,
    RASTER_WIDTH * RASTER_SCALE,
    RASTER_HEIGHT * RASTER_SCALE,
  );
}

export function paintLiquidIntro(
  ctx: CanvasRenderingContext2D,
  theme: ArenaTheme,
  time: number,
  reducedMotion: boolean,
) {
  let intro = states.get(ctx);
  if (!intro || time < intro.time || reducedMotion !== intro.reduced) {
    intro = makeIntro(time, reducedMotion) ?? undefined;
    if (!intro) return;
    states.set(ctx, intro);
  }
  if (!reducedMotion && time > intro.time) {
    const period = Math.min(0.045, (time - intro.time) / 1000);
    const count = Math.ceil(period / SUBSTEP);
    const step = period / count;
    for (let i = 0; i < count; i++) simulate(intro, step, time / 1000 - period + (i + 1) * step);
    intro.time = time;
  }
  paintField(ctx, intro, theme.accent);
}

export function burstLiquidIntro(
  ctx: CanvasRenderingContext2D | null,
  x: number,
  y: number,
  reducedMotion: boolean,
) {
  const intro = ctx && states.get(ctx);
  if (!intro || reducedMotion || intro.reduced || intro.sinceBurst < 0.12) return false;
  const near = intro.bodies.some(drop => Math.hypot(drop.x - x, drop.y - y) <= drop.radius + 21);
  if (!near) return false;

  const random = spawnVisualRandom();
  const heading = random() * Math.PI * 2;
  const rotation = (random() - 0.5) * 1.08;
  const impulse = 700 + random() * 170;
  const fullKicks = 4 + Math.floor(random() * 6);
  const ranked = intro.bodies.map(drop => ({ drop, rank: random() })).sort((a, b) => a.rank - b.rank);
  let area = 0;
  let restArea = 0;
  for (const drop of intro.bodies) {
    const radius = drop.anchor.radius;
    drop.burstCurl = 0;
    drop.burstRadius = radius * (0.66 + random() * 0.72);
    area += drop.burstRadius ** 2;
    restArea += radius ** 2;
  }
  const areaScale = Math.sqrt(restArea / area);
  for (const drop of intro.bodies) drop.burstRadius *= areaScale;

  for (const [index, { drop }] of ranked.entries()) {
    const dx = drop.x - x;
    const dy = drop.y - y;
    const distance = Math.hypot(dx, dy);
    if (distance > 230) continue;
    const angle = distance > 0.25 ? Math.atan2(dy, dx) : heading;
    const twist = angle + rotation + (random() - 0.5) * 0.7;
    const fan = 0.88 + 0.32 * Math.cos(angle - heading) + random() * 0.33;
    const kickWeight = index < fullKicks ? 1 : 0.26 + random() * 0.24;
    const kick = impulse * fan * kickWeight * (1 - distance / 255) ** 0.62 / (0.76 + drop.radius / 102);
    drop.burstCurl = (random() - 0.5) * 6.6;
    drop.vx += Math.cos(twist) * kick;
    drop.vy += Math.sin(twist) * kick;
    const speed = Math.hypot(drop.vx, drop.vy);
    if (speed > 900) {
      drop.vx *= 900 / speed;
      drop.vy *= 900 / speed;
    }
  }
  intro.sinceBurst = 0;
  return true;
}

export function trackLiquidIntro(ctx: CanvasRenderingContext2D | null, x: number, y: number) {
  const intro = ctx && states.get(ctx);
  if (!intro || intro.reduced) return;
  if (!intro.pointer && intro.cursor.radius < 1) {
    intro.cursor.x = x;
    intro.cursor.y = y;
  }
  intro.pointer = { x, y };
}

export function clearLiquidIntroPointer(ctx: CanvasRenderingContext2D | null) {
  const intro = ctx && states.get(ctx);
  if (intro) intro.pointer = null;
}

export function clearLiquidIntro(ctx: CanvasRenderingContext2D | null) {
  if (ctx) states.delete(ctx);
}
