export const SLOT_COUNT = 4;
export const SNAPSHOT_HEADER = 43;
export const BODY_HULL_NODES = 12;
export const BODY_IMPACT_OFFSET = 8 + 2 * BODY_HULL_NODES;
export const SNAPSHOT_BODY_STRIDE = BODY_IMPACT_OFFSET + 5;
export const RACK_HULL_STRIDE = 5 + 2 * BODY_HULL_NODES;
export const MERGE_EVENT_STRIDE = 5;

// The fourth slot extends the original header without displacing the event fields.
const LEVEL_OFFSETS = [8, 9, 10, 33];
const ENTRY_OFFSETS = [18, 20, 22, 34];
const HOME_OFFSETS = [24, 27, 30, 36];

export interface RackSlot {
  x: number;
  y: number;
  radius: number;
  targetX: number;
  level: number;
}

export const rackLevel = (state: Float32Array, slot: number) => state[LEVEL_OFFSETS[slot]] ?? 0;
export const rackIdentity = (state: Float32Array, slot: number) => state[39 + slot];

export function rackEntry(state: Float32Array, slot: number) {
  const offset = ENTRY_OFFSETS[slot];
  return { x: state[offset], y: state[offset + 1] };
}

export function rackSlot(state: Float32Array, slot: number, hulls?: Float32Array): RackSlot {
  const offset = HOME_OFFSETS[slot];
  const level = rackLevel(state, slot);
  const live = hulls && level ? slot * RACK_HULL_STRIDE : -1;
  return {
    x: hulls && live >= 0 ? hulls[live] : state[offset],
    y: hulls && live >= 0 ? hulls[live + 1] : state[offset + 1],
    radius: state[offset + 2], targetX: state[offset], level,
  };
}

export function readHeldRack(state: Float32Array, hulls: Float32Array, previous: readonly RackSlot[]): readonly RackSlot[] {
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const old = previous[slot];
    const offset = HOME_OFFSETS[slot], live = slot * RACK_HULL_STRIDE;
    const level = rackLevel(state, slot);
    if (!old || old.level !== level || old.targetX !== state[offset] || old.radius !== state[offset + 2] ||
        old.x !== (level ? hulls[live] : state[offset]) || old.y !== (level ? hulls[live + 1] : state[offset + 1])) {
      return Array.from({ length: SLOT_COUNT }, (_, index) => rackSlot(state, index, hulls));
    }
  }
  return previous;
}
