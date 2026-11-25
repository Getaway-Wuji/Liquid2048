interface Plane {
  nx: number;
  ny: number;
  tangent: number;
  grip: number;
  cradle?: { center: number; width: number; depth: number };
}

interface SurfaceImpact {
  nx: number;
  ny: number;
  depth: number;
  width: number;
}

export interface LiquidSurface {
  x: number;
  y: number;
  radius: number;
  fragment: boolean;
  hull: Float32Array;
  planes: Plane[];
  impact?: SurfaceImpact;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const clamp = (value: number, lower = 0, upper = 1) => Math.max(lower, Math.min(upper, value));

// Keep the apparent amount of liquid stable when its sources spread or overlap.
function fieldAreaScale(points: Float32Array) {
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    area += points[i] ** 2 + points[i + 1] ** 2;
  }
  return Math.sqrt(2 * area / points.length) || 1;
}

export function measureSurface(
  x: number, y: number, radius: number, hull: Float32Array, fragment = false, impact?: SurfaceImpact,
): LiquidSurface {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (let i = 0; i < hull.length; i += 2) {
    left = Math.min(left, hull[i]);
    right = Math.max(right, hull[i]);
    top = Math.min(top, hull[i + 1]);
    bottom = Math.max(bottom, hull[i + 1]);
  }
  return { x, y, radius, fragment, hull, planes: [], impact, left, right, top, bottom };
}

function faceBetween(a: LiquidSurface, b: LiquidSurface, reach: number, wetReach: number, cupSmallDrop: boolean) {
  let bestGap = -Infinity;
  let nx = 0, ny = 0, tangent = 0;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const hull of [a.hull, b.hull]) {
    for (let i = 0; i < hull.length; i += 2) {
      const next = (i + 2) % hull.length;
      const ex = hull[next] - hull[i], ey = hull[next + 1] - hull[i + 1];
      const length = Math.hypot(ex, ey);
      if (length < 0.001) continue;
      const sign = (dx * ey - dy * ex) < 0 ? -1 : 1;
      const ax = sign * ey / length, ay = -sign * ex / length;
      let near = -Infinity, far = Infinity;
      for (let j = 0; j < a.hull.length; j += 2) {
        near = Math.max(near, a.hull[j] * ax + a.hull[j + 1] * ay);
      }
      for (let j = 0; j < b.hull.length; j += 2) {
        far = Math.min(far, b.hull[j] * ax + b.hull[j + 1] * ay);
      }
      const gap = far - near;
      if (gap > reach) return;
      if (gap > bestGap) {
        bestGap = gap;
        nx = ax;
        ny = ay;
        tangent = (near + far) * 0.5;
      }
    }
  }
  const grip = clamp(1 - bestGap / wetReach);
  const small = a.radius < b.radius ? a : b;
  const large = small === a ? b : a;
  const mismatch = Math.abs(a.radius - b.radius) / Math.max(a.radius, b.radius);
  const impact = large.impact;
  const facing = large === a ? 1 : -1;
  const matchingImpact = impact ? Math.max(0, facing * (impact.nx * nx + impact.ny * ny)) * impact.depth : 0;
  const depth = cupSmallDrop && !a.fragment && !b.fragment
    ? (Math.min(small.radius * 0.90, 34) * clamp((mismatch - 0.04) / 0.46)
      + clamp(matchingImpact, 0, small.radius * 0.52)) * grip ** 2
    : 0;
  if (depth > 0.05) {
    // Polygon edge normals can change discretely during a slide. Around a
    // smaller drop, orient the curved part of the contact along the centers.
    const distance = Math.hypot(dx, dy) || 1;
    const blend = 0.72 * clamp(depth / (small.radius * 0.35));
    nx = nx * (1 - blend) + dx / distance * blend;
    ny = ny * (1 - blend) + dy / distance * blend;
    const length = Math.hypot(nx, ny);
    nx /= length;
    ny /= length;
    let near = -Infinity, far = Infinity;
    for (let i = 0; i < a.hull.length; i += 2) {
      near = Math.max(near, a.hull[i] * nx + a.hull[i + 1] * ny);
      far = Math.min(far, b.hull[i] * nx + b.hull[i + 1] * ny);
    }
    tangent = (near + far) * 0.5;
  }
  // Both surfaces use the same curved seam. The smaller drop fits the
  // depression on the larger one, with room for shoulders to rise beside it.
  a.planes.push({
    nx, ny, tangent: tangent - a.x * nx - a.y * ny - 0.14, grip,
    cradle: depth > 0.05 ? {
      center: (small.y - a.y) * nx - (small.x - a.x) * ny,
      width: small.radius * 0.86, depth: small === a ? -depth : depth,
    } : undefined,
  });
  b.planes.push({
    nx: -nx, ny: -ny, tangent: b.x * nx + b.y * ny - tangent - 0.14, grip,
    cradle: depth > 0.05 ? {
      center: (small.x - b.x) * ny - (small.y - b.y) * nx,
      width: small.radius * 0.86, depth: small === b ? -depth : depth,
    } : undefined,
  });
}

