'use client';

import { useState } from 'react';
import SettingsModal from './SettingsModal';

export default function TopBar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="topbar">
        <div className="logo">
          METFOLD <span>//</span> ORDER PROCESSOR
        </div>
        <div className="topbar-right">
          <span className="topbar-tag">AI-POWERED · MYOB INTEGRATION</span>
          <button
            type="button"
            className="topbar-gear"
            onClick={() => setOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>
      </div>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
