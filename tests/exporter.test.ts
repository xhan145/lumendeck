import { describe, expect, it } from 'vitest';
import { slugify } from '../src/bridge/exporter';

describe('slugify', () => {
  it('produces filesystem-safe slugs', () => {
    expect(slugify('A luminous deck!')).toBe('a-luminous-deck');
    expect(slugify('  Trailing / slashes  ')).toBe('trailing-slashes');
  });

  it('falls back when empty', () => {
    expect(slugify('')).toBe('render');
    expect(slugify('!!!', 'img')).toBe('img');
  });

  it('caps length', () => {
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});