function fitContact(a: LiquidSurface, b: LiquidSurface, cupSmallDrop = false) {
  const wetReach = clamp(Math.min(a.radius, b.radius) * 0.20, 4, 12);
  // Bound lobes early around small splash fragments so a neighboring large
  // drop cannot draw over them before their physical hulls actually touch.
  const reach = a.fragment || b.fragment ? clamp((a.radius + b.radius) * 0.5, wetReach, 64) : wetReach;
  if (b.left - a.right > reach || a.left - b.right > reach ||
      b.top - a.bottom > reach || a.top - b.bottom > reach) return;
  faceBetween(a, b, reach, wetReach, cupSmallDrop);
}

export function fitWetContacts(
  surfaces: LiquidSurface[],
  rack: (LiquidSurface | null)[],
  left: number,
  right: number,
  ceiling: number,
  floor: number,
) {
  const WALL_REACH = 9;
  for (let i = 0; i < surfaces.length; i++) {
    const a = surfaces[i];
    if (a.left - left < WALL_REACH) {
      a.planes.push({ nx: -1, ny: 0, tangent: a.x - left, grip: clamp(1 - (a.left - left) / WALL_REACH) });
    }
    if (right - a.right < WALL_REACH) {
      a.planes.push({ nx: 1, ny: 0, tangent: right - a.x, grip: clamp(1 - (right - a.right) / WALL_REACH) });
    }
    if (a.top - ceiling < WALL_REACH) {
      a.planes.push({ nx: 0, ny: -1, tangent: a.y - ceiling, grip: clamp(1 - (a.top - ceiling) / WALL_REACH) });
    }
    if (floor - a.bottom < WALL_REACH) {
      a.planes.push({ nx: 0, ny: 1, tangent: floor - a.y, grip: clamp(1 - (floor - a.bottom) / WALL_REACH) });
    }
    for (let j = i + 1; j < surfaces.length; j++) fitContact(a, surfaces[j], true);
    for (const held of rack) if (held) fitContact(a, held);
  }
  for (let i = 0; i < rack.length; i++) {
    const a = rack[i];
    if (!a) continue;
    for (const b of rack.slice(i + 1)) if (b) fitContact(a, b);
  }
}

function contactBoundary(plane: Plane, normal: number, lateral: number) {
  const flat = plane.tangent / normal;
  const cradle = plane.cradle;
  if (!cradle) return flat;
  const reach = Math.abs(cradle.depth) / normal;
  let inside = flat - reach, outside = flat + reach;
  for (let step = 0; step < 7; step++) {
    const edge = (inside + outside) * 0.5;
    const across = (lateral * edge - cradle.center) / cradle.width;
    const shoulder = Math.min(across ** 2, 1);
    const offset = cradle.depth * (shoulder * (2 - shoulder) - 0.40);
    if (edge * normal < plane.tangent + offset) inside = edge;
    else outside = edge;
  }
  return inside;
}

function impactDisplacement(impact: SurfaceImpact, dx: number, dy: number, boundary: number) {
  const length = Math.hypot(dx, dy);
  const facing = clamp(((dx * impact.nx + dy * impact.ny) / length - 0.12) / 0.76);
  const across = ((dy * impact.nx - dx * impact.ny) * boundary / impact.width) ** 2;
  if (!facing || across >= 1) return 0;
  // This profile has zero integral across the contact: material that sinks
  // in the middle forms the two raised shoulders.
  const profile = (1 - across) ** 2 * (1 - 7 * across);
  return clamp(-impact.depth * profile * facing / length, -0.38, 0.38);
}

