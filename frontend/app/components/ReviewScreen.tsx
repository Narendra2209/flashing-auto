'use client';

import { useEffect, useState } from 'react';
import type { CustomerCandidate, LineItem, Order } from '../lib/types';
import { searchCustomers } from '../lib/api';

interface Props {
  order: Order;
  onOrderChange: (o: Order) => void;
  customerIdOverride: string;
  onCustomerIdChange: (id: string) => void;
  onReject: () => void;
  onUploadNew: () => void;
  onSubmit: () => void;
  submitting: boolean;
}

const COLOR_DOT_MAP: Record<string, string> = {
  NS: 'cdot-ns',
  SU: 'cdot-su',
  MO: 'cdot-mo',
  BA: 'cdot-ba'
};

function colorDot(code: string) {
  return COLOR_DOT_MAP[code] || 'cdot-ns';
}

export default function ReviewScreen({
  order,
  onOrderChange,
  customerIdOverride,
  onCustomerIdChange,
  onReject,
  onUploadNew,
  onSubmit,
  submitting
}: Props) {
  const [candidates, setCandidates] = useState<CustomerCandidate[]>([]);
  const [custStatus, setCustStatus] = useState('— searching MYOB…');

  useEffect(() => {
    let cancelled = false;
    searchCustomers(order.customer_name).then((list) => {
      if (cancelled) return;
      setCandidates(list);
      if (list.length) {
        onCustomerIdChange(list[0].id);
        setCustStatus(
          `— ${list.length} match${list.length > 1 ? 'es' : ''}, best: ${list[0].name}`
        );
      } else {
        setCustStatus('— no match, type the ID from MYOB');
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.customer_name]);

  const updateLine = (idx: number, field: 'pieces' | 'length', value: number) => {
    const items = order.line_items.slice();
    const item = { ...items[idx] };
    item[field] = value;
    item.qty = (Number(item.pieces) || 0) * (Number(item.length) || 0);
    items[idx] = item;
    onOrderChange({ ...order, line_items: items });
  };

  return (
    <div>
      <div className="review-header">
        <div>
          <div className="screen-title">
            Review Order <span style={{ color: 'var(--accent)' }}>#{order.po_number}</span>
          </div>
          <div className="screen-sub">
            Check all details before submitting to MYOB. You can edit pieces and lengths.
          </div>
        </div>
      </div>

      <div className="cards-row">
        <div className="card">
          <div className="card-label">Customer Details</div>
          <div className="info-grid">
            <InfoItem label="Customer" value={order.customer_name} />
            <InfoItem label="Contact" value={order.contact} />
            <InfoItem label="PO Number" value={order.po_number} tone="red" />
            <InfoItem label="Job No." value={order.job_number} />
            <div className="info-item" style={{ gridColumn: 'span 2' }}>
              <label>
                MYOB Customer ID <span className="cust-status">{custStatus}</span>
              </label>
              <input
                list="cust-suggestions"
                className="custid-input"
                placeholder="e.g. C0006"
                value={customerIdOverride}
                onChange={(e) => onCustomerIdChange(e.target.value)}
              />
              <datalist id="cust-suggestions">
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} — {c.name}
                  </option>
                ))}
              </datalist>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-label">Order Details</div>
          <div className="info-grid">
            <InfoItem label="Date Ordered" value={order.date_ordered} />
            <InfoItem label="Date Required" value={order.date_required} tone="green" />
            <InfoItem
              label="Type"
              value={order.delivery_type === 'PICKUP' ? '⚡ PICK UP' : '🚚 DELIVERY'}
              tone="orange"
            />
            <InfoItem label="Location" value={order.location} />
            <div className="info-item" style={{ gridColumn: 'span 2' }}>
              <label>Description</label>
              <div className="val">{order.description}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Inventory ID</th>
              <th>Colour</th>
              <th>Folds</th>
              <th>Girth</th>
              <th>Pieces</th>
              <th>Length (m)</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {order.line_items.map((item, idx) => (
              <LineRow
                key={idx}
                item={item}
                idx={idx}
                onChange={(field, value) => updateLine(idx, field, value)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="summary-row">
        <StatBox label="Flashings" value={String(order.line_items.length)} />
        <StatBox
          label="Total LM"
          value={Number(order.total_lm || 0).toFixed(1)}
          unit="lm"
        />
        <StatBox
          label="Total Sqm"
          value={Number(order.total_sqm || 0).toFixed(2)}
          unit="m²"
        />
        <div className="stat-box">
          <label>Colours</label>
          <div className="num" style={{ fontSize: 13, paddingTop: 6 }}>
            {(order.colours || []).join(' · ')}
          </div>
        </div>
      </div>

      {order.production_notes?.length > 0 && (
        <div className="notes-box">
          <div className="nt">⚠ Production Notes</div>
          <ul>
            {order.production_notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="action-bar">
        <button className="btn btn-danger" onClick={onReject}>
          ✕ Reject
        </button>
        <button className="btn btn-secondary" onClick={onUploadNew}>
          ← Upload New
        </button>
        <button
          className="btn btn-submit"
          onClick={onSubmit}
          disabled={submitting}
          style={submitting ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
        >
          {submitting ? 'Submitting…' : '✓ Approve & Submit to MYOB'}
        </button>
      </div>
    </div>
  );
}

function InfoItem({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: 'red' | 'green' | 'orange';
}) {
  return (
    <div className="info-item">
      <label>{label}</label>
      <div className={`val ${tone || ''}`.trim()}>{value}</div>
    </div>
  );
}

function StatBox({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="stat-box">
      <label>{label}</label>
      <div className="num">
        {value}
        {unit && <span className="unit"> {unit}</span>}
      </div>
    </div>
  );
}

function LineRow({
  item,
  idx,
  onChange
}: {
  item: LineItem;
  idx: number;
  onChange: (field: 'pieces' | 'length', value: number) => void;
}) {
  const rounded = item.girth_rounded !== item.girth_original;
  return (
    <tr>
      <td style={{ color: 'var(--muted)', fontSize: 12 }}>{item.item_number}</td>
      <td>
        <span className="code-tag">{item.inventory_id}</span>
      </td>
      <td>
        <span className="color-chip">
          <span className={`cdot ${colorDot(item.colour_code)}`} />
          {item.colour}
        </span>
      </td>
      <td>{item.folds}</td>
      <td>
        {rounded ? (
          <>
            <span className="girth-orig">{item.girth_original}</span>
            <span className="girth-new">{item.girth_rounded}</span>
            <span className="rounded-pill">↑ rounded</span>
          </>
        ) : (
          <strong>{item.girth_rounded}</strong>
        )}
        {item.tapered && (
          <span
            className="rounded-pill"
            style={{ background: '#fff0ff', borderColor: '#c084fc', color: '#7e22ce' }}
          >
            TAPERED
          </span>
        )}
      </td>
      <td>
        <input
          className="edit-num"
          type="number"
          value={item.pieces}
          min={1}
          onChange={(e) => onChange('pieces', Number(e.target.value) || 0)}
        />
      </td>
      <td>
        <input
          className="edit-num"
          type="number"
          step="0.001"
          value={item.length}
          onChange={(e) => onChange('length', Number(e.target.value) || 0)}
        />
      </td>
      <td>
        <strong>{Number(item.qty || 0).toFixed(3)}</strong>
      </td>
    </tr>
  );
}
