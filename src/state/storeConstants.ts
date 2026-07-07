export const APP_VERSION = '0.19.1';

/** Product name, surfaced in Support/Credits and OSS docs. */
export const PROJECT_NAME = 'LumenDeck';

/** Ko-fi donation/support link (open source + donation-supported). */
export const DONATION_URL = 'https://ko-fi.com/mekhaneproductions';

/** Placeholder used for the "other projects" line until the list is published. */
export const OTHER_PROJECTS_PLACEHOLDER = '[UPDATING SOON]';

/**
 * Verbatim Credits copy (names + punctuation preserved). Rendered line-by-line by
 * the Credits page. The final line composes the shared placeholder constant.
 */
export const CREDITS_LINES = [
  'Created, Developed, and Coded By Greg "MADMAN" Molina.',
  'Made for my Friend Nathan. Enjoy Brother.',
  'Inspired by opening the gates or kicking them straight down.',
  'Funded by Ben Y and Eric B.',
  `Check out our other projects: ${OTHER_PROJECTS_PLACEHOLDER}`,
] as const;
