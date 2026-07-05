import { useCallback, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { CAPSULES, CAPSULE_KINDS } from '../../core/capsules';
import { canConnect } from '../../core/workflow';
import type { CapsuleKind, SocketDef } from '../../core/types';
import { useStudio } from '../../state/store';
import { CapsuleIcon } from '../icons';
import { GraphNode } from './GraphNode';
import { edgeEndpoints, socketColor, socketPoint, wirePath, type Point } from './wires';

interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
}
interface WireDraft {
  fromNode: string;
  fromSocket: SocketDef;
  cursor: Point;
}

function nodeSummary(kind: CapsuleKind, params: Record<string, unknown>): string {
  switch (kind) {
    case 'prompt': return String(params.positive ?? '').slice(0, 60) || 'No prompt';
    case 'model': return params.assetId ? String(params.assetId) : 'No checkpoint';
    case 'loraRack': return `${Array.isArray(params.slots) ? params.slots.length : 0} LoRA slots`;
    case 'sampler': return `${params.sampler} | ${params.steps} steps | cfg ${params.cfg}`;
    case 'video': return params.enabled ? `${params.frameCount} frames @ ${params.fps} fps | ${params.cameraMotion}` : 'Disabled';
    case 'canvas': return `${params.width}x${params.height} x${params.batch}`;
    case 'control': return params.enabled ? `${params.mode} @ ${params.strength}` : 'Disabled';
    default: return CAPSULES[kind].description;
  }
}

