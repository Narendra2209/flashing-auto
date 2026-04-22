import type { Screen } from '../lib/types';

const STEP_INDEX: Record<Screen, number> = {
  upload: 1,
  processing: 2,
  review: 3,
  success: 4
};

const STEPS: { n: number; label: string }[] = [
  { n: 1, label: 'Upload PDFs' },
  { n: 2, label: 'AI Extraction' },
  { n: 3, label: 'Review Order' },
  { n: 4, label: 'Submit to MYOB' }
];

export default function StepsIndicator({ screen }: { screen: Screen }) {
  const current = STEP_INDEX[screen];
  return (
    <div className="steps">
      {STEPS.map((s) => {
        const cls = s.n < current ? 'done' : s.n === current ? 'active' : '';
        return (
          <div key={s.n} className={`step ${cls}`.trim()}>
            <div className="step-num">{s.n}</div> {s.label}
          </div>
        );
      })}
    </div>
  );
}
