'use client';

import type { Tab } from '../lib/types';

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export default function TabBar({ active, onChange }: Props) {
  return (
    <div className="tabbar">
      <button
        type="button"
        className={`tab ${active === 'flashing' ? 'active' : ''}`}
        onClick={() => onChange('flashing')}
      >
        Flashing
      </button>
      <button
        type="button"
        className={`tab ${active === 'roofing' ? 'active' : ''}`}
        onClick={() => onChange('roofing')}
      >
        Roofing
      </button>
    </div>
  );
}