export function GraphView() {
  const workflow = useStudio((s) => s.workflow);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const selectNode = useStudio((s) => s.selectNode);
  const moveNodeTo = useStudio((s) => s.moveNodeTo);
  const connectSockets = useStudio((s) => s.connectSockets);
  const disconnectEdge = useStudio((s) => s.disconnectEdge);
  const addCapsule = useStudio((s) => s.addCapsule);
  const duplicateCapsule = useStudio((s) => s.duplicateCapsule);
  const autoLayoutGraph = useStudio((s) => s.autoLayoutGraph);
  const removeCapsule = useStudio((s) => s.removeCapsule);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ tx: 24, ty: 16, scale: 0.85 });
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const [wire, setWire] = useState<WireDraft | null>(null);

  const toCanvas = useCallback((clientX: number, clientY: number): Point => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const ox = rect?.left ?? 0;
    const oy = rect?.top ?? 0;
    return { x: (clientX - ox - view.tx) / view.scale, y: (clientY - oy - view.ty) / view.scale };
  }, [view]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const next = Math.min(2, Math.max(0.4, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    // zoom toward cursor
    const k = next / view.scale;
    setView({ scale: next, tx: mx - (mx - view.tx) * k, ty: my - (my - view.ty) * k });
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('graph-stage')) return;
    selectNode(null);
    setPan({ x: e.clientX - view.tx, y: e.clientY - view.ty });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pan) {
      setView((v) => ({ ...v, tx: e.clientX - pan.x, ty: e.clientY - pan.y }));
      return;
    }
    if (drag) {
      const p = toCanvas(e.clientX, e.clientY);
      moveNodeTo(drag.nodeId, Math.round(p.x - drag.offsetX), Math.round(p.y - drag.offsetY));
      return;
    }
    if (wire) {
      setWire({ ...wire, cursor: toCanvas(e.clientX, e.clientY) });
    }
  };

  const endInteractions = () => {
    setPan(null);
    setDrag(null);
    setWire(null);
  };

  const onHeadDown = (nodeId: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    selectNode(nodeId);
    const node = workflow.nodes.find((n) => n.id === nodeId)!;
    const p = toCanvas(e.clientX, e.clientY);
    setDrag({ nodeId, offsetX: p.x - node.x, offsetY: p.y - node.y });
  };

  const onPortDown = (nodeId: string) => (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => {
    e.stopPropagation();
    if (dir !== 'out') return; // wires are drawn from outputs to inputs
    const node = workflow.nodes.find((n) => n.id === nodeId)!;
    setWire({ fromNode: nodeId, fromSocket: socket, cursor: socketPoint(node, socket.id, 'out') });
  };

  const onPortUp = (nodeId: string) => (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => {
    if (!wire || dir !== 'in') return;
    e.stopPropagation();
    connectSockets({ node: wire.fromNode, socket: wire.fromSocket.id }, { node: nodeId, socket: socket.id });
    setWire(null);
  };

  const onNodeKey = (nodeId: string) => (e: React.KeyboardEvent) => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateCapsule(nodeId);
      return;
    }
    const step = e.shiftKey ? 1 : 8;
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveNodeTo(nodeId, node.x - step, node.y); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveNodeTo(nodeId, node.x + step, node.y); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveNodeTo(nodeId, node.x, node.y - step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveNodeTo(nodeId, node.x, node.y + step); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCapsule(nodeId); }
  };

  // Ports that would (in)validly accept the in-progress wire.
  const candidateFor = (nodeId: string): { ok: Set<string>; bad: Set<string> } => {
    const ok = new Set<string>();
    const bad = new Set<string>();
    if (!wire || wire.fromNode === nodeId) return { ok, bad };
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok, bad };
    for (const inp of CAPSULES[node.kind].inputs) {
      const res = canConnect(workflow, { node: wire.fromNode, socket: wire.fromSocket.id }, { node: nodeId, socket: inp.id });
      (res.ok ? ok : bad).add(`in:${inp.id}`);
    }
    return { ok, bad };
  };

  const addAtCenter = (kind: CapsuleKind) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const c = toCanvas((rect?.left ?? 0) + (rect?.width ?? 600) / 2, (rect?.top ?? 0) + (rect?.height ?? 400) / 2);
    addCapsule(kind, Math.round(c.x - 120), Math.round(c.y - 60));
  };

  const fitView = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || workflow.nodes.length === 0) return;
    const minX = Math.min(...workflow.nodes.map((n) => n.x));
    const minY = Math.min(...workflow.nodes.map((n) => n.y));
    const maxX = Math.max(...workflow.nodes.map((n) => n.x + 260));
    const maxY = Math.max(...workflow.nodes.map((n) => n.y + 180));
    const scale = Math.max(0.4, Math.min(1.2, Math.min((rect.width - 80) / (maxX - minX), (rect.height - 120) / (maxY - minY))));
    setView({ scale, tx: 40 - minX * scale, ty: 70 - minY * scale });
  };

  const paletteKinds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CAPSULE_KINDS;
    return CAPSULE_KINDS.filter((kind) => `${CAPSULES[kind].title} ${CAPSULES[kind].description}`.toLowerCase().includes(q));
  }, [query]);

  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId);

  return (
    <div
      ref={wrapRef}
      className={`graph-wrap ${pan ? 'panning' : ''}`}
      aria-label="Graph View"
      onWheel={onWheel}
      onPointerDown={onBgPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endInteractions}
      onPointerLeave={endInteractions}
      style={{ backgroundPosition: `${view.tx * 0.5}px ${view.ty * 0.5}px` }}
    >
      {/* Parallax ambience: drifts slower than nodes for depth + bloom. */}
      <div className="graph-glow" style={{ transform: `translate(${view.tx * 0.3}px, ${view.ty * 0.3}px)` }} />
      <div className="graph-toolbar" role="toolbar" aria-label="Add capsule">
        <input
          className="graph-palette-search"
          value={query}
          placeholder="Search nodes"
          aria-label="Search nodes"
          onChange={(event) => setQuery(event.target.value)}
        />
        {paletteKinds.map((kind) => (
          <button key={kind} className="btn" type="button" onClick={() => addAtCenter(kind)} title={`Add ${CAPSULES[kind].title}`}>
            <CapsuleIcon kind={kind} size={14} /> {CAPSULES[kind].title}
          </button>
        ))}
        <span className="graph-toolbar-sep" />
        <button className="btn" type="button" disabled={!selectedNode} onClick={() => selectedNode && duplicateCapsule(selectedNode.id)} title="Duplicate selected node">
          Duplicate
        </button>
        <button className="btn" type="button" disabled={!selectedNode} onClick={() => selectedNode && removeCapsule(selectedNode.id)} title="Delete selected node">
          Delete
        </button>
        <button className="btn" type="button" onClick={() => { autoLayoutGraph(); requestAnimationFrame(fitView); }} title="Auto-layout graph">
          Auto-layout
        </button>
        <button className="btn" type="button" onClick={() => setView({ tx: 24, ty: 16, scale: 0.85 })} title="Reset view">
          Reset
        </button>
        <button className="btn" type="button" onClick={fitView} title="Fit graph">
          Fit
        </button>
      </div>

      <div className="graph-stage" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
        <svg className="graph-edges" width="4000" height="3000">
          {workflow.edges.map((edge) => {
            const pts = edgeEndpoints(workflow, edge.from, edge.to);
            if (!pts) return null;
            const type = CAPSULES[workflow.nodes.find((n) => n.id === edge.from.node)!.kind]
              .outputs.find((s) => s.id === edge.from.socket)?.type ?? 'image';
            return (
              <path
                key={edge.id}
                className="wire"
                d={wirePath(pts.from, pts.to)}
                stroke={socketColor(type)}
                strokeWidth={2}
                fill="none"
                opacity={0.85}
                style={{ color: socketColor(type) }}
                onClick={() => disconnectEdge(edge.id)}
              >
                <title>Click to disconnect</title>
              </path>
            );
          })}
          {wire ? (() => {
            const node = workflow.nodes.find((n) => n.id === wire.fromNode)!;
            const from = socketPoint(node, wire.fromSocket.id, 'out');
            return <path d={wirePath(from, wire.cursor)} stroke={socketColor(wire.fromSocket.type)} strokeWidth={2} fill="none" strokeDasharray="5 4" />;
          })() : null}
        </svg>

        {workflow.nodes.map((node) => {
          const { ok, bad } = candidateFor(node.id);
          return (
            <GraphNode
              key={node.id}
              node={node}
              selected={selectedNodeId === node.id}
              summary={nodeSummary(node.kind, node.params)}
              onPointerDownHead={onHeadDown(node.id)}
              onSelect={() => selectNode(node.id)}
              onKeyDown={onNodeKey(node.id)}
              onPortDown={onPortDown(node.id)}
              onPortUp={onPortUp(node.id)}
              candidatePorts={ok}
              invalidPorts={bad}
            />
          );
        })}
      </div>

      <div className="graph-hint">
        Drag headers to move | drag an output port to an input to wire | click a wire to remove | scroll to zoom |
        {' '}{workflow.nodes.length} capsules, {workflow.edges.length} links
      </div>
    </div>
  );
}
