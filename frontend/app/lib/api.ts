import type { CustomerCandidate, MyobStatus, Order, SubmitResult } from './types';

export async function extractOrder(po: File, drawing: File): Promise<Order> {
  const fd = new FormData();
  fd.append('po', po);
  fd.append('drawing', drawing);
  const res = await fetch('/api/extract', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Extraction failed');
  return data as Order;
}

export async function searchCustomers(q: string): Promise<CustomerCandidate[]> {
  if (!q) return [];
  const res = await fetch(`/api/myob/customer-search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.candidates || [];
}

export async function submitToMyob(
  order: Order,
  customerIdOverride: string
): Promise<SubmitResult> {
  const res = await fetch('/api/submit-myob', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order, customerIdOverride })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error || 'MYOB submission failed';
    const details =
      typeof data.details === 'object' ? JSON.stringify(data.details, null, 2) : data.details || '';
    const err = new Error(msg + (details ? '\n\n' + details : ''));
    throw err;
  }
  return data as SubmitResult;
}

export async function getMyobStatus(): Promise<MyobStatus> {
  try {
    const res = await fetch('/api/myob/status');
    return await res.json();
  } catch {
    return { configured: false, host: null, connected: false };
  }
}
