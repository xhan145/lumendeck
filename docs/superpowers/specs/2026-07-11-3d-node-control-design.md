# 3D Node Control — a node's position as a physical control surface

**Status:** approved (brainstorm 2026-07-11), autonomous execution authorized.
**Branch:** `feature/3d-volumetric-spacetime` (extends the volumetric spacetime PR #44).

## Goal

Let a node move along **every** world axis, and make that movement *do* something:
its position drives the spacetime physics (fabric + particles), and — under a
distinct control mode — edits the node's parameters. A node becomes a 3D control
surface where **where it sits** changes both the look and the result.

Three user-approved decisions frame the design:
- **Effect** = physics **and** parameters.
- **Interaction** = a modifier / control-mode keeps *layout* and *value-editing*
  from clobbering each other.
- **Height = mass**: lifting a node makes it warp spacetime more.

## Interaction model (three gestures on a node)

Node drag today = pointer ray onto the node's z-plane → `moveNodeTo(x, y)`
(horizontal + vertical). World depth (z) is locked to a function of x
(`zFromNode(x) = -x·0.12`). That is the only axis that isn't already free.

**Drag surface.** Today a node is only movable via the *selected* node's card
header (`onHeadDown`); a non-selected **orb** can be clicked-to-expand or
ring-dragged, but not moved. This feature makes **orbs directly draggable to
move** — the natural way to arrange a 3D constellation. In `onBgPointerDown`, an
orb pick (after the existing ghost/ring picks, before orbit/pan) starts a node
drag; a release **without** passing the click-slop still **expands** the node
(click-to-expand preserved). The selected node's card-header drag honors the
same gestures.

| Gesture | Effect |
| --- | --- |
| **Drag** (default) | Horizontal + vertical layout, exactly as today. Vertical = **height → mass** (physics follows layout). |
| **Shift + drag** | **Depth (z)** — the newly-freed third axis. Vertical pointer delta pushes the node toward / away from the camera; persisted as `node.z`. |
| **Alt + drag**, or the per-node **"3D Control" toggle** on the orb chip | **Control mode** — the drag maps the node's field-profile axes to its parameters (the Ghost's exact machinery). Edits commit live; on pointer-up the node **springs back to its layout home** so value-editing never disturbs layout. |

Rationale: default drag is unchanged (no muscle-memory break); Shift adds the
missing depth axis; Alt/toggle reuses the proven Ghost field mapping for values.
The spring-back is what makes control-mode non-destructive to layout — chosen
over "node stays where dragged" precisely to keep the two intents distinct.
The mode is captured at pointer-down from the held modifier (or the per-node
toggle), so a single drag is one coherent mode start-to-finish.

## Axis → outcome map

- **Horizontal (x):** well position on the fabric (as today).
- **Depth (z, new):** well position in depth on the fabric. Frees the node from
  the per-column z rule; persisted.
- **Height (world y) → mass:** a mass multiplier, **neutral (×1) at a reference
  plane** (world y = 0, the layout midline) and rising as the node is lifted
  (clamped to a sane min/max). Mass scales the node's gravity well **depth and
  sigma** on top of its parameter-derived weight — so the fabric dips deeper and
  wider, and (because the particle field's gravity grid is built from the same
  wells) dust is pulled harder into a lifted node. A light orb **scale** bump
  echoes the mass; the activity-luminosity emissive is left untouched (separate
  encoding — no channel conflict).
- **Control mode (x/y/z):** the node's `fieldProfile` parameter bundles, via
  `applyField` — the same axis→param semantics the Ghost uses.

## Architecture (small isolated units; reuse over new)

**New pure module `graph3d/nodeSpace.ts`** — the single source of a node's 3D
placement, no DOM / no three:
- `nodeDepth(node): number` = `node.z ?? zFromNode(node.x)` (backward-compatible
  depth; the only place the z-fallback lives).
- `massFromHeight(worldY): number` — the mass multiplier (neutral at reference,
  clamped, monotonic in height). Pure + unit-tested.
