import type React from 'react';
import { CAPSULES } from '../../core/capsules';
import type { SocketDef, WorkflowNode } from '../../core/types';
import { CapsuleIcon } from '../icons';
import { NODE_WIDTH, socketColor } from './wires';
import { ORB_RADIUS } from './graph3d/projection';

/** Canvas-y offset of the chip's top edge below the node origin (under the orb). */
export const CHIP_TOP_OFFSET = ORB_RADIUS * 2 + 12;

interface Props {
  node: WorkflowNode;
  summary: string;
  /** Selecting expands the orb into the full GraphNode card in place. */
  onSelect: () => void;
  /** Existing node keyboard contract (arrows move, Delete removes, Ctrl+D duplicates). */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Same handler contract as GraphNode so orb-to-orb wiring reuses 2D logic. */
  onPortDown: (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => void;
  onPortUp: (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => void;
  candidatePorts: Set<string>;
  invalidPorts: Set<string>;
  /** v0.16: spawn a Render-Space ghost controller for this node (curated field). */
  onSpawnGhost?: () => void;
  /** When set, the ghost button is disabled with this tooltip (empty profile). */
  ghostDisabledReason?: string | null;
  /** True while a ghost already exists for this node (button becomes a no-op label). */
  hasGhost?: boolean;
}

/**
 * CSS3D label chip shown below an orb node (3D 'orbs' style): capsule icon +
 * title + one-line summary, plus mini port dots (inputs left, outputs right)
 * that reuse the existing onPortDown/onPortUp contract so wires can be drawn
 * orb-to-orb WITHOUT expanding. Click (or Enter/Space) expands the node into
 * its full editor card; arrows/Delete/Ctrl+D route the existing keyboard
 * contract.
 */
export function OrbChip({
  node, summary, onSelect, onKeyDown, onPortDown, onPortUp, candidatePorts, invalidPorts,
  onSpawnGhost, ghostDisabledReason, hasGhost,
}: Props) {
  const def = CAPSULES[node.kind];

  const portClass = (socket: SocketDef, dir: 'in' | 'out') => {
    const key = `${dir}:${socket.id}`;
    let cls = `orb-port ${dir}`;
    if (candidatePorts.has(key)) cls += ' candidate';
    if (invalidPorts.has(key)) cls += ' invalid';
    return cls;
  };

  const portDot = (socket: SocketDef, dir: 'in' | 'out') => (
    <span
      key={`${dir}:${socket.id}`}
      className={portClass(socket, dir)}
      style={{ '--port-color': socketColor(socket.type) } as React.CSSProperties}
      title={`${socket.label} (${socket.type})`}
      aria-label={`${socket.label} ${dir === 'in' ? 'input' : 'output'} (${socket.type})`}
      // preventDefault keeps the press from focusing/expanding the chip so
      // orb-to-orb wiring works without opening the card; the shared
      // onPortDown/onPortUp handlers stopPropagation themselves.
      onPointerDown={(e) => { e.preventDefault(); onPortDown(socket, dir, e); }}
      onPointerUp={(e) => onPortUp(socket, dir, e)}
      onClick={(e) => e.stopPropagation()}
    />
  );

  const onChipKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
      return;
    }
    onKeyDown(e);
  };

  return (
    <div
      className="orb-chip"
      style={{ left: node.x, top: node.y + CHIP_TOP_OFFSET, width: NODE_WIDTH, '--accent': def.accent } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`${def.title} capsule — press Enter to expand`}
      onClick={onSelect}
      onKeyDown={onChipKey}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="orb-chip-head">
        <span className="orb-chip-icon" aria-hidden="true"><CapsuleIcon kind={node.kind} size={12} /></span>
        <span className="orb-chip-title">{def.title}</span>
      </div>
      <div className="orb-chip-summary" title={summary}>{summary}</div>
      {onSpawnGhost ? (
        <button
          type="button"
          className="orb-chip-ghost-btn"
          disabled={!!ghostDisabledReason || hasGhost}
          title={ghostDisabledReason
            ? ghostDisabledReason
            : hasGhost
              ? 'A 3D controller already exists for this node'
              : 'Control this node in 3D (curated field, not a trained model)'}
          onClick={(e) => { e.stopPropagation(); onSpawnGhost(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {hasGhost ? 'Controlling in 3D' : 'Control in 3D'}
        </button>
      ) : null}
      {def.inputs.length > 0 || def.outputs.length > 0 ? (
        <div className="orb-chip-ports">
          <div className="orb-chip-ports-in" aria-label="Inputs">
            {def.inputs.map((socket) => portDot(socket, 'in'))}
          </div>
          <div className="orb-chip-ports-out" aria-label="Outputs">
            {def.outputs.map((socket) => portDot(socket, 'out'))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