/** Wrap the soft field contour around the actual non-affine contact hull. */
export function fitLiquidSurface(
  points: Float32Array,
  surface: LiquidSurface,
  xx: number,
  xy: number,
  yy: number,
  fusion: number,
  packed?: { left: number; right: number },
) {
  const { x, y, hull, planes, radius, fragment, impact } = surface;
  const count = hull.length / 2;
  const det = xx * yy - xy * xy;
  const radial = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const wx = hull[i * 2] - x, wy = hull[i * 2 + 1] - y;
    radial[i] = Math.hypot(yy * wx - xy * wy, xx * wy - xy * wx) / det;
  }
  const areaScale = fieldAreaScale(points);
  for (let i = 0; i < points.length; i += 2) {
    const magnitude = Math.hypot(points[i], points[i + 1]) || 1;
    const lx = points[i] / magnitude, ly = points[i + 1] / magnitude;
    const dx = xx * lx + xy * ly, dy = xy * lx + yy * ly;
    const step = i * count / points.length;
    const node = Math.floor(step), next = (node + 1) % count, t = step - node;
    const hx = hull[next * 2] - hull[node * 2], hy = hull[next * 2 + 1] - hull[node * 2 + 1];
    const cross = dx * hy - dy * hx;
    const r0 = radial[node], r1 = radial[next];
    const m0 = (r1 - radial[(node + count - 1) % count]) * 0.5;
    const m1 = (radial[(next + 1) % count] - r0) * 0.5;
    const blend = t * t * (3 - 2 * t);
    const rounded = r0 + (r1 - r0) * blend + (m0 * (1 - t) - m1 * t) * t * (1 - t);
    const exact = Math.abs(cross) > 0.001
      ? ((hull[node * 2] - x) * hy - (hull[node * 2 + 1] - y) * hx) / cross
      : rounded;
    const free = clamp(rounded, exact - 0.045, exact + 0.065);
    const againstRackNeighbor = packed && Number.isFinite(lx < 0 ? packed.left : packed.right);
    const squeeze = againstRackNeighbor ? clamp((Math.abs(lx) - 0.64) / 0.36) : 0;
    const amplitude = packed ? 1.2 - squeeze * 1.19 : fragment ? 0.82 : 1.5;
    const rippleLimit = fragment ? 0.24 : 0.42;
    const ripple = clamp((magnitude / areaScale - 1) * (amplitude + fusion * 0.15), -rippleLimit, rippleLimit);
    let wet = 0, gripBound = Infinity, blendWidth = 0;
    for (const plane of planes) {
      const normal = dx * plane.nx + dy * plane.ny;
      if (normal < radius * 0.28) continue;
      const face = contactBoundary(plane, normal, dy * plane.nx - dx * plane.ny);
      // Measure wetting from the original support face so the newly lifted
      // shoulders stay coupled to the contact instead of immediately receding.
      const margin = Math.max(0, (Math.min(face, plane.tangent / normal) - exact) * normal);
      const proximity = clamp(1 - margin / clamp(radius * 0.24, 5, 15));
      if (proximity <= 0 && face >= free + Math.max(0, ripple)) continue;
      const adhesion = proximity * proximity * plane.grip;
      wet = Math.max(wet, adhesion);
      if (face < gripBound) {
        gripBound = face;
        blendWidth = plane.cradle ? 0.12 : 0;
      }
    }
    // On the free sides the field can bulge or pinch. At a contact it joins the
    // meniscus on the shared contact surface, which keeps the droplets distinct.
    let boundary = free + ripple * (1 - wet);
    if (Number.isFinite(gripBound)) {
      boundary += (gripBound - boundary) * wet;
    }
    if (impact) boundary += impactDisplacement(impact, dx, dy, boundary) * (1 - wet * 0.86);
    if (Number.isFinite(gripBound)) {
      const join = Math.max(0, blendWidth - Math.abs(gripBound - boundary));
      boundary = Math.min(gripBound, boundary) - (blendWidth ? join ** 2 / (4 * blendWidth) : 0);
    }
    points[i] = lx * Math.max(0.26, boundary);
    points[i + 1] = ly * Math.max(0.26, boundary);
  }
  return points;
}
