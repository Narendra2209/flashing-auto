'use client';

import { useEffect, useState } from 'react';
import {
  deleteCatalogSource,
  getCatalogStatus,
  searchCatalog,
  uploadCatalogFiles
} from '../lib/api';
import type { CatalogStatus } from '../lib/types';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState<any[]>([]);

  const refresh = async () => {
    setLoading(true);
    const s = await getCatalogStatus();
    setStatus(s);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPickFiles = async (filesList: FileList | null) => {
    if (!filesList || !filesList.length) return;
    const files = Array.from(filesList).filter(
      (f) => f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls')
    );
    if (!files.length) {
      setUploadMsg('No .xlsx/.xls files in selection.');
      return;
    }
    setUploading(true);
    setUploadMsg(`Uploading ${files.length} file(s)…`);
    try {
      const res = await uploadCatalogFiles(files);
      const inserted = res.uploaded.reduce((s, r) => s + r.total_inserted, 0);
      const errLine = res.errors.length
        ? ` · ${res.errors.length} error(s)`
        : '';
      setUploadMsg(
        `✓ ${res.uploaded.length} file(s) processed, ${inserted} row(s) inserted${errLine}. Catalog now has ${res.total_in_catalog} SKUs across ${res.files_in_catalog} file(s).`
      );
      if (res.errors.length) {
        console.warn('Catalog upload errors:', res.errors);
      }
      await refresh();
    } catch (err: any) {
      setUploadMsg('⚠ ' + (err.message || 'Upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const onDeleteSource = async (name: string) => {
    if (!confirm(`Delete all ${status?.files.find((f) => f.source_file === name)?.count ?? ''} SKUs from "${name}"?`)) return;
    try {
      await deleteCatalogSource(name);
      await refresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const onSearch = async () => {
    const hits = await searchCatalog(searchQ, 50);
    setSearchHits(hits);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>SKU Catalog (MongoDB)</h3>
            <button
              className="btn btn-secondary settings-refresh"
              onClick={refresh}
              disabled={loading}
            >
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <p className="muted">Loading…</p>
          ) : !status?.configured ? (
            <div className="error-banner">
              <strong>MongoDB not configured.</strong>
              <br />
              Add a free Atlas cluster at{' '}
              <code>cloud.mongodb.com</code>, then paste the connection string into{' '}
              <code>backend/.env</code> as <code>MONGODB_URI=...</code> and restart the
              backend.
            </div>
          ) : !status.connected ? (
            <div className="error-banner">
              <strong>Connected but unreachable.</strong>
              <br />
              {status.message}
            </div>
          ) : (
            <div className="status-line ok">
              ✓ Connected · <strong>{status.total}</strong> SKU(s) across{' '}
              <strong>{status.files.length}</strong> file(s)
            </div>
          )}

          <label
            className={`dropzone ${uploading ? 'busy' : ''}`}
            htmlFor="catalog-files-input"
          >
            <div className="dz-icon">📊</div>
            <div className="dz-title">
              {uploading ? 'Uploading…' : 'Drop Excel files or click to select'}
            </div>
            <div className="dz-sub">
              Pick multiple .xlsx files at once · re-uploading a file replaces its
              rows
            </div>
            <input
              id="catalog-files-input"
              type="file"
              accept=".xlsx,.xls"
              multiple
              disabled={uploading || !status?.configured}
              onChange={(e) => {
                onPickFiles(e.target.files);
                // Reset so the same file can be re-picked.
                e.target.value = '';
              }}
            />
          </label>

          {uploadMsg && <div className="upload-msg">{uploadMsg}</div>}

          {!!status?.files?.length && (
            <div className="catalog-files">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th style={{ textAlign: 'right' }}>SKUs</th>
                    <th>Uploaded</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.files.map((f) => (
                    <tr key={f.source_file}>
                      <td>{f.source_file}</td>
                      <td style={{ textAlign: 'right' }}>{f.count}</td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {f.uploaded_at
                          ? new Date(f.uploaded_at).toLocaleString()
                          : '—'}
                      </td>
                      <td>
                        <button
                          className="link-danger"
                          onClick={() => onDeleteSource(f.source_file)}
                        >
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {!!status?.total && (
          <section className="settings-section">
            <h3>Browse Catalog</h3>
            <div className="search-row">
              <input
                className="custid-input"
                placeholder="Search by SKU, product name or description…"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSearch();
                }}
              />
              <button className="btn btn-secondary" onClick={onSearch}>
                Search
              </button>
            </div>
            {!!searchHits.length && (
              <div className="catalog-hits">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>Material</th>
                      <th>Colour</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchHits.map((h, i) => (
                      <tr key={i}>
                        <td>
                          <span className="code-tag">{h.sku || '—'}</span>
                        </td>
                        <td>{h.product_name || '—'}</td>
                        <td className="muted">{h.material || '—'}</td>
                        <td className="muted">{h.colour || '—'}</td>
                        <td style={{ fontSize: 11 }}>{h.description || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