- All projection helpers that currently call `zFromNode(node.x)` directly
  (`worldFromNode`, `socketWorldPoint`, `orbWorldCenter`) route depth through
  `nodeDepth(node)` instead, so freeing z is a one-line change everywhere.

**`fabric.ts` `packWells`** gains a per-node mass multiplier from height: each
well's `depth` and `sigma` scale by `massFromHeight(nodeWorldY)`. Pure, mirrors
the existing `fabricDisplacement`/`packWells` tests. The particle gravity grid is
rebuilt from these wells already, so particle response comes for free.

**Schema + store:** add optional `z?: number` to `WorkflowNode` (additive,
schemaVersion unchanged — old saves have no `z` and fall back to
`zFromNode(x)`). New store action `setNodeDepth(nodeId, z)` committing like
`moveNodeTo`. `nodeMeta` "touch" fires on depth/param edits as with any edit.

**Control mode reuses the Ghost:** the node-drag handler in `Graph3DView` gains a
`mode: 'layout' | 'depth' | 'control'` on its drag ref (from the modifier / toggle).
- `layout` → `moveNodeTo` (unchanged).
- `depth` → `setNodeDepth` from pointer-delta.
- `control` → `worldToFieldPos` + `applyField` → `updateParam` (exactly the Ghost
  drag path), then restore the node's home position on pointer-up.
No new field logic; `Graph3DView` gets wiring, not a new subsystem.

**Per-node "3D Control" toggle:** a small button on the orb chip (mirrors the
existing "Control in 3D" ghost-spawn button), disabled for nodes without a
field profile (`hasProfile` false) — same rule the ghost button uses.

## Persistence

Chosen approach: **optional `z?: number` on `WorkflowNode`**. Additive,
backward-compatible, zero migration (matches the existing "z is a view concern,
derived from x" contract — we now allow an explicit override). Height persists
already (it is `node.y`). Control-mode edits persist as ordinary param writes.
*Rejected:* session-only 3D offsets (loses placement on reload) and a full
`{x,y,z}` schemaVersion 2 (needless migration).

## Accessibility & safety

- Reduced-motion is unaffected — this is interaction, not ambient animation. The
  height→well response rides the existing effects-tier gating (no fabric ⇒ no
  visible mass effect, but the value edits still apply).
- Control-mode edits go through `updateParam` (undo-safe, clamped to param range).
- No per-frame allocation added; `packWells` stays O(nodes) and runs on commit,
  not per frame.
- WebGL-fail 2D fallback intact (depth/mass are 3D-only; the 2D editor ignores
  `node.z`, which is harmless).

## Testing

- `nodeSpace`: `nodeDepth` returns `node.z` when set, `zFromNode(x)` when not;
  `massFromHeight` is ×1 at the reference, monotonic in height, clamped at the
  extremes.
- `packWells` with height: a lifted node yields a deeper + wider well than the
  same node at the reference; a node at the reference matches today's output
  (regression guard).
- Control-mode mapping: a drag delta through `worldToFieldPos` + `applyField`
  produces the expected param patch (reuse the ghost test patterns).
- Backward-compat: a node with no `z` projects at `zFromNode(x)` (existing saves
  render identically); `sanitize`/hydrate accepts and round-trips `z`.
- Store: `setNodeDepth` commits, is undoable, and touches `nodeMeta`.

## Out of scope / non-goals

- Not replacing the Ghost controller (record/anchors/streaming stay as-is; this
  reuses its field math only).
- No new per-frame simulation; mass changes ride the existing well/particle path.
- No change to the 2D editor's behavior.

## Known risks

- Height→mass reinterprets very tall existing layouts as a gentle top-heavier
  mass gradient. Mitigated by a modest gain + neutral reference; the gain is a
  single tunable constant.
- Modifier discoverability (Shift = depth, Alt = control): the per-node toggle
  covers control-mode discoverability; depth is a power-user gesture. Acceptable
  for a first cut; a HUD hint can be added later.
