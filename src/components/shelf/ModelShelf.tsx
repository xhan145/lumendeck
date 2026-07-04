import { useEffect, useState } from 'react';
import { findAsset, type ModelAsset, type ModelFamily } from '../../core/shelf';
import { findNode } from '../../core/workflow';
import type { LoraSlot } from '../../core/types';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';

type Filter = 'all' | 'checkpoint' | 'lora';
const FAMILIES: (ModelFamily | 'all')[] = ['all', 'SD1.5', 'SDXL', 'SD3', 'Flux'];

function AssetCard({ asset }: { asset: ModelAsset }) {
  const workflow = useStudio((s) => s.workflow);
  const shelf = useStudio((s) => s.shelf);
  const updateParam = useStudio((s) => s.updateParam);
  const rackSlots = useStudio((s) => s.rackSlots);
  const setRackSlots = useStudio((s) => s.setRackSlots);

  const modelNode = findNode(workflow, 'model');
  const currentCheckpoint = String(modelNode?.params.assetId ?? '');
  const slots = rackSlots();
  const inRack = slots.some((s) => s.assetId === asset.id);
  const inUse = asset.assetType === 'checkpoint' && currentCheckpoint === asset.id;

  const useCheckpoint = () => modelNode && updateParam(modelNode.id, 'assetId', asset.id);
  const addToRack = () => {
    if (inRack) return;
    const slot: LoraSlot = { assetId: asset.id, weight: 0.7, enabled: true };
    setRackSlots([...slots, slot]);
  };

  const checkpoint = findAsset(shelf, currentCheckpoint);
  const crossFamily = asset.assetType === 'lora' && checkpoint && checkpoint.family !== asset.family;

  return (
    <article className={`card asset-card ${asset.installed ? '' : 'uninstalled'}`}>
      <div className="asset-head">
        <h3 title={asset.name}>{asset.name}</h3>
        <span className={`chip family-chip family-${asset.family}`}>{asset.family}</span>
      </div>
      <div className="asset-meta">
        <span>{asset.assetType === 'checkpoint' ? 'Checkpoint' : 'LoRA'} · {asset.sizeMB.toLocaleString()} MB · {asset.installed ? 'installed' : 'not installed'}</span>
        <span className="mono" title={asset.path}>{asset.path}</span>
        <span className="mono">sha {asset.hash}</span>
        <span>License: {asset.license}</span>
      </div>
      <div className="asset-tags">
        {asset.tags.map((t) => <span key={t} className="chip">{t}</span>)}
      </div>
      <p className="asset-note">{asset.compatibility}</p>
      {crossFamily ? (
        <p className="rack-warning">{Icon.warning({ size: 14 })} {asset.family} LoRA vs {checkpoint!.family} checkpoint — likely incompatible.</p>
      ) : null}
      <div className="asset-actions">
        {asset.assetType === 'checkpoint' ? (
          inUse ? (
            <span className="in-use">{Icon.ok({ size: 14 })} In use</span>
          ) : (
            <button className="btn" type="button" disabled={!asset.installed} onClick={useCheckpoint}>Use model</button>
          )
        ) : (
          inRack ? (
            <span className="in-use">{Icon.ok({ size: 14 })} In rack</span>
          ) : (
            <button className="btn" type="button" disabled={!asset.installed} onClick={addToRack}>{Icon.plus({ size: 14 })} Add to rack</button>
          )
        )}
      </div>
    </article>
  );
}

