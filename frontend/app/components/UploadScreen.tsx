'use client';

import { useEffect, useState } from 'react';
import { getMyobStatus } from '../lib/api';

interface Props {
  poFile: File | null;
  drawingFile: File | null;
  onPoChange: (f: File | null) => void;
  onDrawingChange: (f: File | null) => void;
  onProcess: () => void;
  error: string;
}

export default function UploadScreen({
  poFile,
  drawingFile,
  onPoChange,
  onDrawingChange,
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
      <div className="screen-title">Upload Order PDFs</div>
      <div className="screen-sub">
        Upload the Purchase Order and Flashing Drawing — AI will extract all details automatically.
      </div>

      <div className="upload-grid">
        <UploadZone
          label="Purchase Order PDF"
          sub="Customer PO with job details, delivery address & contact"
          icon="📄"
          file={poFile}
          onChange={onPoChange}
        />
        <UploadZone
          label="Flashing Drawing PDF"
          sub="Drawing with flashing profiles, dimensions, colours & quantities"
          icon="📐"
          file={drawingFile}
          onChange={onDrawingChange}
        />
      </div>

      <div className="myob-section">
        <h4>🔗 MYOB Advanced Connection</h4>
        <p style={{ color: myob.color }}>{myob.text}</p>
      </div>

      {error && <div className="error-banner">⚠ {error}</div>}

      <button
        className="btn-process"
        disabled={!poFile || !drawingFile}
        onClick={onProcess}
      >
        <span>⚡</span> Extract Order with AI
      </button>
    </div>
  );
}

function UploadZone({
  label,
  sub,
  icon,
  file,
  onChange
}: {
  label: string;
  sub: string;
  icon: string;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  return (
    <div className={`upload-zone ${file ? 'filled' : ''}`}>
      {file && <div className="check-icon">✓</div>}
      <span className="upload-icon">{icon}</span>
      <h3>{label}</h3>
      <p dangerouslySetInnerHTML={{ __html: sub.replace(',', ',<br/>') }} />
      {file && <div className="file-name">{file.name}</div>}
      <input
        type="file"
        accept=".pdf"
        onChange={(e) => onChange(e.target.files?.[0] || null)}
      />
    </div>
  );
}
