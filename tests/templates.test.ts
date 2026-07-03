import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../src/data/templates';
import { checkHealth } from '../src/core/health';
import { DEMO_SHELF } from '../src/data/demoShelf';

describe('starter templates', () => {
  it('ships at least three', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it('each builds a health-clean workflow with an installed checkpoint', () => {
    for (const t of TEMPLATES) {
      const wf = t.build();
      const errors = checkHealth(wf, DEMO_SHELF).filter((i) => i.severity === 'error');
      expect(errors, `${t.name}: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    }
  });

  it('has unique ids', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });
});
