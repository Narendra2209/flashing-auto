'use client';

import { useRef, useState } from 'react';
import StepsIndicator from './StepsIndicator';
import UploadScreen from './UploadScreen';
import ProcessingScreen from './ProcessingScreen';
import ReviewScreen from './ReviewScreen';
import SuccessScreen from './SuccessScreen';
import { extractOrder, submitToMyob } from '../lib/api';
import type { Order, Screen } from '../lib/types';

export default function FlashingTab() {
  const [screen, setScreen] = useState<Screen>('upload');
  const [poFile, setPoFile] = useState<File | null>(null);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [customerIdOverride, setCustomerIdOverride] = useState('');
  const [soNumber, setSoNumber] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleProcess = async () => {
    if (!poFile || !drawingFile) return;
    setError('');
    setScreen('processing');
    try {
      const o = await extractOrder(poFile, drawingFile);
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
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await submitToMyob(order, customerIdOverride.trim());
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
    setPoFile(null);
    setDrawingFile(null);
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
          <UploadScreen
            poFile={poFile}
            drawingFile={drawingFile}
            onPoChange={setPoFile}
            onDrawingChange={setDrawingFile}
            onProcess={handleProcess}
            error={error}
          />
        )}
        {screen === 'processing' && <ProcessingScreen />}
        {screen === 'review' && order && (
          <ReviewScreen
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
