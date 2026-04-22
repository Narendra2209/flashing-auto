'use client';

import { useEffect, useState } from 'react';

const LINES = [
  '→ Reading Purchase Order PDF...',
  '→ Reading Flashing Drawing PDF...',
  '→ Extracting customer & delivery details...',
  '→ Identifying flashing profiles and dimensions...',
  '→ Rounding girths to standard sizes...',
  '→ Generating MYOB inventory codes...',
  '✓ Extraction complete — preparing review screen.'
];

export default function ProcessingScreen() {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    LINES.forEach((_, i) => {
      timers.push(setTimeout(() => setShown((prev) => Math.max(prev, i + 1)), i * 600));
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="processing-center">
      <div className="spinner-wrap">
        <div className="spinner" />
      </div>
      <div className="screen-title">Reading your PDFs...</div>
      <div className="screen-sub">
        AI is extracting order details and generating MYOB codes.
      </div>
      <div className="processing-log">
        {LINES.map((text, i) => (
          <div
            key={i}
            className={`log-line ${i < shown ? 'show' : ''}`}
            style={i === LINES.length - 1 ? { color: '#a0f0a0' } : undefined}
          >
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
