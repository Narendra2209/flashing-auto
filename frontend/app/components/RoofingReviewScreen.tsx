'use client';

import { useEffect, useState } from 'react';
import type { CustomerCandidate, RoofingCut, RoofingLineItem, RoofingOrder } from '../lib/types';
import { matchRoofingSkus, searchCustomers } from '../lib/api';

interface Props {
  order: RoofingOrder;
  onOrderChange: (o: RoofingOrder) => void;
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

export default function RoofingReviewScreen({
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
  const [matching, setMatching] = useState(false);
  const [matchMsg, setMatchMsg] = useState('');

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

  const updateLine = (
    idx: number,
    field: 'quantity' | 'unit' | 'inventory_id',
    value: string | number
  ) => {
    const items = order.line_items.slice();
    const item: any = { ...items[idx] };
    item[field] = value;
    items[idx] = item;
    onOrderChange({ ...order, line_items: items });
  };

  const updateCuts = (idx: number, cuts: RoofingCut[]) => {
    const items = order.line_items.slice();
    items[idx] = { ...items[idx], cuts };
    onOrderChange({ ...order, line_items: items });
  };

  const handleAutoMatch = async () => {
    if (matching) return;
    setMatching(true);
    setMatchMsg('Matching SKUs from catalog…');
    try {
      const matches = await matchRoofingSkus(
        order.line_items.map((l) => ({
          description: l.description,
          profile: l.profile
        })),
        order.colour,
        order.roof_profile
      );
      let filled = 0;
      const items = order.line_items.map((l, i) => {
        const m = matches[i];
        // Only fill blank rows with a confident match — never overwrite a SKU
        // the user already typed or edited.
        if (!String(l.inventory_id || '').trim() && m?.confident && m.sku) {
          filled++;
          return { ...l, inventory_id: m.sku };
        }
        return l;
      });
      onOrderChange({ ...order, line_items: items });
      const noMatch = matches.filter((m) => !m.confident).length;
      setMatchMsg(
        filled
          ? `✓ Filled ${filled} SKU(s) from catalog${
              noMatch ? ` · ${noMatch} line(s) had no confident match` : ''
            }`
          : 'No new SKUs matched — check the catalog has these products for this colour.'
      );
    } catch (err: any) {
      setMatchMsg('⚠ ' + (err.message || 'SKU match failed'));
    } finally {
      setMatching(false);
    }
  };

  const filledSkus = order.line_items.filter((l) => String(l.inventory_id || '').trim()).length;
  const totalLines = order.line_items.length;

  return (
    <div>
      <div className="review-header">
        <div>
          <div className="screen-title">
            Review Roofing Order{' '}
            {order.po_number && <span style={{ color: 'var(--accent)' }}>#{order.po_number}</span>}
          </div>
          <div className="screen-sub">
            Check details before submitting to MYOB. Fill the Inventory ID for each line
            (lookup from your Google Sheet — coming soon) and edit quantities if needed.
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
                list="cust-suggestions-roofing"
                className="custid-input"
                placeholder="e.g. C0006"
                value={customerIdOverride}
                onChange={(e) => onCustomerIdChange(e.target.value)}
              />
              <datalist id="cust-suggestions-roofing">
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
          <div className="card-label">Roof Details</div>
          <div className="info-grid">
            <InfoItem label="Date Ordered" value={order.date_ordered} />
            <InfoItem label="Date Required" value={order.date_required} tone="green" />
            <InfoItem
              label="Colour"
              value={
                order.colour
                  ? `${order.colour}${order.colour_code ? ` (${order.colour_code})` : ''}`
                  : '—'
              }
              tone="orange"
            />
            <InfoItem
              label="Pitch"
              value={order.pitch ? `${order.pitch}°` : '—'}
            />
            <InfoItem
              label="Roof Profile"
              value={order.roof_profile || '—'}
            />
            <InfoItem
              label="Area"
              value={order.total_area_sqm ? `${order.total_area_sqm.toFixed(2)} m²` : '—'}
            />
            <div className="info-item" style={{ gridColumn: 'span 2' }}>
              <label>Site Address</label>
              <div className="val">{order.site_address || '—'}</div>
            </div>
            {order.description && (
              <div className="info-item" style={{ gridColumn: 'span 2' }}>
                <label>Description</label>
                <div className="val">{order.description}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sku-match-bar">
        <button
          className="btn btn-secondary"
          onClick={handleAutoMatch}
          disabled={matching}
        >
          {matching ? 'Matching…' : '⚡ Auto-match SKUs'}
        </button>
        {matchMsg && <span className="sku-match-msg">{matchMsg}</span>}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>Inventory ID (SKU)</th>
              <th>Qty</th>
              <th>Unit</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {order.line_items.map((item, idx) => (
              <RoofingLineRow
                key={idx}
                item={item}
                colourCode={order.colour_code}
                onChange={(field, value) => updateLine(idx, field, value)}
                onCutsChange={(cuts) => updateCuts(idx, cuts)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="summary-row">
        <StatBox label="Lines" value={String(totalLines)} />
        <StatBox label="SKUs Filled" value={`${filledSkus}/${totalLines}`} />
        <StatBox
          label="Area"
          value={Number(order.total_area_sqm || 0).toFixed(2)}
          unit="m²"
        />
        <div className="stat-box">
          <label>Colour</label>
          <div className="num" style={{ fontSize: 13, paddingTop: 6 }}>
            <span className="color-chip">
              <span className={`cdot ${colorDot(order.colour_code)}`} />
              {order.colour || '—'}
            </span>
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
      <div className={`val ${tone || ''}`.trim()}>{value || '—'}</div>
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

function RoofingLineRow({
  item,
  colourCode,
  onChange,
  onCutsChange
}: {
  item: RoofingLineItem;
  colourCode: string;
  onChange: (field: 'quantity' | 'unit' | 'inventory_id', value: string | number) => void;
  onCutsChange: (cuts: RoofingCut[]) => void;
}) {
  const filled = String(item.inventory_id || '').trim().length > 0;
  const cuts = Array.isArray(item.cuts) ? item.cuts : [];
  const hasCuts = cuts.length > 0;
  const cutTotalM = cuts.reduce((s, c) => s + (c.pieces * c.length_mm) / 1000, 0);

  const updateCut = (i: number, field: 'pieces' | 'length_mm', val: number) => {
    const next = cuts.slice();
    next[i] = { ...next[i], [field]: val };
    onCutsChange(next);
  };
  const removeCut = (i: number) => onCutsChange(cuts.filter((_, j) => j !== i));
  const addCut = () => onCutsChange([...cuts, { pieces: 1, length_mm: 0 }]);

  return (
    <>
      <tr>
        <td style={{ color: 'var(--muted)', fontSize: 12 }}>{item.item_number}</td>
        <td>
          <span className="color-chip">
            <span
              className={`cdot ${COLOR_DOT_MAP[colourCode] || 'cdot-ns'}`}
              style={{ flexShrink: 0 }}
            />
            <strong>{item.description}</strong>
          </span>
          {item.profile && <div className="profile-pill">{item.profile}</div>}
        </td>
        <td>
          <input
            className={`sku-input ${filled ? 'filled' : ''}`}
            type="text"
            placeholder="(set SKU)"
            value={item.inventory_id || ''}
            onChange={(e) => onChange('inventory_id', e.target.value)}
          />
        </td>
        <td>
          <input
            className="edit-num"
            type="number"
            step="0.01"
            value={item.quantity}
            onChange={(e) => onChange('quantity', Number(e.target.value) || 0)}
          />
        </td>
        <td>
          <select
            className="unit-select"
            value={item.unit || ''}
            onChange={(e) => onChange('unit', e.target.value)}
          >
            <option value="m">m</option>
            <option value="Sq.m">Sq.m</option>
            <option value="EA">EA</option>
            <option value="Rolls">Rolls</option>
          </select>
        </td>
        <td style={{ color: 'var(--muted)', fontSize: 12 }}>{item.notes || ''}</td>
      </tr>
      {hasCuts && (
        <tr className="cuts-row">
          <td />
          <td colSpan={5}>
            <div className="cuts-wrap">
              <div className="cuts-header">
                <span className="cuts-label">CUTS (pieces × length mm)</span>
                <span className="cuts-total">
                  Σ {cutTotalM.toFixed(3)} m / {cuts.reduce((s, c) => s + c.pieces, 0)} pcs
                </span>
              </div>
              <div className="cuts-list">
                {cuts.map((c, i) => (
                  <div key={i} className="cut-chip">
                    <input
                      className="cut-num"
                      type="number"
                      min={1}
                      value={c.pieces}
                      onChange={(e) => updateCut(i, 'pieces', Number(e.target.value) || 0)}
                    />
                    <span className="cut-x">/</span>
                    <input
                      className="cut-num cut-num-long"
                      type="number"
                      step={1}
                      value={c.length_mm}
                      onChange={(e) => updateCut(i, 'length_mm', Number(e.target.value) || 0)}
                    />
                    <button
                      type="button"
                      className="cut-rm"
                      onClick={() => removeCut(i)}
                      title="Remove cut"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="cut-add" onClick={addCut}>
                  + add cut
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
