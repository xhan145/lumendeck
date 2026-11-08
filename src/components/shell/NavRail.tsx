import type React from 'react';
import type { ViewId } from '../../state/store';
import { Icon } from '../icons';

interface NavItem {
  id: ViewId;
  label: string;
  icon: () => React.ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Daily',
    items: [
      { id: 'desktop', label: 'Desktop', icon: () => Icon.home({ size: 22 }) },
      { id: 'mission', label: 'Studio', icon: () => Icon.compass({ size: 22 }) },
      { id: 'projects', label: 'Projects', icon: () => Icon.layers({ size: 22 }) },
      { id: 'gallery', label: 'Gallery', icon: () => Icon.image({ size: 22 }) },
      { id: 'controls', label: 'Create', icon: () => Icon.play({ size: 22 }) },
    ],
  },
  {
    label: 'Build',
    items: [
      { id: 'graph', label: 'Graph', icon: () => Icon.graph({ size: 22 }) },
      { id: 'shelf', label: 'Models', icon: () => Icon.grid({ size: 22 }) },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'settings', label: 'Settings', icon: () => Icon.gear({ size: 22 }) },
    ],
  },
];

export function NavRail({
  view,
  setView,
}: {
  view: ViewId;
  setView: (v: ViewId) => void;
}) {
  return (
    <nav className="nav-rail" aria-label="Primary destinations">
      {GROUPS.map((group) => (
        <ul className="nav-rail-list" key={group.label} aria-label={group.label}>
          {group.items.map((item) => {
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
      ))}
    </nav>
  );
}
