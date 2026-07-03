# LumenDeck v0.3 — ROAR-style Material 3 Redesign (2026-07-03)

Re-skin LumenDeck to the "ROAR" design language: Material 3, dark-only, expressive-yet-minimal,
with a left navigation rail, a glowing brand mark, MD3 tokens, and responsive layout. Token-centered
so the whole app re-themes from one place. Keeps the LumenDeck name and image-studio product.

> Approved via Superpowers brainstorming; user chose Restyle-keep-LumenDeck + new glowing mark +
> ROAR palette, and authorized autonomous execution ("approve and go autonomously"). Progress
> streaming and better real models are separate specs (not in scope here).

## Goals
1. Material 3 token system (color/shape/elevation/motion/type) driving the whole UI from `tokens.css`.
2. Left MD3 **navigation rail** for the four views + Settings, replacing the top tabs.
3. New **glowing LumenDeck mark** (deck/lumen motif, not "R") + refreshed favicon/app icon.
4. **Responsive** at 1440/1024/768/≤640 with no horizontal scroll.
5. Fold-ins: single-source **version number** (0.2.0→0.3.0) shown in the top bar; bridge-on-launch as default.

## Non-goals
Progress streaming; SDXL/SD3 + real LoRA (separate specs). No new views/features — this is visual/structural only.

## Design tokens (Material 3 dark, from the approved mockup)
Remap the existing `--ld-*` variables (so components need no change) onto an MD3 layer in
`src/styles/tokens.css`:

| Token | Value | Role |
|---|---|---|
| `--md-primary` | `#1A73E8` | primary (selection, active nav, links) |
| `--md-on-primary` | `#FFFFFF` | |
| `--md-secondary` | `#FF8A00` | hero accent (Render CTA, focus glow) |
| `--md-bg` | `#0E1218` | app background / rail / canvas |
| `--md-surface` | `#12161D` | panels |
| `--md-surface-2` | `#1A1F29` | cards |
| `--md-surface-3` | `#222835` | elevated cards/menus |
| `--md-on-surface` | `#E6E1E5` | text |
| `--md-on-surface-dim` | `#A0A7B4` | secondary text (AA on surface) |
| `--md-outline` | `#2C313A` | borders/dividers |
| `--md-error` | `#FF5C5C` | error/danger |
| `--md-success` | `#39D98A` | success/ok |

Aliases: `--ld-bg→--md-bg`, `--ld-surface/-2/-3→md surfaces`, `--ld-border→--md-outline`,
`--ld-text→--md-on-surface`, `--ld-text-dim→--md-on-surface-dim`, `--ld-accent→--md-primary`,
`--ld-accent-2→#4C8DF0` (primary-light for gradients), `--ld-ok→--md-success`, `--ld-danger→--md-error`,
`--ld-warn→--md-secondary`. Capsule/socket accents retuned to an MD3 tonal set
(prompt=blue, model=purple `#B794F6`, lora=green `#39D98A`, control=orange `#FF8A00`,
sampler=cyan `#34D6F4`, canvas=violet `#A78BFA`, queue=amber `#FFB27A`, export=mint `#7DF0C0`,
manifest=slate `#9FB0C7`) — always paired with label + icon, never color alone.

Shape: `--rad-1:4px --rad-2:8px --rad-3:12px`. Elevation: `--elev-0..3` shadows (0/1/3/6dp).
Motion: `--ease-standard: cubic-bezier(0.2,0,0,1)`, `--ease-decelerate: cubic-bezier(0,0,0,1)`,
durations 150/240/320ms; all wrapped by the existing `prefers-reduced-motion` reset.
Focus ring: 2px `--md-primary` with a soft outer glow; `.btn.primary` (Render) becomes a filled
**Secondary/orange** button with an orange glow on hover.

## Typography
MD3 type-scale utility classes/vars on the existing **local Inter** stack (offline, no CDN):
Display 32/Headline 24/Title 18/Body 15/Label 12 with MD3 weights (600 headings, 500 labels, 400 body)
and label letter-spacing 0.1px. JetBrains Mono stack retained for seeds/hashes. (Roboto Flex swap is
out of scope — Inter reads Material-adjacent and stays local.)

## Layout / components
- **App shell** (`src/App.tsx` + `app.css`): grid becomes `topbar / [rail | main | right-rail]`.
  - **Navigation rail** (`src/components/shell/NavRail.tsx`, new): 76px, icon+label items for
    Recipe/Graph/Shelf/Gallery, active item shows an MD3 pill indicator in `--md-primary`; Settings
    pinned bottom (opens existing inspector/settings surface — reuse, no new view). `role="navigation"`,
    `aria-current` on active, keyboard operable.
  - **Top app bar**: glowing mark + "LumenDeck" wordmark + version (from `APP_VERSION`), bridge status
    + health chips (existing components, restyled).
  - **Right controls rail**: existing panels reworked as MD3 elevated cards; **Render** = filled
    orange hero button.
- **Components** get MD3 treatment via shared classes in `app.css` (cards elevation/radius, filled/tonal
  buttons, menus, chips). No component API changes — purely class/token updates. Extract the shared
  card/button rules so all panels inherit them (DRY).
- **Logo** (`src/components/icons.tsx`): replace `Icon.logo` with a glowing deck mark (SVG `filter`
  drop-shadow in `--md-secondary`/`--md-primary`); update `index.html` favicon to an inline SVG data URI;
  regenerate `src-tauri/icon-source.png` + `npm run tauri icon` for the MSI (best-effort).

## Responsiveness
Breakpoints: **≥1280** full three-column; **1024–1279** right rail narrows; **768–1023** right rail
becomes a bottom drawer/collapsible, rail stays; **≤767** rail collapses to icon-only, right rail hidden
behind a toggle. Graph canvas remains pannable; no horizontal body scroll at any width.

## Fold-ins
- **Version**: delete the hardcoded `v0.1.0` in `App.tsx`; render `APP_VERSION` from
  `src/state/storeConstants.ts`. Bump `APP_VERSION`, `package.json`, `tauri.conf.json`,
  `src-tauri/Cargo.toml` to **0.3.0**.
- **Bridge-on-launch**: keep the Vite plugin + Tauri sidecar (already default); no behavior change,
  just confirm it still starts after the shell refactor.

## Testing / verification
- `tsc --noEmit` clean; existing **70 Vitest** tests stay green (no logic change).
- Preview screenshots at 1440 / 1024 / 768 / 375; confirm nav rail, orange Render hero, glowing logo,
  no horizontal scroll, visible focus rings.
- Spot-check AA contrast for `--md-on-surface-dim` on surfaces and orange-on-surface for the CTA.

## Acceptance criteria
1. Whole UI renders in the MD3 dark palette from tokens; changing `tokens.css` re-themes everything.
2. Left navigation rail drives the four views; active state clear; keyboard + aria correct.
3. Render is a filled orange hero; focus rings visible; glowing LumenDeck mark in the top bar + favicon.
4. Responsive at all four breakpoints, no horizontal scroll.
5. Version shows 0.3.0 from a single source. 70 tests + tsc green.
