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
    label: 'Command',
    items: [
      { id: 'mission', label: 'Mission', icon: () => Icon.compass({ size: 22 }) },
      { id: 'overview', label: 'Overview', icon: () => Icon.target({ size: 22 }) },
      { id: 'craft', label: 'Craft', icon: () => Icon.sparkle({ size: 22 }) },
      { id: 'projects', label: 'Projects', icon: () => Icon.layers({ size: 22 }) },
      { id: 'recipes', label: 'Recipes', icon: () => Icon.beaker({ size: 22 }) },
      { id: 'entropy', label: 'Entropy', icon: () => Icon.scatter({ size: 22 }) },
      { id: 'proof', label: 'Proof', icon: () => Icon.trophy({ size: 22 }) },
    ],
  },
  {
    label: 'Studio',
    items: [
      { id: 'guide', label: 'Guide', icon: () => Icon.help({ size: 22 }) },
      { id: 'recipe', label: 'Recipe', icon: () => Icon.home({ size: 22 }) },
      { id: 'graph', label: 'Graph', icon: () => Icon.graph({ size: 22 }) },
      { id: 'shelf', label: 'Shelf', icon: () => Icon.grid({ size: 22 }) },
      { id: 'gallery', label: 'Gallery', icon: () => Icon.image({ size: 22 }) },
      { id: 'controls', label: 'Controls', icon: () => Icon.play({ size: 22 }) },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'settings', label: 'Settings', icon: () => Icon.gear({ size: 22 }) },
      { id: 'diagnostics', label: 'Diagnostics', icon: () => Icon.pulse({ size: 22 }) },
      { id: 'performance', label: 'Performance', icon: () => Icon.bolt({ size: 22 }) },
      { id: 'support', label: 'Support', icon: () => Icon.heart({ size: 22 }) },
      { id: 'credits', label: 'Credits', icon: () => Icon.sparkle({ size: 22 }) },
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
    <nav className="nav-rail" aria-label="Primary views">
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
