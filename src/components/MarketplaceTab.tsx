// ▼▼▼ MARKETPLACE ▼▼▼ Task 5.2 Tier 3 — Step 4b buyer marketplace tab (read-only shell).
// Self-contained / removable. Search, detail panel, and Create-PO/Link come in 4c–4e.
import React, { useState, useEffect } from 'react';
import { loadMarketplace, DIDResolver } from '../utils/marketplaceDiscovery';
import type { VendorStorefront } from '../utils/marketplaceStorefront';

type Props = { resolveDID: DIDResolver };

// One flattened row = a product + its vendor identity, for the table.
type Row = {
  vendorAddr: string;
  vendorName: string;
  vendorCountry: string;
  partNumber: string;
  name: string;
  shortDescription: string;
  price: number;
  currency: string;
};

export const MarketplaceTab: React.FC<Props> = ({ resolveDID }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const stores: VendorStorefront[] = await loadMarketplace(resolveDID);
        const flat: Row[] = [];
        stores.forEach((s) => {
          (s.items || []).forEach((it) => {
            flat.push({
              vendorAddr: s.addr,
              vendorName: s.identity ? (s.identity.name || s.addr) : s.addr,
              vendorCountry: s.identity ? (s.identity.country || '') : '',
              partNumber: it.partNumber || '',
              name: it.name || '',
              shortDescription: it.shortDescription || '',
              price: typeof it.price === 'number' ? it.price : 0,
              currency: it.currency || 'USD',
            });
          });
        });
        if (!cancelled) setRows(flat);
      } catch (e: any) {
        if (!cancelled) setError(e && e.message ? e.message : 'Failed to load marketplace');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [resolveDID]);

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ marginBottom: 16 }}>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Buy · Marketplace</div>
        <h1 style={{ margin: '4px 0 4px', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>Marketplace</h1>
        <div style={{ color: 'var(--ink-2)', fontSize: 14 }}>Browse suppliers and products across Vhay.</div>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>Loading marketplace…</div>}
      {error && <div style={{ padding: 20, color: '#6a2a10', fontSize: 13 }}>Error: {error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>No products found yet.</div>
      )}
      {!loading && !error && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <th style={{ padding: '8px 10px' }}>Supplier</th>
              <th style={{ padding: '8px 10px' }}>Product</th>
              <th style={{ padding: '8px 10px' }}>Part #</th>
              <th style={{ padding: '8px 10px' }}>Description</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.vendorAddr + '-' + r.partNumber + '-' + i} style={{ borderTop: '1px solid rgba(180,140,60,0.12)' }}>
                <td style={{ padding: '10px' }}>{r.vendorName}{r.vendorCountry ? <span style={{ color: 'var(--ink-3)' }}> · {r.vendorCountry}</span> : null}</td>
                <td style={{ padding: '10px' }}>{r.name || '—'}</td>
                <td style={{ padding: '10px', fontFamily: 'var(--font-mono, ui-monospace, Menlo, monospace)' }}>{r.partNumber || '—'}</td>
                <td style={{ padding: '10px', color: 'var(--ink-2)' }}>{r.shortDescription || '—'}</td>
                <td style={{ padding: '10px', textAlign: 'right' }}>{r.price ? r.currency + ' ' + r.price : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
// ▲▲▲ MARKETPLACE ▲▲▲
