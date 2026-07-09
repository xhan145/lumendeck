import { describe, expect, it } from 'vitest';
import { buildShowcaseHtml, escapeHtml, SHOWCASE_MAX_BYTES } from '../src/core/share/showcase';

const img = 'data:image/png;base64,iVBORw0KGgo=';
const base = {
  title: 'My Render',
  items: [{ dataUrl: img, mediaType: 'image' as const }],
  provenance: { prompt: 'a <neon> cat & dog', seed: 7, model: 'sd-turbo' },
};

describe('buildShowcaseHtml', () => {
  it('embeds media as data: URLs and renders provenance', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).toContain(img);
    expect(html).toContain('sd-turbo');
    expect(html).toContain('7');
    expect(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('HTML-escapes user text (no raw injection)', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).toContain('a &lt;neon&gt; cat &amp; dog');
    expect(html).not.toContain('<neon>');
  });

  it('has NO external references (fully self-contained)', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).not.toMatch(/src="http|href="http|url\(http|<link rel="stylesheet"|<script src=/);
  });

  it('round-trips an embedded .lumen (base64 decodes to the input JSON)', () => {
    const lumenJson = JSON.stringify({ app: 'LumenDeck', workflow: { id: 'w' } });
    const b64 = Buffer.from(lumenJson, 'utf-8').toString('base64');
    const { html } = buildShowcaseHtml({ ...base, lumen: { base64: b64, filename: 'proj.lumen' } });
    const m = html.match(/id="lumen-data"[^>]*>([^<]+)</);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1].trim(), 'base64').toString('utf-8')).toBe(lumenJson);
    expect(html).toContain('Download'); // remix button present
  });

  it('omits the remix payload + shows a provenance-only note when no lumen', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).toContain('Provenance only');
    expect(html).not.toContain('id="lumen-data"');
  });

  it('posterOnly swaps a video item for a still (no <video>)', () => {
    const vid = { dataUrl: 'data:video/mp4;base64,AAA', mediaType: 'video' as const };
    const { html } = buildShowcaseHtml({ ...base, items: [vid], posterOnly: true });
    expect(html).not.toContain('<video');
  });

  it('renders a <video> for a video item by default', () => {
    const vid = { dataUrl: 'data:video/mp4;base64,AAA', mediaType: 'video' as const };
    const { html } = buildShowcaseHtml({ ...base, items: [vid] });
    expect(html).toContain('<video');
  });

  it('renders a GIF/SVG "video" render (mediaType video, image/* mime) as <img>, not <video>', () => {
    // Motion renders default to GIF (mimeType image/gif) and mock renders to SVG —
    // a <video> cannot decode them; they must animate in an <img>.
    const gif = { dataUrl: 'data:image/gif;base64,R0lGOD', mediaType: 'video' as const, mimeType: 'image/gif' };
    const { html } = buildShowcaseHtml({ ...base, items: [gif] });
    expect(html).not.toContain('<video');
    expect(html).toContain('<img');
    expect(html).toContain('data:image/gif;base64,R0lGOD');
  });

  it('uses <video> only for a real video/* mime', () => {
    const mp4 = { dataUrl: 'data:video/mp4;base64,AAA', mediaType: 'video' as const, mimeType: 'video/mp4' };
    expect(buildShowcaseHtml({ ...base, items: [mp4] }).html).toContain('<video');
  });

  it('escapes a hostile data URL so it cannot break out of the src attribute (XSS)', () => {
    const evil = { dataUrl: 'data:image/png"><script>alert(1)</script>;base64,AAA', mediaType: 'image' as const };
    const { html } = buildShowcaseHtml({ ...base, items: [evil] });
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('renders a placeholder for a non-data: URL (never embeds a remote src)', () => {
    const remote = { dataUrl: 'https://evil.example/x.png', mediaType: 'image' as const };
    const { html } = buildShowcaseHtml({ ...base, items: [remote] });
    expect(html).not.toContain('https://evil.example');
    expect(html.toLowerCase()).toContain('unavailable');
  });

  it('flags oversized output past the size constant', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(SHOWCASE_MAX_BYTES + 1000);
    const { oversized } = buildShowcaseHtml({ ...base, items: [{ dataUrl: big, mediaType: 'image' }] });
    expect(oversized).toBe(true);
  });

  it('reports bytes and is not oversized for a small showcase', () => {
    const r = buildShowcaseHtml(base);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.oversized).toBe(false);
  });

  it('renders a labeled placeholder for a missing media slot', () => {
    const { html } = buildShowcaseHtml({ ...base, items: [{ dataUrl: '', mediaType: 'image' }] });
    expect(html.toLowerCase()).toContain('unavailable');
  });

  it('throws on empty items', () => {
    expect(() => buildShowcaseHtml({ ...base, items: [] })).toThrow(/no.*item/i);
  });

  it('includes the constellation SVG verbatim when provided', () => {
    const svg = '<svg id="cn"><circle/></svg>';
    const { html } = buildShowcaseHtml({ ...base, constellationSvg: svg });
    expect(html).toContain(svg);
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous chars', () => {
    expect(escapeHtml(`<a href="x" & 'q'>`)).toBe('&lt;a href=&quot;x&quot; &amp; &#39;q&#39;&gt;');
  });
});
