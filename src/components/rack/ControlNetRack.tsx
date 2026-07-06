import { useState } from 'react';
import {
  CONTROLNET_TYPES,
  CONTROLNET_TYPE_LABELS,
  CONTROLNET_TYPE_NAMES,
  estimateFamilyFromModelId,
  supportedTypes,
  type ControlNetType,
} from '../../core/controlnet';
import type { ControlSlot } from '../../core/types';
import { findNode, uid } from '../../core/workflow';
import { httpAdapter, useStudio } from '../../state/store';
import { Icon } from '../icons';

interface PreviewState {
  loading: boolean;
  map?: string;
  error?: string;
}

/**
 * ControlNet Rack panel — mirrors the LoRA Rack UX: stackable slots with an
 * enable switch, guidance type, strength, per-slot control image, and an
 * on-demand preprocess Preview that asks the bridge for the extracted map.
 */
export function ControlNetRack() {
  const workflow = useStudio((s) => s.workflow);
  const updateParam = useStudio((s) => s.updateParam);
  const addCapsule = useStudio((s) => s.addCapsule);
  const backendSettings = useStudio((s) => s.backendSettings);

  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});

  const node = findNode(workflow, 'controlNetRack');
  const slots = ((node?.params.slots as ControlSlot[] | undefined) ?? []);
  const modelNode = findNode(workflow, 'model');
  const family = estimateFamilyFromModelId(String(modelNode?.params.assetId ?? ''));
  const available = supportedTypes(family);
  const isMock = backendSettings.selectedBackend === 'mock';

  const setSlots = (next: ControlSlot[]) => {
    if (node) updateParam(node.id, 'slots', next);
  };
  const patch = (index: number, next: Partial<ControlSlot>) =>
    setSlots(slots.map((s, i) => (i === index ? { ...s, ...next } : s)));
  const addSlot = () =>
    setSlots([...slots, { id: uid('cn'), type: 'canny', strength: 1, image: '', enabled: true }]);
  const removeSlot = (index: number) => setSlots(slots.filter((_, i) => i !== index));

  const onFile = (index: number, file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => patch(index, { image: String(reader.result) });
    reader.readAsDataURL(file);
  };

  const setPreview = (slotId: string, state: PreviewState) =>
    setPreviews((prev) => ({ ...prev, [slotId]: state }));

  const runPreview = async (slot: ControlSlot) => {
    if (!slot.image || isMock) return;
    setPreview(slot.id, { loading: true });
    try {
      httpAdapter.setBaseUrl(backendSettings.bridgeUrl);
      const map = await httpAdapter.controlNetPreprocess({
        type: slot.type,
        image: slot.image,
        width: 512,
        height: 512,
      });
      setPreview(slot.id, { loading: false, map: `data:image/png;base64,${map}` });
    } catch (err) {
      setPreview(slot.id, { loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!node) {
    return (
      <section className="rail-section">
        <h3>{Icon.bolt({ size: 14 })} ControlNet Rack</h3>
        <div className="rack">
          <p className="field-help">
            No ControlNet Rack capsule in this recipe. Add one to stack depth, pose, edges and more.
          </p>
          <button className="btn" type="button" onClick={() => addCapsule('controlNetRack', 330, 460)}>
            {Icon.plus({ size: 14 })} Add ControlNet Rack
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rail-section">
      <h3>{Icon.bolt({ size: 14 })} ControlNet Rack</h3>
      <div className="rack">
        {slots.length === 0 ? (
          <p className="field-help">No controls stacked. Add a slot, pick a type, and upload a guide image.</p>
        ) : null}
        {slots.map((slot, index) => {
          const preview = previews[slot.id];
          const supported = available.includes(slot.type);
          const previewDisabled = isMock || !slot.image || Boolean(preview?.loading);
          const previewTitle = isMock
            ? 'Preview needs the local bridge — the Mock backend has no preprocessors.'
            : !slot.image
              ? 'Upload a control image first.'
              : 'Extract the guidance map without spending a render.';
          return (
            <div key={slot.id} className={`rack-row cn-row ${slot.enabled ? '' : 'disabled'}`}>
              <button
                type="button"
                role="switch"
                aria-checked={slot.enabled}
                aria-label={`Enable ${CONTROLNET_TYPE_NAMES[slot.type]} control`}
                className="switch"
                onClick={() => patch(index, { enabled: !slot.enabled })}
              />
              <select
                value={slot.type}
                aria-label={`Control type for slot ${index + 1}`}
                onChange={(e) => patch(index, { type: e.target.value as ControlNetType })}
              >
                {CONTROLNET_TYPES.map((t) => (
                  <option key={t} value={t}>{CONTROLNET_TYPE_LABELS[t]}</option>
                ))}
              </select>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={slot.strength}
                aria-label={`Strength for ${CONTROLNET_TYPE_NAMES[slot.type]} control`}
                onChange={(e) => patch(index, { strength: Number(e.target.value) })}
              />
              <span className="rack-weight mono">{slot.strength.toFixed(2)}</span>
              <button
                className="btn icon"
                type="button"
                aria-label={`Remove ${CONTROLNET_TYPE_NAMES[slot.type]} control`}
                onClick={() => removeSlot(index)}
              >
                {Icon.trash({ size: 14 })}
              </button>

              <div className="cn-media">
                <input
                  type="file"
                  accept="image/*"
                  aria-label={`Control image for ${CONTROLNET_TYPE_NAMES[slot.type]} slot`}
                  onChange={(e) => onFile(index, e.target.files?.[0])}
                />
                {slot.image ? (
                  <>
                    <img className="cn-thumb" src={slot.image} alt={`${CONTROLNET_TYPE_NAMES[slot.type]} control source`} />
                    <button
                      type="button"
                      className="btn icon"
                      aria-label={`Clear ${CONTROLNET_TYPE_NAMES[slot.type]} control image`}
                      onClick={() => patch(index, { image: '' })}
                    >
                      {Icon.close({ size: 14 })}
                    </button>
                  </>
                ) : null}
                <button
                  className="btn"
                  type="button"
                  disabled={previewDisabled}
                  title={previewTitle}
                  aria-label={`Preview ${CONTROLNET_TYPE_NAMES[slot.type]} map`}
                  onClick={() => void runPreview(slot)}
                >
                  {preview?.loading ? 'Extracting…' : 'Preview'}
                </button>
                {preview?.loading ? <span className="cn-pending" role="status">Extracting map…</span> : null}
                {preview?.map && !preview.loading ? (
                  <img className="cn-map" src={preview.map} alt={`${CONTROLNET_TYPE_NAMES[slot.type]} preprocessed map`} />
                ) : null}
                {preview?.error && !preview.loading ? (
                  <span className="rack-warning" role="alert">{Icon.warning({ size: 14 })} {preview.error}</span>
                ) : null}
              </div>

              {!supported ? (
                <p className="rack-warning">
                  {Icon.warning({ size: 14 })} {CONTROLNET_TYPE_NAMES[slot.type]} is not available for {family} — it will be skipped.
                </p>
              ) : null}
            </div>
          );
        })}

        <div className="rack-add-row">
          <button className="btn" type="button" onClick={addSlot}>
            {Icon.plus({ size: 14 })} Add control slot
          </button>
        </div>
      </div>
    </section>
  );
}
