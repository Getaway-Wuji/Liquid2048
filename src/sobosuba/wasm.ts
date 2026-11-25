import wasmUrl from './sobosuba_engine.wasm?url';
import { RACK_HULL_STRIDE, SLOT_COUNT } from './rack';

interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  reset(seed: number): void;
  step(): void;
  set_paused(paused: number): void;
  launch(slot: number, dx: number, dy: number, power: number): number;
  splash(id: number, x: number, y: number): 0 | 1 | 2;
  throw_drop(id: number, dx: number, dy: number, power: number): 0 | 1;
  scored_merges(): number;
  snapshot_ptr(): number;
  snapshot_len(): number;
  rack_hulls_ptr(): number;
  score_ptr(): number;
  score_len(): number;
  achievement_flags(totalMerges: number): number;
  collision_event(): number;
  merge_events_ptr(): number;
  merge_events_len(): number;
  clear_merge_events(): void;
}

export async function loadCore(signal: AbortSignal) {
  const response = await fetch(wasmUrl, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  const core = instance.exports as Exports;
  if (!(core.memory instanceof WebAssembly.Memory) || typeof core.step !== 'function' ||
      typeof core.splash !== 'function' || typeof core.throw_drop !== 'function' ||
      typeof core.rack_hulls_ptr !== 'function' || typeof core.scored_merges !== 'function') {
    throw new Error('Invalid sobosuba WASM exports');
  }
  const decoder = new TextDecoder();

  function snapshot() {
    return new Float32Array(core.memory.buffer, core.snapshot_ptr(), core.snapshot_len());
  }

  function score() {
    return decoder.decode(new Uint8Array(core.memory.buffer, core.score_ptr(), core.score_len()));
  }

  function rackHulls() {
    return new Float32Array(core.memory.buffer, core.rack_hulls_ptr(), SLOT_COUNT * RACK_HULL_STRIDE);
  }

  function mergeEvents() {
    return new Float32Array(core.memory.buffer, core.merge_events_ptr(), core.merge_events_len());
  }

  return { core, snapshot, rackHulls, score, mergeEvents };
}

export function ballValue(level: number): string {
  return level > 0 ? (1n << BigInt(level)).toString() : '—';
}
