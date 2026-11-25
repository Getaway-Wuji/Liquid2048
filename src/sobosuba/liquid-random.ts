/** Use one independent visual seed for each gesture. */
export function spawnVisualRandom() {
  const range = 0x100000000;
  let state = Math.floor(Math.random() * range);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / range;
  };
}
