import type { ViewId } from '../../state/store';
import { Icon } from '../icons';

interface NavItem {
  id: ViewId;
  label: string;
  icon: () => React.ReactNode;
}

const ITEMS: NavItem[] = [
  { id: 'guide', label: 'Guide', icon: () => Icon.help({ size: 22 }) },
  { id: 'recipe', label: 'Recipe', icon: () => Icon.home({ size: 22 }) },
  { id: 'graph', label: 'Graph', icon: () => Icon.graph({ size: 22 }) },
  { id: 'shelf', label: 'Shelf', icon: () => Icon.grid({ size: 22 }) },
  { id: 'gallery', label: 'Gallery', icon: () => Icon.image({ size: 22 }) },
];

/** Material 3 navigation rail — primary view switching + Settings. */
export function NavRail({
  view,
  setView,
  onSettings,
}: {
  view: ViewId;
  setView: (v: ViewId) => void;
  onSettings: () => void;
}) {
  return (
    <nav className="nav-rail" aria-label="Primary views">
      <ul className="nav-rail-list">
        {ITEMS.map((item) => {
          const active = view === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`nav-item ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => setView(item.id)}
              >
                <span className="nav-item-icon">{item.icon()}</span>
                <span className="nav-item-label">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="nav-item nav-settings" onClick={onSettings} aria-label="Controls & settings">
        <span className="nav-item-icon">{Icon.gear({ size: 22 })}</span>
        <span className="nav-item-label">Settings</span>
      </button>
    </nav>
  );
}
