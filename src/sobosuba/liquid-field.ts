import type { LiquidFlow } from './liquid-flow';

const SAMPLES = 48;
const directions = Array.from({ length: SAMPLES }, (_, index) => {
  const angle = index * 2 * Math.PI / SAMPLES;
  return [Math.cos(angle), Math.sin(angle)] as const;
});

interface PuddleFieldOptions {
  seed: number;
  phase: number;
  flowX?: number;
  flowY?: number;
  flow?: LiquidFlow;
  fusion?: { dx: number; dy: number; mix: number };
}

const interpolate = (from: number, to: number, amount: number) => from + (to - from) * amount;

// Each source contributes a power of radius² / distance², like the React Bits solid field.
// Finding the threshold by bisection along rays keeps the animated edges
// sharp at any canvas scale and avoids a full-screen raster for each puddle.
export function tracePuddleField({ seed, phase, flowX = 0, flowY = 0, flow, fusion }: PuddleFieldOptions) {
  const pulse = phase + seed * 1.618;
  const sway = Math.sin(pulse * 0.77);
  const wobble = Math.cos(pulse * 1.24);
  const dx = fusion?.dx ?? 0;
  const dy = fusion?.dy ?? 0;
  const mix = fusion?.mix ?? 0;
  const fieldSources = flow && !fusion ? flow.sources : null;
  const sources = fieldSources ? null : [
    interpolate(-0.08 + sway * 0.08, 0, mix), interpolate(0.05, 0, mix), interpolate(0.53, 0.16, mix) ** 2,
    interpolate(-0.64 + wobble * 0.12 - flowX * 0.38, -dx, mix),
    interpolate(0.15 + sway * 0.18 - flowY * 0.38, -dy, mix), interpolate(0.44, 0.60, mix) ** 2,
    interpolate(0.62 + sway * 0.12, dx, mix),
    interpolate(-0.07 + wobble * 0.20, dy, mix), interpolate(0.45, 0.60, mix) ** 2,
    interpolate(-0.19 + wobble * 0.28, -dx * 0.44, mix),
    interpolate(-0.47 - sway * 0.12, -dy * 0.44 - 0.15, mix), interpolate(0.34, 0.16, mix) ** 2,
    interpolate(0.31 + Math.sin(pulse + 1.6) * 0.20, dx * 0.50, mix),
    interpolate(0.41 + wobble * 0.14, dy * 0.50 + 0.12, mix), interpolate(0.31, 0.17, mix) ** 2,
  ];

  const coordinates = new Float32Array(SAMPLES * 2);
  for (let i = 0; i < SAMPLES; i++) {
    const [cos, sin] = directions[i];
    let near = 0;
    let far = 2.2;
    for (let iteration = 0; iteration < 10; iteration++) {
      const middle = (near + far) * 0.5;
      const x = cos * middle;
      const y = sin * middle;
      let field = 0;
      if (fieldSources) {
        // The Meta Balls solid shader with its standard gooeyness: sum r² / dot(q,q),
        // where q is the offset transformed by the source's symmetric strain tensor.
        for (const source of fieldSources) {
          const dx = x - source.x;
          const dy = y - source.y;
          const qx = source.xx * dx + source.xy * dy;
          const qy = source.xy * dx + source.yy * dy;
          field += source.radiusSquared / Math.max(qx * qx + qy * qy, source.radiusSquared * 0.0001 + 1e-12);
        }
      } else if (sources) {
        for (let source = 0; source < sources.length; source += 3) {
          const u = x - sources[source];
          const v = y - sources[source + 1];
          const weight = sources[source + 2] / (u * u + v * v + 0.001);
          field += weight * Math.sqrt(weight);
        }
      }
      if (field >= (fieldSources ? 1.3 : 1)) near = middle;
      else far = middle;
    }
    coordinates[i * 2] = cos * near;
    coordinates[i * 2 + 1] = sin * near;
  }
  return coordinates;
}

export function smoothPuddlePath(
  coordinates: Float32Array,
  move: (x: number, y: number) => void,
  curve: (x: number, y: number, endX: number, endY: number) => void,
) {
  const count = coordinates.length;
  move((coordinates[0] + coordinates[count - 2]) / 2, (coordinates[1] + coordinates[count - 1]) / 2);
  for (let index = 0; index < count; index += 2) {
    const next = (index + 2) % count;
    const x = coordinates[index];
    const y = coordinates[index + 1];
    curve(x, y, (x + coordinates[next]) / 2, (y + coordinates[next + 1]) / 2);
  }
}


