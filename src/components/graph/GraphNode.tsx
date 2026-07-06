import type React from 'react';
import { CAPSULES } from '../../core/capsules';
import type { SocketDef, WorkflowNode } from '../../core/types';
import { useStudio } from '../../state/store';
import { CapsuleIcon, Icon } from '../icons';
import { NODE_WIDTH, socketColor } from './wires';

interface Props {
  node: WorkflowNode;
  selected: boolean;
  summary: string;
  onPointerDownHead: (e: React.PointerEvent) => void;
  onSelect: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPortDown: (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => void;
  onPortUp: (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => void;
  /** highlight ports that would accept the in-progress connection */
  candidatePorts: Set<string>;
  invalidPorts: Set<string>;
}

export function GraphNode({
  node, selected, summary, onPointerDownHead, onSelect, onKeyDown,
  onPortDown, onPortUp, candidatePorts, invalidPorts,
}: Props) {
  const def = CAPSULES[node.kind];
  const rows = Math.max(def.inputs.length, def.outputs.length);

  const portClass = (socket: SocketDef, dir: 'in' | 'out') => {
    const key = `${dir}:${socket.id}`;
    let cls = `port ${dir}`;
    if (candidatePorts.has(key)) cls += ' candidate';
    if (invalidPorts.has(key)) cls += ' invalid';
    return cls;
  };

  return (
    <article
      className={`gnode ${selected ? 'selected' : ''}`}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, '--accent': def.accent } as React.CSSProperties}
      role="group"
      aria-label={`${def.title} capsule`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onSelect}
    >
      <div className="gnode-head" onPointerDown={onPointerDownHead}>
        <span className="cap-icon"><CapsuleIcon kind={node.kind} size={15} /></span>
        {def.title}
      </div>
      <div className="gnode-body">
        {Array.from({ length: rows }).map((_, i) => {
          const input = def.inputs[i];
          const output = def.outputs[i];
          return (
            <div className="gnode-row" key={i}>
              {input ? (
                <>
                  <span
                    className={portClass(input, 'in')}
                    style={{ '--port-color': socketColor(input.type), top: '50%', transform: 'translateY(-50%)' } as React.CSSProperties}
                    title={`${input.label} (${input.type})`}
                    onPointerDown={(e) => onPortDown(input, 'in', e)}
                    onPointerUp={(e) => onPortUp(input, 'in', e)}
                  />
                  <span>{input.label}</span>
                </>
              ) : <span />}
              {output ? (
                <>
                  <span className="out">{output.label}</span>
                  <span
                    className={portClass(output, 'out')}
                    style={{ '--port-color': socketColor(output.type), top: '50%', transform: 'translateY(-50%)' } as React.CSSProperties}
                    title={`${output.label} (${output.type})`}
                    onPointerDown={(e) => onPortDown(output, 'out', e)}
                    onPointerUp={(e) => onPortUp(output, 'out', e)}
                  />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      {node.kind === 'imageLoader' ? <ImageThumb node={node} title={def.title} /> : null}
      <div className="gnode-summary" title={summary}>{summary}</div>
    </article>
  );
}

/**
 * Inline img2img thumbnail body for the Load Image capsule. Internal to
 * GraphNode — the component's external props contract is unchanged.
 * stopPropagation keeps pointer/keyboard interaction inside the tile from
 * triggering node drag or the card's move/delete key handling.
 */
function ImageThumb({ node, title }: { node: WorkflowNode; title: string }) {
  const updateParam = useStudio((s) => s.updateParam);
  const image = typeof node.params.image === 'string' ? node.params.image : '';

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateParam(node.id, 'image', String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <div
      className="gnode-thumb"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {image ? (
        <div className="gnode-thumb-preview">
          <img src={image} alt={`${title} preview`} />
          <button
            type="button"
            className="gnode-thumb-clear"
            aria-label="Clear image"
            title="Clear image"
            onClick={(e) => { e.stopPropagation(); updateParam(node.id, 'image', ''); }}
          >
            {Icon.close({ size: 12 })}
          </button>
        </div>
      ) : (
        <label className="gnode-thumb-drop">
          <input
            type="file"
            accept="image/*"
            aria-label={`Upload image for ${title}`}
            onChange={(e) => { onFile(e.target.files?.[0]); e.currentTarget.value = ''; }}
          />
          <span>Drop image here</span>
        </label>
      )}
    </div>
  );
}
