'use client';

import { useRef, useState } from 'react';
import StepsIndicator from './StepsIndicator';
import RoofingUploadScreen from './RoofingUploadScreen';
import ProcessingScreen from './ProcessingScreen';
import RoofingReviewScreen from './RoofingReviewScreen';
import SuccessScreen from './SuccessScreen';
import { extractRoofingOrder, submitRoofingToMyob } from '../lib/api';
import type { RoofingOrder, Screen } from '../lib/types';

export default function RoofingTab() {
  const [screen, setScreen] = useState<Screen>('upload');
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [order, setOrder] = useState<RoofingOrder | null>(null);
  const [customerIdOverride, setCustomerIdOverride] = useState('');
  const [soNumber, setSoNumber] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleProcess = async () => {
    if (!reportFile) return;
    setError('');
    setScreen('processing');
    try {
      const o = await extractRoofingOrder(reportFile);
      setOrder(o);
      setTimeout(() => setScreen('review'), 600);
    } catch (err: any) {
      setError(err.message || 'Extraction failed');
      setScreen('upload');
    }
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!order) return;
    if (!customerIdOverride.trim()) {
      alert('Enter a MYOB Customer ID first (see the Customer Details card).');
      return;
    }
    const missing = order.line_items.filter((l) => !String(l.inventory_id || '').trim());
    if (missing.length) {
      alert(
        `Some rows still have no Inventory ID:\n\n${missing
          .map((m) => `• ${m.description}`)
          .join('\n')}\n\nFill them before submitting.`
      );
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await submitRoofingToMyob(order, customerIdOverride.trim());
      setSoNumber(res.Number || `SO${Date.now()}`);
      setScreen('success');
    } catch (err: any) {
      alert('MYOB Error: ' + err.message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const reset = () => {
    setReportFile(null);
    setOrder(null);
    setCustomerIdOverride('');
    setSoNumber('');
    setError('');
    setScreen('upload');
  };

  return (
    <>
      <StepsIndicator screen={screen} />
      <div className="main">
        {screen === 'upload' && (
          <RoofingUploadScreen
            reportFile={reportFile}
            onReportChange={setReportFile}
            onProcess={handleProcess}
            error={error}
          />
        )}
        {screen === 'processing' && <ProcessingScreen />}
        {screen === 'review' && order && (
          <RoofingReviewScreen
            order={order}
            onOrderChange={setOrder}
            customerIdOverride={customerIdOverride}
            onCustomerIdChange={setCustomerIdOverride}
            onReject={reset}
            onUploadNew={reset}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        )}
        {screen === 'success' && <SuccessScreen soNumber={soNumber} onNew={reset} />}
      </div>

      {submitting && (
        <div className="loading-overlay">
          <div className="spinner" />
          <p>Submitting to MYOB...</p>
        </div>
      )}
    </>
  );
}
