import { CAPSULES } from '../../core/capsules';
import { useStudio } from '../../state/store';
import { ParamField } from './ParamField';

/**
 * Renders the editable parameter controls for a capsule node. Shared by the
 * Recipe View cards and the Graph View inspector so both edit the SAME workflow
 * node params through one implementation.
 */
export function CapsuleParams({ nodeId, limit }: { nodeId: string; limit?: number }) {
  const node = useStudio((s) => s.workflow.nodes.find((n) => n.id === nodeId));
  const shelf = useStudio((s) => s.shelf);
  const updateParam = useStudio((s) => s.updateParam);
  if (!node) return null;

  const checkpoints = shelf.filter((a) => a.assetType === 'checkpoint');

  const def = CAPSULES[node.kind];
  const params = limit ? def.params.slice(0, limit) : def.params;

  return (
    <div className="recipe-fields">
      {params.map((param) => {
        if (node.kind === 'model' && param.id === 'assetId') {
          return (
            <ParamField
              key={param.id}
              def={{
                ...param,
                kind: 'select',
                options: [
                  { value: '', label: 'Choose a checkpoint…' },
                  ...checkpoints.map((c) => ({
                    value: c.id,
                    label: `${c.name} (${c.family})${c.installed ? '' : ' — not installed'}`,
                  })),
                ],
              }}
              value={node.params[param.id]}
              onChange={(v) => updateParam(node.id, param.id, v)}
            />
          );
        }
        if (node.kind === 'loraRack' && param.id === 'slots') {
          const count = Array.isArray(node.params.slots) ? node.params.slots.length : 0;
          return (
            <p key={param.id} className="field-help">
              {count} LoRA slot{count === 1 ? '' : 's'} — manage them in the LoRA Rack panel.
            </p>
          );
        }
        return (
          <ParamField
            key={param.id}
            def={param}
            value={node.params[param.id]}
            onChange={(v) => updateParam(node.id, param.id, v)}
          />
        );
      })}
    </div>
  );
}
