'use client';

import { useEffect, useState } from 'react';
import { getMyobStatus } from '../lib/api';

interface Props {
  reportFile: File | null;
  onReportChange: (f: File | null) => void;
  onProcess: () => void;
  error: string;
}

export default function RoofingUploadScreen({
  reportFile,
  onReportChange,
  onProcess,
  error
}: Props) {
  const [myob, setMyob] = useState<{ text: string; color: string }>({
    text: 'Checking MYOB connection…',
    color: 'var(--muted)'
  });

  useEffect(() => {
    getMyobStatus().then((s) => {
      if (!s.configured) {
        setMyob({ text: '⚠ MYOB credentials not configured in backend .env', color: 'var(--danger)' });
      } else {
        setMyob({
          text: `✓ Configured — ${s.host}${s.connected ? ' (session active)' : ''}`,
          color: 'var(--accent2)'
        });
      }
    });
  }, []);

  return (
    <div>
      <div className="screen-title">Upload Roof Report PDF</div>
      <div className="screen-sub">
        Upload the Roof Report — AI will extract the Summary table (Ridge, Gutter, Fascia, Battens,
        Downpipes, Flashings, etc.) along with colour, pitch, site address and contact details.
      </div>

      <div className="upload-grid single">
        <div className={`upload-zone ${reportFile ? 'filled' : ''}`}>
          {reportFile && <div className="check-icon">✓</div>}
          <span className="upload-icon">🏠</span>
          <h3>Roof Report PDF</h3>
          <p>Report header, materials note,<br/>summary of lengths, area and pitch</p>
          {reportFile && <div className="file-name">{reportFile.name}</div>}
          <input
            type="file"
            accept=".pdf"
            onChange={(e) => onReportChange(e.target.files?.[0] || null)}
          />
        </div>
      </div>

      <div className="myob-section">
        <h4>🔗 MYOB Advanced Connection</h4>
        <p style={{ color: myob.color }}>{myob.text}</p>
      </div>

      {error && <div className="error-banner">⚠ {error}</div>}

      <button className="btn-process" disabled={!reportFile} onClick={onProcess}>
        <span>⚡</span> Extract Roofing Order with AI
      </button>
    </div>
  );
}
