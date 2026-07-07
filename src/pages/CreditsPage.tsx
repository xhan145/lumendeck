import { BrandMark } from '../components/icons';
import { CREDITS_LINES, PROJECT_NAME } from '../state/storeConstants';
import '../styles/credits.css';

export function CreditsPage() {
  return (
    <main className="studio-page credits-page scroll" aria-label="Credits">
      <div className="credits-stage">
        <div className="credits-constellation" aria-hidden="true">
          <svg viewBox="0 0 320 200" fill="none" preserveAspectRatio="xMidYMid slice">
            <path d="M20 160 78 90 150 128 214 52 300 96" stroke="var(--ld-cyan)" strokeWidth="1" opacity="0.28" />
            <path d="M60 40 130 74 190 30 268 70" stroke="var(--ld-violet)" strokeWidth="1" opacity="0.24" />
            <circle cx="20" cy="160" r="2.4" fill="var(--ld-cyan)" />
            <circle cx="78" cy="90" r="3.2" fill="var(--ld-violet)" />
            <circle cx="150" cy="128" r="2.2" fill="var(--md-secondary)" />
            <circle cx="214" cy="52" r="3" fill="var(--ld-cyan)" />
            <circle cx="300" cy="96" r="2.4" fill="var(--ld-violet)" />
            <circle cx="130" cy="74" r="2.2" fill="var(--ld-cyan)" />
            <circle cx="268" cy="70" r="2.6" fill="var(--md-secondary)" />
          </svg>
        </div>

        <div className="credits-content">
          <div className="credits-mark" aria-hidden="true">
            <BrandMark size={46} />
          </div>
          <p className="credits-kicker">{PROJECT_NAME}</p>

          <div className="credits-lines">
            {CREDITS_LINES.map((line) => (
              <p key={line} className="credits-line">{line}</p>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
