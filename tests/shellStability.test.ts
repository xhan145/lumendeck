import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

function sourceCssFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceCssFiles(path);
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
  });
}

describe('LumenDeck shell reliability guards', () => {
  it('rejects unmerged Git conflict markers in CSS', () => {
    const files = sourceCssFiles(join(root, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const css = readFileSync(file, 'utf8');
      expect(css, file).not.toMatch(/^(?:<{7}|={7}|>{7})(?:\s|$)/m);
    }
  });

  it('does not terminate arbitrary processes by port in legacy Windows launchers', () => {
    for (const filename of ['run.bat', 'start.bat']) {
      const source = readFileSync(join(root, filename), 'utf8');
      expect(source.toLowerCase(), filename).not.toContain('taskkill');
      expect(source.toLowerCase(), filename).not.toContain('wmic process');
    }
  });
});
