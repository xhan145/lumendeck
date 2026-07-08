import { useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import { GraphView } from './GraphView';
import { Graph3DView } from './Graph3DView';
import { ConstellationCommand } from '../creative/ConstellationCommand';
import '../../styles/graph3d.css';

/** One-time probe: can this machine create a WebGL context at all? */
function detectWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    if (!gl) return false;
    // Release the probe context immediately: browsers cap live WebGL contexts,
    // and a leaked probe per workspace remount (doubled under StrictMode)
    // would eventually evict — or fail — the real renderer's context.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function detectReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Graph workspace: hosts the 2D ⇄ 3D toggle and mounts either the classic 2D
 * GraphView (byte-identical, untouched) or the WebGL Graph3DView.
 *
 * Mode preference persists via appSettings.graphMode. Default is '3d', except
 * prefers-reduced-motion defaults to '2d'; if WebGL is unavailable (or context
 * creation fails at runtime) we fall back to 2D with a small note — 3D stays
 * one click away either way.
 */
export function GraphWorkspace() {
  const graphMode = useStudio((s) => s.appSettings.graphMode);
  const updateAppSettings = useStudio((s) => s.updateAppSettings);
  const [contextFailed, setContextFailed] = useState(false);
  const webglOk = useMemo(detectWebGL, []);
  const reducedMotion = useMemo(detectReducedMotion, []);

  const wanted = graphMode ?? (reducedMotion ? '2d' : '3d');
  const canUse3d = webglOk && !contextFailed;
  const mode = canUse3d ? wanted : '2d';

  return (
    <div className="graph-workspace">
      {mode === '3d'
        ? <Graph3DView onContextFailed={() => setContextFailed(true)} />
        : <GraphView />}
      <div className="graph-mode-toggle" role="group" aria-label="Graph renderer mode">
        <button
          type="button"
          className="btn"
          aria-pressed={mode === '2d'}
          title="Classic 2D editor"
          onClick={() => updateAppSettings({ graphMode: '2d' })}
        >
          2D
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={mode === '3d'}
          disabled={!canUse3d}
          title={canUse3d ? 'WebGL 3D scene' : '3D unavailable (WebGL not supported)'}
          onClick={() => updateAppSettings({ graphMode: '3d' })}
        >
          3D
        </button>
      </div>
      {wanted === '3d' && !canUse3d ? (
        <div className="graph3d-note" role="note">
          3D view unavailable (WebGL could not start) — showing the classic 2D editor.
        </div>
      ) : null}
      <ConstellationCommand />
    </div>
  );
}
