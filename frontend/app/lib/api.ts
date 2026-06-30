import type {
  CatalogStatus,
  CatalogUploadResult,
  CustomerCandidate,
  MyobStatus,
  Order,
  RoofingOrder,
  SkuMatchResult,
  SubmitResult
} from './types';

export async function extractOrder(po: File, drawing: File): Promise<Order> {
  const fd = new FormData();
  fd.append('po', po);
  fd.append('drawing', drawing);
  const res = await fetch('/api/extract', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Extraction failed');
  return data as Order;
}

export interface PdfTextResult {
  pageCount: number;
  hasText: boolean;
  text: string;
  pages: { pageNumber: number; text: string }[];
  note?: string;
}

/** Extract raw PDF text locally on the backend — no API key required. */
export async function extractPdfText(file: File): Promise<PdfTextResult> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/extract-text', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Text extraction failed');
  return data as PdfTextResult;
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

export async function extractRoofingOrder(report: File): Promise<RoofingOrder> {
  const fd = new FormData();
  fd.append('report', report);
  const res = await fetch('/api/roofing/extract', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Extraction failed');
  return data as RoofingOrder;
}

export async function submitRoofingToMyob(
  order: RoofingOrder,
  customerIdOverride: string
): Promise<SubmitResult> {
  const res = await fetch('/api/roofing/submit-myob', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order, customerIdOverride })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error || 'MYOB submission failed';
    const details =
      typeof data.details === 'object' ? JSON.stringify(data.details, null, 2) : data.details || '';
    throw new Error(msg + (details ? '\n\n' + details : ''));
  }
  return data as SubmitResult;
}

export async function matchRoofingSkus(
  items: { description: string; profile: string }[],
  colour: string,
  roofProfile = ''
): Promise<SkuMatchResult[]> {
  const res = await fetch('/api/sku-catalog/match-roofing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, colour, roof_profile: roofProfile })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'SKU match failed');
  return data.matches || [];
}

export async function getCatalogStatus(): Promise<CatalogStatus> {
  try {
    const res = await fetch('/api/sku-catalog/status');
    return await res.json();
  } catch {
    return { configured: false, connected: false, total: 0, files: [] };
  }
}

export async function uploadCatalogFiles(files: File[]): Promise<CatalogUploadResult> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch('/api/sku-catalog/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Catalog upload failed');
  return data as CatalogUploadResult;
}

export async function searchCatalog(q: string, limit = 30): Promise<any[]> {
  const res = await fetch(
    `/api/sku-catalog/search?q=${encodeURIComponent(q)}&limit=${limit}`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

export async function deleteCatalogSource(source: string): Promise<number> {
  const res = await fetch(`/api/sku-catalog/source/${encodeURIComponent(source)}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Delete failed');
  return data.deleted || 0;
}

export async function getMyobStatus(): Promise<MyobStatus> {
  try {
    const res = await fetch('/api/myob/status');
    return await res.json();
  } catch {
    return { configured: false, host: null, connected: false };
  }
}
