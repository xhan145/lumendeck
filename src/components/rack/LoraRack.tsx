import { useState } from 'react';
import { findAsset, loraCompatible } from '../../core/shelf';
import { findNode } from '../../core/workflow';
import type { LoraSlot } from '../../core/types';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';

export function LoraRack() {
  const shelf = useStudio((s) => s.shelf);
  const workflow = useStudio((s) => s.workflow);
  const rackSlots = useStudio((s) => s.rackSlots);
  const setRackSlots = useStudio((s) => s.setRackSlots);
  const rackPresets = useStudio((s) => s.rackPresets);
  const saveRackPreset = useStudio((s) => s.saveRackPreset);
  const applyRackPreset = useStudio((s) => s.applyRackPreset);
  const deleteRackPreset = useStudio((s) => s.deleteRackPreset);

  const [presetName, setPresetName] = useState('');
  const slots = rackSlots();
  const availableLoras = shelf.filter((a) => a.assetType === 'lora');
  const modelNode = findNode(workflow, 'model');
  const checkpoint = findAsset(shelf, String(modelNode?.params.assetId ?? ''));

  const patch = (index: number, next: Partial<LoraSlot>) =>
    setRackSlots(slots.map((s, i) => (i === index ? { ...s, ...next } : s)));
  const addLora = (assetId: string) => setRackSlots([...slots, { assetId, weight: 0.7, enabled: true }]);
  const removeLora = (index: number) => setRackSlots(slots.filter((_, i) => i !== index));

  const savePreset = () => {
    const name = presetName.trim() || `Stack ${rackPresets.length + 1}`;
    saveRackPreset(name);
    setPresetName('');
  };

  return (
    <section className="rail-section">
      <h3>{Icon.bolt({ size: 14 })} LoRA Rack</h3>
      <div className="rack">
        {slots.length === 0 ? <p className="field-help">No LoRAs stacked. Add one below or from the Model Shelf.</p> : null}
        {slots.map((slot, index) => {
          const asset = findAsset(shelf, slot.assetId);
          const compat = asset && checkpoint ? loraCompatible(asset, checkpoint) : { ok: true };
          return (
            <div key={`${slot.assetId}-${index}`} className={`rack-row ${slot.enabled ? '' : 'disabled'}`}>
              <button
                type="button"
                role="switch"
                aria-checked={slot.enabled}
                aria-label={`Enable ${asset?.name ?? slot.assetId}`}
                className="switch"
                onClick={() => patch(index, { enabled: !slot.enabled })}
              />
              <div className="rack-name">
                <span className="n" title={asset?.name ?? slot.assetId}>{asset?.name ?? slot.assetId}</span>
                <span className="w-label">{asset?.family ?? '?'} · weight</span>
              </div>
              <input
                type="range"
                min={-1}
                max={2}
                step={0.05}
                value={slot.weight}
                aria-label={`Weight for ${asset?.name ?? slot.assetId}`}
                onChange={(e) => patch(index, { weight: Number(e.target.value) })}
              />
              <span className="rack-weight mono">{slot.weight.toFixed(2)}</span>
              <button className="btn icon" type="button" aria-label={`Remove ${asset?.name ?? slot.assetId}`} onClick={() => removeLora(index)}>
                {Icon.trash({ size: 14 })}
              </button>
              {!compat.ok ? (
                <p className="rack-warning">{Icon.warning({ size: 14 })} {compat.warning}</p>
              ) : null}
            </div>
          );
        })}

        <div className="rack-add-row">
          <select value="" aria-label="Add a LoRA" onChange={(e) => { if (e.target.value) addLora(e.target.value); }}>
            <option value="">Add a LoRA…</option>
            {availableLoras.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.family}){a.installed ? '' : ' — not installed'}</option>
            ))}
          </select>
        </div>

        <div className="rack-presets">
          <div className="rack-presets-row">
            <input value={presetName} placeholder="Preset name" aria-label="Preset name"
              onChange={(e) => setPresetName(e.target.value)} />
            <button className="btn" type="button" onClick={savePreset} disabled={slots.length === 0}>
              {Icon.save({ size: 14 })} Save
            </button>
          </div>
          {rackPresets.length > 0 ? (
            <div className="preset-chip-row">
              {rackPresets.map((p) => (
                <span key={p.id} className="chip preset-chip">
                  <button className="apply" type="button" onClick={() => applyRackPreset(p.id)} title={`Apply ${p.name}`}>
                    {p.name} ({p.slots.length})
                  </button>
                  <button className="del" type="button" aria-label={`Delete preset ${p.name}`} onClick={() => deleteRackPreset(p.id)}>
                    {Icon.close({ size: 12 })}
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
