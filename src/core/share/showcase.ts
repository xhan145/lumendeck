/**
 * Pure, DOM-free generator for the shareable **Showcase**: a single
 * self-contained HTML document (media inlined as `data:` URLs, CSS/JS inlined,
 * the `.lumen` project embedded as base64) that opens in any browser with no
 * install and no network. Mirrors the `zip.ts`/`releasePack.ts` pure-module
 * pattern — deterministic and unit-testable.
 */

export interface ShowcaseItem {
  /** base64 `data:` URL for the render (image or video). */
  dataUrl: string;
  mediaType: 'image' | 'video';
  caption?: string;
}

export interface ShowcaseProvenance {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  seed?: number;
  /** extra display rows (sampler/canvas/etc.) already stringified by the caller. */
  params?: { label: string; value: string }[];
  recipeName?: string;
}

export interface LumenEmbed {
  /** base64 of the serialized `.lumen` JSON. */
  base64: string;
  filename: string;
}

export interface ShowcaseInput {
  title: string;
  items: ShowcaseItem[];
  provenance: ShowcaseProvenance;
  lumen?: LumenEmbed;
  constellationSvg?: string;
  /** drop videos to a labeled placeholder (keeps the file small). */
  posterOnly?: boolean;
  /** include the "Made with LumenDeck" footer (default true). */
  footer?: boolean;
}

export interface ShowcaseResult {
  html: string;
  bytes: number;
  oversized: boolean;
}

/** Above this the UI should offer poster-only mode rather than emit a huge file. */
export const SHOWCASE_MAX_BYTES = 50 * 1024 * 1024;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function placeholder(label: string): string {
  return `<div class="ph" role="img" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</div>`;
}

function renderItem(item: ShowcaseItem, posterOnly: boolean): string {
  const cap = item.caption ? `<figcaption>${escapeHtml(item.caption)}</figcaption>` : '';
  if (!item.dataUrl) return `<figure class="media">${placeholder('Media unavailable')}${cap}</figure>`;
  if (item.mediaType === 'video') {
    if (posterOnly) {
      return `<figure class="media">${placeholder('Video unavailable in poster-only mode (kept out to shrink the file)')}${cap}</figure>`;
    }
    return `<figure class="media"><video src="${item.dataUrl}" controls loop muted playsinline></video>${cap}</figure>`;
  }
  return `<figure class="media"><img src="${item.dataUrl}" alt="${escapeHtml(item.caption ?? 'render')}" loading="lazy"/>${cap}</figure>`;
}

function provenanceRows(p: ShowcaseProvenance): string {
  const rows: [string, string][] = [];
  if (p.prompt) rows.push(['Prompt', p.prompt]);
  if (p.negativePrompt) rows.push(['Negative', p.negativePrompt]);
  if (p.model) rows.push(['Model', p.model]);
  if (p.recipeName) rows.push(['Recipe', p.recipeName]);
  if (typeof p.seed === 'number') rows.push(['Seed', String(p.seed)]);
  for (const extra of p.params ?? []) rows.push([extra.label, extra.value]);
  return rows
    .map(
      ([label, value]) =>
        `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join('');
}

function remixBlock(lumen: LumenEmbed | undefined): string {
  if (!lumen) {
    return `<p class="note">Provenance only — original project not embedded.</p>`;
  }
  // The base64 lives in a NON-executed JSON script tag; the inlined script below
  // (no external src) turns it back into a downloadable .lumen on click.
  return (
    `<div class="remix">` +
    `<button id="remix-btn" type="button" class="remix-btn">Download .lumen &amp; remix in LumenDeck</button>` +
    `<script type="application/json" id="lumen-data">${lumen.base64}</script>` +
    `<script>(function(){var el=document.getElementById('lumen-data');var b=document.getElementById('remix-btn');if(!el||!b)return;b.addEventListener('click',function(){try{var s=el.textContent.trim();var bin=atob(s);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);var blob=new Blob([u],{type:'application/json'});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download=${JSON.stringify(lumen.filename)};document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);}catch(e){alert('Could not extract the project: '+e);}});})();</script>` +
    `</div>`
  );
}

const STYLE = `
:root{--midnight:#071426;--cyan:#34D6F4;--violet:#7C3AED;--ink:#EAF6FB;--muted:#9DB6C4;--panel:#0E2337;}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:var(--midnight);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 64px;}
h1{font-size:clamp(22px,4vw,34px);margin:0 0 4px;background:linear-gradient(90deg,var(--cyan),var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent;}
.sub{color:var(--muted);margin:0 0 24px;font-size:14px;}
.media{margin:0 0 20px;border-radius:14px;overflow:hidden;border:1px solid rgba(52,214,244,.18);background:#040d18;}
.media img,.media video{display:block;width:100%;height:auto;}
figcaption{padding:8px 12px;color:var(--muted);font-size:13px;}
.ph{display:flex;align-items:center;justify-content:center;min-height:180px;padding:24px;color:var(--muted);text-align:center;font-size:14px;background:repeating-linear-gradient(45deg,#08192a,#08192a 10px,#0b1f33 10px,#0b1f33 20px);}
.panel{background:var(--panel);border:1px solid rgba(52,214,244,.14);border-radius:14px;padding:18px 20px;margin:0 0 20px;}
.panel h2{margin:0 0 12px;font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:var(--cyan);}
.row{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:6px 0;border-top:1px solid rgba(157,182,196,.10);}
.row:first-child{border-top:0;}
dt{color:var(--muted);font-size:13px;margin:0;}
dd{margin:0;word-break:break-word;font-size:14px;}
.constellation{width:100%;overflow-x:auto;}
.constellation svg{width:100%;height:auto;max-height:420px;}
.remix{margin:8px 0 0;}
.remix-btn{appearance:none;border:1px solid var(--cyan);background:linear-gradient(90deg,rgba(52,214,244,.16),rgba(124,58,237,.16));color:var(--ink);border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;}
.remix-btn:hover{border-color:var(--violet);}
.note{color:var(--muted);font-size:13px;}
footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center;}
footer a{color:var(--cyan);text-decoration:none;}
`;

export function buildShowcaseHtml(input: ShowcaseInput): ShowcaseResult {
  if (!input.items || input.items.length === 0) {
    throw new Error('Cannot build a showcase with no items.');
  }
  const posterOnly = Boolean(input.posterOnly);
  const media = input.items.map((it) => renderItem(it, posterOnly)).join('');
  const rows = provenanceRows(input.provenance);
  const constellation = input.constellationSvg
    ? `<section class="panel"><h2>How it was made</h2><div class="constellation">${input.constellationSvg}</div></section>`
    : '';
  // Plain-text attribution — NO external href, so the file makes zero external
  // references of any kind (fully offline/portable/private).
  const footer = input.footer === false ? '' : `<footer>Made with LumenDeck</footer>`;

  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    `<title>${escapeHtml(input.title)} — LumenDeck Showcase</title>` +
    `<style>${STYLE}</style></head><body><div class="wrap">` +
    `<h1>${escapeHtml(input.title)}</h1>` +
    `<p class="sub">A LumenDeck showcase — everything below is embedded in this single file.</p>` +
    media +
    `<section class="panel"><h2>Details</h2><dl>${rows}</dl></section>` +
    constellation +
    remixBlock(input.lumen) +
    footer +
    `</div></body></html>`;

  const bytes = new TextEncoder().encode(html).length;
  return { html, bytes, oversized: bytes > SHOWCASE_MAX_BYTES };
}
