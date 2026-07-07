import { describe, expect, it } from 'vitest';
import { openExternal } from '../src/bridge/openExternal';
import {
  CREDITS_LINES,
  DONATION_URL,
  OTHER_PROJECTS_PLACEHOLDER,
  PROJECT_NAME,
} from '../src/state/storeConstants';

describe('support/donation constants', () => {
  it('points the donation CTA at the Ko-fi page over https', () => {
    expect(DONATION_URL).toBe('https://ko-fi.com/mekhaneproductions');
    expect(DONATION_URL.startsWith('https://')).toBe(true);
  });

  it('names the project', () => {
    expect(PROJECT_NAME).toBe('LumenDeck');
  });
});

describe('credits copy', () => {
  it('preserves the exact verbatim lines (names + punctuation)', () => {
    expect([...CREDITS_LINES]).toEqual([
      'Created, Developed, and Coded By Greg "MADMAN" Molina.',
      'Made for my Friend Nathan. Enjoy Brother.',
      'Inspired by opening the gates or kicking them straight down.',
      'Funded by Ben Y and Eric B.',
      'Check out our other projects: [UPDATING SOON]',
    ]);
  });

  it('composes the other-projects line from the shared placeholder constant', () => {
    expect(OTHER_PROJECTS_PLACEHOLDER).toBe('[UPDATING SOON]');
    expect(CREDITS_LINES[CREDITS_LINES.length - 1].endsWith(OTHER_PROJECTS_PLACEHOLDER)).toBe(true);
  });
});

describe('openExternal', () => {
  it('never throws outside the desktop shell / browser (node env)', async () => {
    await expect(openExternal(DONATION_URL)).resolves.toBeUndefined();
  });
});
