import type React from 'react';
import { CAPSULES } from '../core/capsules';
import type { CapsuleCategory, CapsuleKind } from '../core/types';

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, { size = 16, className }: IconProps = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {path}
    </svg>
  );
}

export const Icon = {
  logo: (p?: IconProps) =>
    svg(
      <>
        <rect x="3" y="5" width="13" height="16" rx="2" />
        <rect x="8" y="3" width="13" height="16" rx="2" fill="rgba(52,214,244,0.15)" />
        <circle cx="14.5" cy="11" r="3" />
        <path d="M14.5 8v-1.5M14.5 15.5V14M11.5 11H10M19 11h-1.5" />
      </>,
      p,
    ),
  play: (p?: IconProps) => svg(<path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />, p),
  dice: (p?: IconProps) =>
    svg(
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none" />
      </>,
      p,
    ),
  warning: (p?: IconProps) =>
    svg(
      <>
        <path d="M12 3 2.5 20h19L12 3z" />
        <path d="M12 10v4" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </>,
      p,
    ),
  error: (p?: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9l6 6M15 9l-6 6" />
      </>,
      p,
    ),
  ok: (p?: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 5-6" />
      </>,
      p,
    ),
  plus: (p?: IconProps) => svg(<path d="M12 5v14M5 12h14" />, p),
  trash: (p?: IconProps) =>
    svg(
      <>
        <path d="M4 7h16M10 11v6M14 11v6" />
        <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
      </>,
      p,
    ),
  download: (p?: IconProps) => svg(<path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" />, p),
  close: (p?: IconProps) => svg(<path d="M6 6l12 12M18 6 6 18" />, p),
  restore: (p?: IconProps) =>
    svg(<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />, p),
  save: (p?: IconProps) =>
    svg(
      <>
        <path d="M5 4h11l3 3v13H5z" />
        <path d="M8 4v5h7V4M8 20v-6h8v6" />
      </>,
      p,
    ),
  bolt: (p?: IconProps) => svg(<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />, p),
  plug: (p?: IconProps) =>
    svg(
      <>
        <path d="M8 3v5M16 3v5M7 8h10v4a5 5 0 0 1-10 0V8z" />
        <path d="M12 17v4" />
      </>,
      p,
    ),
  pulse: (p?: IconProps) => svg(<path d="M3 12h4l2-6 4 12 2-6h6" />, p),
  folder: (p?: IconProps) => svg(<path d="M3 6h6l2 2h10v11H3z" />, p),
  help: (p?: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.8 9a2.25 2.25 0 1 1 3.6 1.8c-.9.6-1.4 1.2-1.4 2.2" />
        <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
      </>,
      p,
    ),
  grid: (p?: IconProps) =>
    svg(
      <>
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </>,
      p,
    ),
  home: (p?: IconProps) => svg(<path d="M4 11 12 4l8 7M6 10v10h12V10" />, p),
  graph: (p?: IconProps) =>
    svg(
      <>
        <circle cx="6" cy="6" r="2.4" />
        <circle cx="18" cy="9" r="2.4" />
        <circle cx="9" cy="18" r="2.4" />
        <path d="M8 7l8 1.5M7.5 15.8 16.5 10.5" />
      </>,
      p,
    ),
  image: (p?: IconProps) =>
    svg(
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <circle cx="9" cy="9" r="1.6" />
        <path d="m5 17 4-4 4 4 3-3 3 3" />
      </>,
      p,
    ),
  gear: (p?: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
      </>,
      p,
    ),
  heart: (p?: IconProps) =>
    svg(
      <path d="M12 20s-7-4.35-9.3-8.5C1.2 8.9 2.6 6 5.6 6c1.9 0 3.2 1.1 4.4 2.6C11.2 7.1 12.5 6 14.4 6c3 0 4.4 2.9 2.9 5.5C19 15.65 12 20 12 20z" />,
      p,
    ),
  sparkle: (p?: IconProps) =>
    svg(
      <>
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
        <path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z" />
      </>,
      p,
    ),
};

/** Glowing LumenDeck brand mark — two overlapping "deck" cards with a lit lens. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient id="ld-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--md-primary-light)" />
          <stop offset="1" stopColor="var(--md-primary)" />
        </linearGradient>
      </defs>
      <rect x="6" y="9" width="14" height="18" rx="3.5" transform="rotate(-10 13 18)"
        fill="var(--md-secondary)" opacity="0.9" />
      <rect x="12" y="6" width="14" height="18" rx="3.5" transform="rotate(6 19 15)" fill="url(#ld-card)" />
      <circle cx="19" cy="15" r="3.4" fill="var(--md-bg)" />
      <circle cx="19" cy="15" r="1.9" fill="var(--md-success)" />
    </svg>
  );
}

const CATEGORY_PATHS: Record<CapsuleCategory, React.ReactNode> = {
  core: <path d="M4 5h16v14H4zM8 9h8M8 13h5" />,
  loaders: <path d="M4 7h6l2 2h8v10H4zM12 13v-3m0 3 3-3m-3 3-3-3" />,
  conditioning: <path d="M4 5h16v11H9l-5 4V5z" />,
  latent: <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3zM4 7.5 12 12l8-4.5M12 12v9" />,
  control: <path d="M12 4v16M4 12h16M7 7l10 10M17 7 7 17" />,
  image: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m5 17 4-4 4 4 3-3 3 3" /></>,
  mask: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 0 0 16" /></>,
  sampling: <path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-10 6-10" />,
  video: <><rect x="4" y="6" width="13" height="12" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>,
  utility: <path d="M5 12h14M12 5v14M7 7l10 10M17 7 7 17" />,
  output: <path d="M12 15V3m0 0 4 4m-4-4L8 7M4 13v6h16v-6" />,
};

const CAPSULE_PATHS: Partial<Record<CapsuleKind, React.ReactNode>> = {
  prompt: <path d="M4 5h16v11H9l-5 4V5z" />,
  model: (
    <>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  loraRack: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="var(--ld-bg)" />
      <circle cx="15" cy="12" r="2" fill="var(--ld-bg)" />
      <circle cx="7" cy="18" r="2" fill="var(--ld-bg)" />
    </>
  ),
  control: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v4M12 16v4M4 12h4M16 12h4" />
    </>
  ),
  sampler: <path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-10 6-10" />,
  video: (
    <>
      <rect x="4" y="6" width="13" height="12" rx="2" />
      <path d="m17 10 4-2v8l-4-2" />
      <path d="M8 10h5M8 14h3" />
    </>
  ),
  canvas: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="m4 15 4-4 5 5 3-3 4 4" />
      <circle cx="9.5" cy="8.5" r="1.4" />
    </>
  ),
  queue: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <path d="M16.5 13v7M13 16.5h7" />
    </>
  ),
  export: <path d="M12 15V3m0 0 4 4m-4-4L8 7M4 13v6h16v-6" />,
  manifest: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 12h7M9 16h7" />
    </>
  ),
};

export function CapsuleIcon({ kind, size = 16 }: { kind: CapsuleKind; size?: number }) {
  return svg(CAPSULE_PATHS[kind] ?? CATEGORY_PATHS[CAPSULES[kind].category], { size });
}