export function ModelShelf() {
  const shelf = useStudio((s) => s.shelf);
  const shelfSource = useStudio((s) => s.shelfSource);
  const bridgeModelFolderStatus = useStudio((s) => s.bridgeModelFolderStatus);
  const bridgeModelFolderBusy = useStudio((s) => s.bridgeModelFolderBusy);
  const bridgeModelFolderError = useStudio((s) => s.bridgeModelFolderError);
  const refreshModelFolderStatus = useStudio((s) => s.refreshModelFolderStatus);
  const refreshShelfFromBridge = useStudio((s) => s.refreshShelfFromBridge);
  const setBridgeModelFolder = useStudio((s) => s.setBridgeModelFolder);
  const [type, setType] = useState<Filter>('all');
  const [family, setFamily] = useState<ModelFamily | 'all'>('all');
  const [folderPath, setFolderPath] = useState('');

  useEffect(() => {
    void refreshModelFolderStatus();
  }, [refreshModelFolderStatus]);

  useEffect(() => {
    setFolderPath(bridgeModelFolderStatus?.configured || bridgeModelFolderStatus?.active || '');
  }, [bridgeModelFolderStatus?.active, bridgeModelFolderStatus?.configured]);

  const filtered = shelf.filter(
    (a) => (type === 'all' || a.assetType === type) && (family === 'all' || a.family === family),
  );

  return (
    <main className="shelf" aria-label="Model Shelf">
      <div className="shelf-inner">
        <div className="shelf-head">
          <h2>Model Shelf</h2>
          <span className="sub">
            {shelf.length} assets · source: {shelfSource === 'bridge' ? 'local bridge scan' : 'demo catalog'}
          </span>
        </div>
        <section className="shelf-folder" aria-label="Local models folder">
          <div className="shelf-folder-copy">
            <h3>{Icon.folder({ size: 16 })} Bring your own models</h3>
            <p>
              Point LumenDeck at a folder containing checkpoints and LoRAs. It scans .safetensors, .ckpt, .pt, and .pth files, including ComfyUI-style subfolders.
            </p>
            <div className="shelf-folder-status">
              <span className="chip">Active: {bridgeModelFolderStatus?.active || 'auto/demo'}</span>
              <span className="chip">{bridgeModelFolderStatus?.checkpointCount ?? 0} checkpoints</span>
              <span className="chip">{bridgeModelFolderStatus?.loraCount ?? 0} LoRAs</span>
            </div>
          </div>
          <div className="shelf-folder-controls">
            <label className="field">
              <span className="field-label">Folder path</span>
              <input
                value={folderPath}
                placeholder="C:\ComfyUI\models or D:\AI\models"
                onChange={(event) => setFolderPath(event.target.value)}
              />
              <span className="field-help">Paste an absolute Windows folder path. Clear it to return to auto-detect/demo.</span>
            </label>
            <div className="turbo-actions">
              <button className="btn primary" type="button" disabled={bridgeModelFolderBusy} onClick={() => void setBridgeModelFolder(folderPath)}>
                {Icon.folder({ size: 14 })} {bridgeModelFolderBusy ? 'Scanning...' : 'Scan folder'}
              </button>
              <button className="btn" type="button" disabled={bridgeModelFolderBusy} onClick={() => { setFolderPath(''); void setBridgeModelFolder(''); }}>
                {Icon.restore({ size: 14 })} Auto
              </button>
              <button className="btn" type="button" disabled={bridgeModelFolderBusy} onClick={() => { void refreshModelFolderStatus(); void refreshShelfFromBridge(); }}>
                {Icon.pulse({ size: 14 })} Refresh
              </button>
            </div>
            {bridgeModelFolderError ? <p className="backend-model-error">{bridgeModelFolderError}</p> : null}
          </div>
        </section>
        <div className="shelf-filters" role="group" aria-label="Filter by type">
          {(['all', 'checkpoint', 'lora'] as Filter[]).map((f) => (
            <button key={f} className="chip filter-chip" aria-pressed={type === f} onClick={() => setType(f)}>
              {f === 'all' ? 'All types' : f === 'checkpoint' ? 'Checkpoints' : 'LoRAs'}
            </button>
          ))}
          <span style={{ width: 1, background: 'var(--ld-border)', margin: '0 4px' }} />
          {FAMILIES.map((f) => (
            <button key={f} className="chip filter-chip" aria-pressed={family === f} onClick={() => setFamily(f)}>
              {f === 'all' ? 'All families' : f}
            </button>
          ))}
        </div>
        <div className="shelf-grid">
          {filtered.map((asset) => <AssetCard key={asset.id} asset={asset} />)}
        </div>
      </div>
    </main>
  );
}
