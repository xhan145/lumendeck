import { openExternal } from '../bridge/openExternal';
import { Icon } from '../components/icons';
import { DONATION_URL, PROJECT_NAME } from '../state/storeConstants';
import '../styles/support.css';

const FUNDS = [
  'Installer builds and signed releases',
  'Documentation and tutorials',
  'Curated preset packs',
  'Constellation system improvements',
  'Gradient engine polish',
  'Long-term maintenance',
];

export function SupportPage() {
  return (
    <main className="studio-page support-page scroll" aria-label="Support LumenDeck">
      <div className="studio-page-inner">
        <section className="support-hero card" aria-labelledby="support-title">
          <span className="support-constellation" aria-hidden="true">
            <svg viewBox="0 0 220 120" fill="none" preserveAspectRatio="xMidYMid slice">
              <path d="M18 92 60 40 108 70 152 24 200 58" stroke="var(--ld-cyan)" strokeWidth="1" opacity="0.35" />
              <circle cx="18" cy="92" r="2.6" fill="var(--ld-cyan)" />
              <circle cx="60" cy="40" r="3.4" fill="var(--ld-violet)" />
              <circle cx="108" cy="70" r="2.4" fill="var(--md-secondary)" />
              <circle cx="152" cy="24" r="3" fill="var(--ld-cyan)" />
              <circle cx="200" cy="58" r="2.2" fill="var(--ld-violet)" />
            </svg>
          </span>
          <p className="page-kicker">Open source</p>
          <h1 id="support-title">Support {PROJECT_NAME}</h1>
          <p className="support-lead">
            {PROJECT_NAME} is free and open source, built in the open and kept alive by people who
            enjoy it. If it has earned a spot in your creative toolkit, a one-time or recurring tip
            on Ko-fi helps keep the lights on and the roadmap moving.
          </p>
          <div className="support-actions">
            <button
              type="button"
              className="btn primary support-cta"
              onClick={() => void openExternal(DONATION_URL)}
              aria-label="Support LumenDeck on Ko-fi (opens in your browser)"
            >
              {Icon.heart({ size: 18 })} Support on Ko-fi
            </button>
            <span className="support-note">Every core feature stays free and open. Tips are optional.</span>
          </div>
        </section>

        <section className="card page-card support-funds" aria-labelledby="support-funds-title">
          <div className="page-card-head">
            <h2 id="support-funds-title">Where donations go</h2>
            <span className="chip">community funded</span>
          </div>
          <ul className="support-fund-list">
            {FUNDS.map((item) => (
              <li key={item}>
                <span className="support-fund-dot" aria-hidden="true">{Icon.sparkle({ size: 16 })}</span>
                {item}
              </li>
            ))}
          </ul>
          <p className="field-help">
            Prefer to help without spending? Star the repository, file a clear bug report, share a
            preset, or improve the docs. Contributions of every size move {PROJECT_NAME} forward.
          </p>
        </section>
      </div>
    </main>
  );
}
