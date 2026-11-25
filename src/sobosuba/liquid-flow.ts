// The source springs and double-angle strain adapt React Bits Meta Balls,
// © 2026 David Haz. See public/licenses/REACT-BITS.txt.

const anchors = [
  { x: 0, y: 0.04, radius: 0.57 },
  { x: -0.59, y: 0.06, radius: 0.44 },
  { x: 0.57, y: -0.06, radius: 0.48 },
  { x: -0.15, y: -0.49, radius: 0.36 },
  { x: 0.21, y: 0.47, radius: 0.34 },
];

interface LiquidSource {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  radiusSquared: number;
  a: number;
  b: number;
  va: number;
  vb: number;
  xx: number;
  xy: number;
  yy: number;
}

export interface LiquidFlow {
  sources: LiquidSource[];
  lastVx: number;
  lastVy: number;
}

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
const smoothstep = (low: number, high: number, value: number) => {
  const u = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return u * u * (3 - 2 * u);
};

function positionSpring(source: LiquidSource, index: number, phase: number, vx: number, vy: number) {
  const anchor = anchors[index];
  const rate = 0.76 + index * 0.17;
  const t = phase * rate + index * 2.4;
  const motion = index === 0 ? 0.07 : 0.18;
  const lag = index === 0 ? 0.025 : 0.08 + index * 0.018;
  const x = anchor.x + Math.cos(t) * motion - Math.tanh(vx / 360) * lag;
  const y = anchor.y + Math.sin(t * 1.14) * motion - Math.tanh(vy / 360) * lag;
  const anchorVx = -Math.sin(t) * motion * rate * 2;
  const anchorVy = Math.cos(t * 1.14) * motion * rate * 2.28;
  source.fx = 44 * (x - source.x) - 6.4 * (source.vx - anchorVx);
  source.fy = 44 * (y - source.y) - 6.4 * (source.vy - anchorVy);
}

function pullSources(sources: LiquidSource[]) {
  for (let i = 0; i < sources.length; i++) {
    const first = sources[i];
    for (let j = i + 1; j < sources.length; j++) {
      const second = sources[j];
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const distance = Math.hypot(dx, dy);
      const radii = anchors[i].radius + anchors[j].radius;
      const near = radii * 0.52;
      const far = radii * Math.SQRT2;
      if (distance < 0.001 || distance >= far) continue;
      const strength = distance < near
        ? -14 * (near - distance)
        : 2.2 * smoothstep(near, far * 0.78, distance) * (1 - smoothstep(far * 0.82, far, distance));
      const fx = dx * strength / distance;
      const fy = dy * strength / distance;
      first.fx += fx;
      first.fy += fy;
      second.fx -= fx;
      second.fy -= fy;
    }
  }
}

function sourceStrain(source: LiquidSource, vx: number, vy: number, step: number) {
  const sx = source.vx + vx / 175;
  const sy = source.vy + vy / 175;
  const speed = Math.hypot(sx, sy);
  const amplitude = 0.55 * Math.tanh(speed / 4);
  const weight = speed > 1e-4 ? amplitude / (speed * speed) : 0;
  const targetA = (sx * sx - sy * sy) * weight;
  const targetB = 2 * sx * sy * weight;
  const omega = 13;
  const damping = 2 * 0.45 * omega;
  source.va += (omega * omega * (targetA - source.a) - damping * source.va) * step;
  source.vb += (omega * omega * (targetB - source.b) - damping * source.vb) * step;
  source.a += source.va * step;
  source.b += source.vb * step;
}

export function advanceLiquidFlow(
  previous: LiquidFlow | undefined,
  dt: number,
  phase: number,
  vx: number,
  vy: number,
): LiquidFlow {
  const flow = previous ?? {
    lastVx: vx,
    lastVy: vy,
    sources: anchors.map(({ x, y, radius }) => ({
      x, y, radiusSquared: radius * radius,
      vx: 0, vy: 0, fx: 0, fy: 0, a: 0, b: 0, va: 0, vb: 0, xx: 1, xy: 0, yy: 1,
    })),
  };
  const elapsed = Math.max(0, Math.min(dt, 0.05));
  if (!elapsed) return flow;
  const impulseX = clamp((flow.lastVx - vx) / 170, 2.4);
  const impulseY = clamp((flow.lastVy - vy) / 170, 2.4);
  flow.lastVx = vx;
  flow.lastVy = vy;
  for (const [index, source] of flow.sources.entries()) {
    // Peripheral liquid keeps advancing as the object's center loses speed.
    const inertia = index === 0 ? 0.20 : 0.53 + index * 0.10;
    source.vx += inertia * impulseX;
    source.vy += inertia * impulseY;
  }
  const steps = Math.ceil(elapsed * 120);
  const step = elapsed / steps;
  for (let frame = 0; frame < steps; frame++) {
    flow.sources.forEach((source, index) => positionSpring(source, index, phase, vx, vy));
    pullSources(flow.sources);
    for (const source of flow.sources) {
      source.vx += source.fx * step;
      source.vy += source.fy * step;
      source.x += source.vx * step;
      source.y += source.vy * step;
      sourceStrain(source, vx, vy, step);
    }
  }
  for (const source of flow.sources) {
    const magnitude = Math.hypot(source.a, source.b);
    const cosh = Math.cosh(magnitude);
    const sinhOverMagnitude = magnitude > 1e-6 ? Math.sinh(magnitude) / magnitude : 1;
    source.xx = cosh - sinhOverMagnitude * source.a;
    source.xy = -sinhOverMagnitude * source.b;
    source.yy = cosh + sinhOverMagnitude * source.a;
  }
  return flow;
}
