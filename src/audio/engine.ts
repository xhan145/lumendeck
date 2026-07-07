/**
 * Audio Reactivity (Phase 3) — the browser AudioEngine.
 *
 * A small, React-FREE wrapper around `AudioContext` + `AnalyserNode`. It accepts
 * three sources — a decoded audio file, the microphone, or a built-in oscillator
 * test tone — routes them through an analyser, and exposes the current byte FFT
 * via `read()`. The UI polls `read()` from the existing 3D render loop's rAF
 * while the view is mounted (audio reactivity only matters on-screen); the engine
 * is torn down on `stop()` so the AudioContext + mic tracks never leak.
 *
 * GUARDS (honest, never a fake signal): if the browser has no `AudioContext`, or
 * getUserMedia is unavailable / rejected, `start()` REJECTS with a clear message
 * the store surfaces as a loud status, and the engine stays stopped.
 *
 * Analyser pull: an AnalyserNode is only processed while its graph reaches the
 * destination. To keep mic/tone frames flowing WITHOUT audible feedback/whine we
 * route `analyser -> muteGain(0) -> destination`; a file plays audibly
 * (`muteGain = 1`). See docs/superpowers/specs/2026-07-06-audio-reactivity-phase3-design.md.
 */

/** The three audio sources the engine can analyse. */
export type AudioSource = { file: ArrayBuffer } | { mic: true } | { tone: number };

type AudioContextCtor = typeof AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array | null = null;
  private micStream: MediaStream | null = null;
  private sourceNode: AudioNode | null = null;
  private muteGain: GainNode | null = null;
  private started = false;

  /** True between a resolved `start()` and the next `stop()`. */
  get running(): boolean {
    return this.started;
  }

  /**
   * Start analysing `source`. Tears down any prior session first (idempotent),
   * then builds `source -> analyser -> muteGain -> destination`. Rejects loudly
   * when Web Audio is unavailable or mic permission is denied.
   */
  async start(source: AudioSource): Promise<void> {
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) {
      throw new Error('Web Audio is not available in this browser, so live audio reactivity is off.');
    }
    // Fully release any previous session before opening a new one.
    this.stop();

    const ctx = new Ctor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024; // 512 frequency bins
    analyser.smoothingTimeConstant = 0.6;
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    // A muted sink keeps the analyser graph "pulled" without audible output.
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    analyser.connect(muteGain);
    muteGain.connect(ctx.destination);

    try {
      if ('mic' in source) {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          throw new Error('Microphone capture is not available in this browser.');
        }
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          throw new Error('Microphone permission was denied. Grant mic access to use live audio.');
        }
        this.micStream = stream;
        const src = ctx.createMediaStreamSource(stream);
        src.connect(analyser); // mic is NEVER routed to the speakers (feedback)
        this.sourceNode = src;
      } else if ('tone' in source) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = Number.isFinite(source.tone) && source.tone > 0 ? source.tone : 220;
        osc.connect(analyser); // silent via muteGain(0), still analysed
        osc.start();
        this.sourceNode = osc;
      } else {
        // decodeAudioData may DETACH the buffer, so decode a copy.
        const audioBuffer = await ctx.decodeAudioData(source.file.slice(0));
        const node = ctx.createBufferSource();
        node.buffer = audioBuffer;
        node.loop = true;
        node.connect(analyser);
        muteGain.gain.value = 1; // a file should be audible
        node.start();
        this.sourceNode = node;
      }
    } catch (err) {
      // Roll back the half-built graph so a failed start leaves nothing running.
      try {
        analyser.disconnect();
        muteGain.disconnect();
      } catch {
        /* already detached */
      }
      if (this.micStream) {
        for (const track of this.micStream.getTracks()) track.stop();
        this.micStream = null;
      }
      this.sourceNode = null;
      void ctx.close().catch(() => {});
      throw err;
    }

    // Autoplay policies can open a context suspended; resume so frames flow.
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* best effort — read() simply returns zeros until it resumes */
      }
    }

    this.ctx = ctx;
    this.analyser = analyser;
    this.freqData = freqData;
    this.muteGain = muteGain;
    this.started = true;
  }

  /**
   * Read the current byte FFT (0..255 per bin). Returns a shared, reused buffer
   * (do not retain across frames). Empty (length 0) when the engine is stopped.
   */
  read(): Uint8Array {
    if (!this.analyser || !this.freqData) return EMPTY;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  /** Number of frequency bins `read()` returns (0 when stopped). */
  get binCount(): number {
    return this.freqData?.length ?? 0;
  }

  /**
   * Tear everything down: stop the source, release mic tracks, disconnect the
   * analyser/gain, and close the AudioContext. Safe to call when already
   * stopped (idempotent) and safe to call repeatedly.
   */
  stop(): void {
    if (this.sourceNode) {
      const node = this.sourceNode as AudioNode & { stop?: () => void };
      if (typeof node.stop === 'function') {
        try {
          node.stop();
        } catch {
          /* oscillator/buffer already stopped */
        }
      }
      try {
        node.disconnect();
      } catch {
        /* already detached */
      }
      this.sourceNode = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        /* already detached */
      }
      this.analyser = null;
    }
    if (this.muteGain) {
      try {
        this.muteGain.disconnect();
      } catch {
        /* already detached */
      }
      this.muteGain = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close().catch(() => {});
    }
    this.freqData = null;
    this.started = false;
  }
}

/** Shared empty buffer returned by `read()` when stopped (avoids allocation). */
const EMPTY = new Uint8Array(0);
