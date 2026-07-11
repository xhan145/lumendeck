import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import { resolveCssColor } from '../graph/graph3d/scene';
import type { EffectsLevel } from '../graph/graph3d/quality';
import { buildLumenConstellation } from './data';
import { canGoBack, goBack, indexConstellation, initialSelection, selectNode, type SelectionState } from './selection';
import { ConstellationScene } from './ConstellationScene';
import { ConstellationOverlay } from './ConstellationOverlay';
import { ConstellationFallback } from './ConstellationFallback';
import '../../styles/constellation.css';

/**
 * The Open Constellation view: LumenDeck's capabilities as an explorable
 * universe. The selected node is a shader-driven central planet; children
 * orbit as satellites; clicking one promotes it. The world argues the point
 * the overlay states — FREE. OPEN. YOURS. — with energy that only ever
 * radiates outward and no locked boundary anywhere.
 *
 * This container owns: real store data → tree building, selection + history,
 * WebGL/reduced-motion detection, the fallback/list mode, and the overlay.
 * The 3D scene stays a controlled component (centerId in, onPromote out).
 */

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    // Never leak probe contexts (StrictMode runs this twice in dev).
    (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function ConstellationView() {
  const brains = useStudio((s) => s.creative.brains);
  const recipes = useStudio((s) => s.creative.recipes);
  const gallery = useStudio((s) => s.gallery);
  const collections = useStudio((s) => s.collections);
  const galleryReady = useStudio((s) => s.galleryReady);
  const graph3dEffects = useStudio((s) => s.appSettings.graph3dEffects ?? 'standard');

  const reducedMotion = useReducedMotion();
  const [webglOk] = useState(detectWebGL);
  const [contextFailed, setContextFailed] = useState(false);
  const [listMode, setListMode] = useState(false);

  const root = useMemo(() => {
    const el = typeof document !== 'undefined' ? document.documentElement : null;
    const resolve = el ? (c: string) => resolveCssColor(c, el) : (c: string) => c;
    const collectionCounts = collections.map((c) => ({
      id: c.id,
      name: c.name,
      count: gallery.filter((g) => g.collectionId === c.id).length,
    }));
    return buildLumenConstellation({
      brains,
      recipes,
      galleryCount: galleryReady ? gallery.length : 0,
      collections: galleryReady ? collectionCounts : [],
      resolve,
    });
  }, [brains, recipes, gallery, collections, galleryReady]);

  const index = useMemo(() => indexConstellation(root), [root]);
  const [selection, setSelection] = useState<SelectionState>(() => initialSelection('lumen'));
  // A rebuilt tree can drop a live node (e.g. a collection was deleted) — snap
  // home rather than pointing the camera at a ghost.
  useEffect(() => {
    if (!index.has(selection.currentId)) setSelection(initialSelection(root.id));
  }, [index, selection.currentId, root.id]);

  const currentNode = index.get(selection.currentId) ?? root;
  const satelliteCount = currentNode.children?.length ?? 0;

  const promote = useCallback(
    (id: string) => setSelection((s) => selectNode(s, id, index)),
    [index],
  );
  const back = useCallback(() => setSelection((s) => goBack(s)), []);

  const canvasMode = webglOk && !contextFailed && !listMode;
  const quality: EffectsLevel = graph3dEffects;

  return (
    <div className="constellation-view" aria-label="Open Constellation">
      {canvasMode ? (
        <ConstellationScene
          root={root}
          centerId={selection.currentId}
          onPromote={promote}
          reducedMotion={reducedMotion}
          quality={quality}
          onContextFailed={() => setContextFailed(true)}
        />
      ) : (
        <ConstellationFallback
          root={root}
          currentId={selection.currentId}
          onSelect={promote}
          reason={
            !webglOk || contextFailed
              ? '3D is unavailable on this device — here is the same constellation as a list.'
              : undefined
          }
        />
      )}
      <ConstellationOverlay
        node={currentNode}
        satelliteCount={satelliteCount}
        canGoBack={canGoBack(selection)}
        onBack={back}
      />
      {webglOk && !contextFailed ? (
        <button
          type="button"
          className="btn constellation-list-toggle"
          onClick={() => setListMode((v) => !v)}
          aria-pressed={listMode}
          title={listMode ? 'Return to the 3D constellation' : 'View the constellation as an accessible list'}
        >
          {listMode ? 'Orbit view' : 'List view'}
        </button>
      ) : null}
    </div>
  );
}
