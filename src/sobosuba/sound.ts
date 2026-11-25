export type Sound = 'launch' | 'collision' | 'merge' | 'achievement' | 'danger';

const notes: Record<Sound, readonly number[]> = {
  launch: [174, 247],
  collision: [105],
  merge: [370, 494, 659],
  achievement: [440, 554, 659, 880],
  danger: [165, 123],
};

export function createSound() {
  let audio: AudioContext | undefined;
  let lastCollision = -Infinity;

  function enable() {
    try {
      audio ??= new AudioContext();
      if (audio.state === 'suspended') void audio.resume().catch(() => {});
    } catch {
      // Play remains available when audio output is unavailable.
    }
  }

  function play(kind: Sound) {
    if (!audio || audio.state !== 'running') return;
    if (kind === 'collision') {
      if (audio.currentTime - lastCollision < 0.14) return;
      lastCollision = audio.currentTime;
    }
    const sequence = notes[kind];
    const context = audio;
    sequence.forEach((note, index) => {
      const start = context.currentTime + index * 0.068;
      const stop = start + (kind === 'collision' ? 0.07 : 0.19);
      const wave = context.createOscillator();
      const volume = context.createGain();
      wave.frequency.setValueAtTime(note, start);
      wave.frequency.exponentialRampToValueAtTime(note * 0.86, stop);
      volume.gain.setValueAtTime(0.001, start);
      volume.gain.exponentialRampToValueAtTime(kind === 'collision' ? 0.032 : 0.07, start + 0.018);
      volume.gain.exponentialRampToValueAtTime(0.001, stop);
      wave.connect(volume).connect(context.destination);
      wave.start(start);
      wave.stop(stop);
      wave.onended = () => {
        wave.disconnect();
        volume.disconnect();
      };
    });
  }

  return {
    enable,
    play,
    close: () => { if (audio) void audio.close().catch(() => {}); },
  };
}
