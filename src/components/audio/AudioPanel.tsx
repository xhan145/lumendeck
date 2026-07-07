import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { CAPSULES } from '../../core/capsules';
import { useStudio, readAudioFrequency } from '../../state/store';
import { computeBands, scaleBands } from '../../core/audio/bands';
import type { AudioBand, AudioTargetKind } from '../../core/audio/mapping';
import { SENSITIVITY_MIN, SENSITIVITY_MAX } from '../../state/audio';
import { Icon } from '../icons';
import '../../styles/audio.css';

const BANDS: AudioBand[] = ['bass', 'mid', 'treble', 'level'];
const KINDS: AudioTargetKind[] = ['x', 'y', 'z', 'ring', 'scale'];
const KIND_LABEL: Record<AudioTargetKind, string> = {
  x: 'X drift',
  y: 'Y drift',
  z: 'Z drift',
  ring: 'Ring',
  scale: 'Scale',
};

/** Bake window bounds (seconds). */
const BAKE_MIN = 1;
const BAKE_MAX = 30;
const BAKE_DEFAULT = 3;
/** Test-tone default frequency (Hz). */
const TONE_DEFAULT = 220;

function clampInt(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/**
 * Audio Reactivity panel — the source picker + mapping editor + live meter +
 * bake control for Phase 3. Lives in the graph/motion dock beside the Motion
 * Timeline (so it's only ever shown ON the 3D view, where the reactive tick
 * runs). Consumes only the store's audio slice + pure band math — no scene/WebGL
 * knowledge and no AudioContext (the store owns the engine).
 *
 * HONEST FRAMING: reactivity is a live PREVIEW overlay (view-only orb motion),
 * mirroring the motion-render note; only "Bake" persists a capture. Mic requires
 * permission — denial surfaces as a loud status, never a fake signal.
 *
 * Reduced-motion: nothing auto-starts; Start is always an explicit press, and
 * CSS suppresses the meter transition under prefers-reduced-motion.
 */
export function AudioPanel() {
  const workflow = useStudio((s) => s.workflow);
  const running = useStudio((s) => s.audio.running);
  const source = useStudio((s) => s.audio.source);
  const mapping = useStudio((s) => s.audio.mapping);
  const sensitivity = useStudio((s) => s.audio.sensitivity);

  const startAudio = useStudio((s) => s.startAudio);
  const stopAudio = useStudio((s) => s.stopAudio);
  const setAudioMapping = useStudio((s) => s.setAudioMapping);
  const setAudioSensitivity = useStudio((s) => s.setAudioSensitivity);
  const bakeAudioClip = useStudio((s) => s.bakeAudioClip);

  const [toneHz, setToneHz] = useState(TONE_DEFAULT);
  const [bakeSeconds, setBakeSeconds] = useState(BAKE_DEFAULT);
  const fileRef = useRef<HTMLInputElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);

  // ---- live level meter (rAF; updates the DOM directly, no re-render) -------
  useEffect(() => {
    if (!running) {
      if (meterRef.current) meterRef.current.style.width = '0%';
      return;
    }
    let raf = 0;
    const tick = () => {
      const bands = scaleBands(computeBands(readAudioFrequency()), sensitivity);
      if (meterRef.current) meterRef.current.style.width = `${Math.round(bands.level * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, sensitivity]);

  // ---- source actions ------------------------------------------------------
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    await startAudio({ file: buf });
    // Allow re-selecting the same file to restart it.
    if (fileRef.current) fileRef.current.value = '';
  };

  // ---- mapping editor ------------------------------------------------------
  const updateTarget = (i: number, patch: Partial<{ band: AudioBand; kind: AudioTargetKind; nodeId: string; gain: number }>) =>
    setAudioMapping({ targets: mapping.targets.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) });
  const removeTarget = (i: number) =>
    setAudioMapping({ targets: mapping.targets.filter((_, idx) => idx !== i) });
  const addTarget = () => {
    const nodeId = workflow.nodes.find((n) => n.kind === 'sampler')?.id ?? workflow.nodes[0]?.id ?? '';
    setAudioMapping({ targets: [...mapping.targets, { band: 'bass', kind: 'x', nodeId, gain: 1 }] });
  };

  return (
    <section className="audio-panel" aria-label="Audio Reactivity">
      <header className="ap-head">
        <h3 className="ap-title">{Icon.pulse({ size: 14 })} Audio Reactivity</h3>
        <span className={`ap-status ${running ? 'live' : ''}`} role="status" aria-live="polite">
          {running ? `Listening · ${source ?? ''}` : 'Idle'}
        </span>
      </header>

      <p className="field-help ap-note">
        Sound drives orb motion/rings as a live preview (view-only). Bake a window into a Motion clip to keep it.
      </p>

      {/* ---- source picker + transport ------------------------------------ */}
      <div className="ap-sources" role="group" aria-label="Audio source">
        <label className="btn ap-file" title="Analyse an audio file">
          {Icon.folder({ size: 14 })} File
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="ap-file-input"
            aria-label="Choose an audio file to analyse"
            onChange={onFile}
          />
        </label>
        <button
          className="btn"
          type="button"
          title="Analyse the microphone (asks permission)"
          aria-pressed={running && source === 'mic'}
          onClick={() => void startAudio({ mic: true })}
        >
          {Icon.plug({ size: 14 })} Mic
        </button>
        <label className="ap-inline ap-tone">
          <span className="ap-inline-label">Tone (Hz)</span>
          <input
            type="number"
            min={20}
            max={20000}
            step={10}
            value={toneHz}
            aria-label="Test tone frequency in hertz"
            onChange={(e) => setToneHz(clampInt(Number(e.target.value), 20, 20000, TONE_DEFAULT))}
          />
        </label>
        <button
          className="btn"
          type="button"
          title="Play a deterministic test tone (no mic needed)"
          aria-pressed={running && source === 'tone'}
          onClick={() => void startAudio({ tone: toneHz })}
        >
          {Icon.bolt({ size: 14 })} Test tone
        </button>
        <button
          className="btn ap-stop"
          type="button"
          disabled={!running}
          aria-disabled={!running}
          title="Stop listening (orbs return to rest)"
          onClick={() => stopAudio()}
        >
          <span className="ap-stop-glyph" aria-hidden="true" /> Stop
        </button>
      </div>

      {/* ---- live level meter --------------------------------------------- */}
      <div className="ap-meter" role="group" aria-label="Live level">
        <span className="ap-inline-label">Level</span>
        <div
          className="ap-meter-track"
          role="progressbar"
          aria-label="Live audio level"
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div ref={meterRef} className="ap-meter-fill" style={{ width: '0%' }} aria-hidden="true" />
        </div>
      </div>

      {/* ---- sensitivity -------------------------------------------------- */}
      <label className="ap-inline ap-sens">
        <span className="ap-inline-label">Sensitivity</span>
        <input
          type="range"
          min={SENSITIVITY_MIN}
          max={SENSITIVITY_MAX}
          step={0.1}
          value={sensitivity}
          aria-label="Band sensitivity"
          onChange={(e) => setAudioSensitivity(Number(e.target.value))}
        />
        <span className="ap-inline-val mono">{sensitivity.toFixed(1)}×</span>
      </label>

      {/* ---- mapping editor ----------------------------------------------- */}
      <div className="ap-mapping" role="group" aria-label="Band to orb mapping">
        <div className="ap-mapping-head">
          <span className="ap-mapping-title">Mapping</span>
          <button className="btn" type="button" onClick={addTarget} title="Add a band → orb target">
            {Icon.plus({ size: 14 })} Add target
          </button>
        </div>
        {mapping.targets.length === 0 ? (
          <p className="field-help">No targets. Add one to wire a frequency band to an orb.</p>
        ) : (
          <ul className="ap-target-list">
            {mapping.targets.map((target, i) => (
              <li key={i} className="ap-target">
                <label className="ap-inline">
                  <span className="ap-inline-label sr-only-label">Band</span>
                  <select
                    aria-label={`Target ${i + 1} band`}
                    value={target.band}
                    onChange={(e) => updateTarget(i, { band: e.target.value as AudioBand })}
                  >
                    {BANDS.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <span className="ap-arrow" aria-hidden="true">→</span>
                <label className="ap-inline">
                  <span className="ap-inline-label sr-only-label">Channel</span>
                  <select
                    aria-label={`Target ${i + 1} channel`}
                    value={target.kind}
                    onChange={(e) => updateTarget(i, { kind: e.target.value as AudioTargetKind })}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </label>
                <label className="ap-inline">
                  <span className="ap-inline-label sr-only-label">Node</span>
                  <select
                    aria-label={`Target ${i + 1} node`}
                    value={target.nodeId}
                    onChange={(e) => updateTarget(i, { nodeId: e.target.value })}
                  >
                    {workflow.nodes.map((n) => (
                      <option key={n.id} value={n.id}>{CAPSULES[n.kind].title}</option>
                    ))}
                  </select>
                </label>
                <label className="ap-inline ap-gain">
                  <span className="ap-inline-label sr-only-label">Gain</span>
                  <input
                    type="number"
                    min={0}
                    max={8}
                    step={0.1}
                    value={target.gain}
                    aria-label={`Target ${i + 1} gain`}
                    onChange={(e) => updateTarget(i, { gain: Number(e.target.value) })}
                  />
                </label>
                <button
                  className="btn icon"
                  type="button"
                  aria-label={`Remove target ${i + 1}`}
                  title="Remove this target"
                  onClick={() => removeTarget(i)}
                >
                  {Icon.trash({ size: 14 })}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- bake --------------------------------------------------------- */}
      <div className="ap-bake" role="group" aria-label="Bake audio to clip">
        <label className="ap-inline">
          <span className="ap-inline-label">Seconds</span>
          <input
            type="number"
            min={BAKE_MIN}
            max={BAKE_MAX}
            step={1}
            value={bakeSeconds}
            aria-label="Bake window in seconds"
            onChange={(e) => setBakeSeconds(Number(e.target.value))}
            onBlur={(e) => setBakeSeconds(clampInt(Number(e.target.value), BAKE_MIN, BAKE_MAX, BAKE_DEFAULT))}
          />
        </label>
        <button
          className="btn primary"
          type="button"
          disabled={!running}
          aria-disabled={!running}
          title={running ? 'Record this window into a Motion clip' : 'Start audio first to bake a clip'}
          onClick={() => bakeAudioClip(clampInt(bakeSeconds, BAKE_MIN, BAKE_MAX, BAKE_DEFAULT))}
        >
          {Icon.save({ size: 14 })} Bake {clampInt(bakeSeconds, BAKE_MIN, BAKE_MAX, BAKE_DEFAULT)}s → clip
        </button>
      </div>
    </section>
  );
}
