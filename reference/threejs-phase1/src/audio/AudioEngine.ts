import type { SimEvent } from '../physics/PhysicsWorld';

/**
 * Procedural audio — no asset files, no licensing questions.
 *
 * Everything is synthesised from oscillators and a shared noise buffer, the
 * same approach EMBERLOOP takes. The AudioContext is only created inside a user
 * gesture (`unlock()`), which is what mobile browsers require.
 *
 * The important part is that intensity is driven by the *physics*: a collision
 * event carries the normal impulse that produced it, and that impulse sets both
 * the gain and the pitch of the click. A soft safety and a full-blooded break
 * do not sound the same, because they were not the same collision.
 */

/** Impulse (N·s) treated as "as loud as it gets". A hard break is around this. */
const LOUD_IMPULSE = 1.6;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Guards against a hundred simultaneous clicks on the break. */
  private lastEventTime = 0;

  enabled = true;

  /** Create or resume the context. Must be called from inside a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.createNoise(1.5);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** The cue striking the ball. `power` is 0..1. */
  cueStrike(power: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const level = 0.12 + 0.5 * power;
    // A cue tip is mostly a short, dry thud with a little wood in it.
    this.burst(90 + 160 * power, 0.055, level * 0.9, 'triangle', 0.35);
    this.noise(0.03, level * 0.5, 2600 + 2200 * power);
  }

  /** Drain a frame's worth of simulation events into sound. */
  play(events: readonly SimEvent[]): void {
    const ctx = this.ready();
    if (!ctx) return;

    for (const event of events) {
      switch (event.type) {
        case 'ball-ball':
          this.click(event.impulse);
          break;
        case 'rail':
          this.cushion(event.impulse);
          break;
        case 'jaw':
          this.cushion(event.impulse * 0.7);
          break;
        case 'pocket':
          this.pocketDrop();
          break;
        case 'rest':
          break;
      }
    }
  }

  /**
   * Phenolic on phenolic: a bright, very short click. Harder contacts are both
   * louder and higher, which is what the ear actually uses to judge a hit.
   */
  private click(impulse: number): void {
    const t = Math.min(1, impulse / LOUD_IMPULSE);
    if (t < 0.005 || !this.throttle(0.006)) return;
    this.burst(1500 + 1500 * t, 0.035, 0.05 + 0.32 * t, 'square', 0.2);
    this.noise(0.012, 0.03 + 0.16 * t, 6000);
  }

  /** Cushion rubber: lower, softer, with more body than a ball click. */
  private cushion(impulse: number): void {
    const t = Math.min(1, impulse / LOUD_IMPULSE);
    if (t < 0.005 || !this.throttle(0.01)) return;
    this.burst(180 + 220 * t, 0.09, 0.05 + 0.22 * t, 'sine', 0.5);
    this.noise(0.05, 0.02 + 0.1 * t, 900);
  }

  /** A ball dropping into the throat and rattling down. */
  private pocketDrop(): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.burst(140, 0.14, 0.2, 'sine', 0.6);
    // Three descending taps standing in for the ball hitting the way down.
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => this.burst(320 - i * 70, 0.05, 0.09, 'triangle', 0.3), 90 + i * 85);
    }
  }

  // ------------------------------------------------------------------ synth

  private ready(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx || this.ctx.state !== 'running') return null;
    return this.ctx;
  }

  /** Rate-limit so a fifteen-ball pack does not clip the master bus. */
  private throttle(minGap: number): boolean {
    const ctx = this.ctx!;
    if (ctx.currentTime - this.lastEventTime < minGap) return false;
    this.lastEventTime = ctx.currentTime;
    return true;
  }

  private burst(
    frequency: number,
    duration: number,
    gain: number,
    type: OscillatorType,
    decay: number,
  ): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * decay), now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env);
    env.connect(this.master!);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  private noise(duration: number, gain: number, cutoff: number): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(this.master!);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  private createNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic noise, so a recorded shot always sounds identical.
    let seed = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    return buffer;
  }
}
