// ▼▼▼ MARKETPLACE ▼▼▼ Task 5.2 Tier 3 — Step 4c: two-column buyer marketplace.
// Left: supplier/product table (Stock-Ledger styled) + search + category filter.
// Right: detail panel, updates on row-select (populated in 4d; actions in 4e).
// Self-contained / removable. Styling copied from App.tsx Stock Ledger.
import React, { useState, useEffect, useMemo } from 'react';
import { loadMarketplace, DIDResolver } from '../utils/marketplaceDiscovery';
import type { VendorStorefront } from '../utils/marketplaceStorefront';
import { IconSearch, IconX } from './icons';
import { Card } from './primitives';

type Props = { resolveDID: DIDResolver };

type Row = {
  rowKey: string;
  vendorAddr: string;
  vendorName: string;
  vendorCountry: string;
  vendorWebsite: string;
  vendorDescription: string;
  vendorContact: string;
  sku: string;
  partNumber: string;
  name: string;
  shortDescription: string;
  price: number;
  currency: string;
  category: string;
  imageCid: string;
  nftId: string;
  mptIssuanceId: string;
};

export const MarketplaceTab: React.FC<Props> = ({ resolveDID }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // resolveDID gets a new reference on every App re-render (not memoized), so we
  // capture the latest in a ref and load ONCE on mount — otherwise every parent
  // re-render retriggers the whole marketplace load (the "reload pop").
  const resolveDIDRef = React.useRef(resolveDID);
  resolveDIDRef.current = resolveDID;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const stores: VendorStorefront[] = await loadMarketplace(resolveDIDRef.current);
        const flat: Row[] = [];
        stores.forEach((s) => {
          const id = s.identity || ({} as any);
          (s.items || []).forEach((it: any, idx: number) => {
            flat.push({
              rowKey: s.addr + '-' + (it.partNumber || it.name || idx),
              vendorAddr: s.addr,
              vendorName: id.name || s.addr,
              vendorCountry: id.country || '',
              vendorWebsite: id.website || '',
              vendorDescription: id.description || '',
              vendorContact: id.contact || '',
              sku: it.sku || '',
              partNumber: it.partNumber || '',
              name: it.name || '',
              shortDescription: it.shortDescription || '',
              price: typeof it.price === 'number' ? it.price : 0,
              currency: it.currency || 'USD',
              category: it.category || '',
              imageCid: it.imageCid || '',
              nftId: it.nftId || '',
              mptIssuanceId: it.mptIssuanceId || '',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // load once on mount; resolveDID read via ref

  const categories = useMemo(() => {
    const set: { [k: string]: true } = {};
    rows.forEach((r) => { if (r.category) set[r.category] = true; });
    return ['All'].concat(Object.keys(set).sort());
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (category !== 'All' && r.category !== category) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().indexOf(q) !== -1 ||
        r.shortDescription.toLowerCase().indexOf(q) !== -1 ||
        r.vendorName.toLowerCase().indexOf(q) !== -1 ||
        r.partNumber.toLowerCase().indexOf(q) !== -1
      );
    });
  }, [rows, query, category]);

  const selected = useMemo(
    () => filtered.find((r) => r.rowKey === selectedKey) || rows.find((r) => r.rowKey === selectedKey) || null,
    [filtered, rows, selectedKey]
  );

  const COLS = 'minmax(0, 1fr) 80px minmax(0, 1.4fr) minmax(0, 1.1fr)';
  const fmt = (n: number) => '$' + Number(n || 0).toFixed(2);

  return (
    <div style={{ maxWidth: 1440 }}>
      <div style={{ marginBottom: 16 }}>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Buy · Marketplace</div>
        <h1 style={{ margin: '4px 0 4px', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>Marketplace</h1>
        <div style={{ color: 'var(--ink-2)', fontSize: 14 }}>Browse suppliers and products across Vhay.</div>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>Loading marketplace…</div>}
      {error && <div style={{ padding: 20, color: '#6a2a10', fontSize: 13 }}>Error: {error}</div>}

      {!loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, alignItems: 'flex-start' }}>

          {/* LEFT — search + filter + table */}
          <Card layered style={{ padding: 18 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div className="glass etched" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 10 }}>
                <IconSearch size={13} style={{ color: 'var(--ink-3)' }}/>
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search product, supplier, part #…"
                  style={{ flex: 1, border: 0, background: 'transparent', outline: 'none', fontSize: 13, fontFamily: 'inherit' }}/>
                {query && (
                  <button type="button" onClick={() => setQuery('')}
                    style={{ color: 'var(--ink-3)', background: 'transparent', border: 0, cursor: 'pointer', padding: 2 }}>
                    <IconX size={12}/>
                  </button>
                )}
              </div>
              <div className="glass etched" style={{ width: 150, padding: '6px 10px', borderRadius: 10 }}>
                <div className="mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Category</div>
                <select value={category} onChange={(e) => setCategory(e.target.value)}
                  style={{ width: '100%', border: 0, background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 500, color: 'var(--ink)', fontFamily: 'inherit', padding: '2px 0', marginTop: 2, cursor: 'pointer' }}>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8 }}>
              {filtered.length} of {rows.length} products
            </div>

            <div style={{ maxHeight: 460, overflow: 'auto', borderRadius: 10, border: '1px solid rgba(180, 140, 60, 0.12)' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '10px 14px',
                borderBottom: '1px solid rgba(180, 140, 60, 0.15)',
                position: 'sticky', top: 0, zIndex: 2,
                background: 'rgba(255, 248, 222, 0.95)', backdropFilter: 'blur(8px)',
                fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)', whiteSpace: 'nowrap',
              }} className="mono">
                <span>Product</span>
                <span style={{ textAlign: 'left' }}>Price</span>
                <span>Description</span>
                <span>Supplier</span>
              </div>

              {filtered.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--ink-3)' }}>No products match your search.</div>
              ) : filtered.map((r) => {
                const isActive = selectedKey === r.rowKey;
                return (
                  <button key={r.rowKey} type="button"
                    onClick={() => setSelectedKey(r.rowKey)}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255, 248, 222, 0.5)'; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                    style={{
                      width: '100%', textAlign: 'left', display: 'grid', gridTemplateColumns: COLS,
                      gap: 10, padding: '11px 14px', alignItems: 'center',
                      background: isActive ? 'rgba(255, 232, 170, 0.55)' : 'transparent',
                      border: 0, borderLeft: isActive ? '3px solid oklch(0.78 0.14 78)' : '3px solid transparent',
                      borderBottom: '1px solid rgba(180, 140, 60, 0.08)',
                      transition: 'background 0.12s ease', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                    }}>
                    <span title={r.name} style={{ fontSize: 12.5, fontWeight: isActive ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || '—'}</span>
                    <span className="mono" style={{ fontSize: 12, textAlign: 'left' }}>{r.price ? fmt(r.price) : '—'}</span>
                    <span title={r.shortDescription} style={{ fontSize: 11.5, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.shortDescription || '—'}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vendorName}{r.vendorCountry ? ' · ' + r.vendorCountry : ''}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* RIGHT — detail panel (placeholder in 4c; filled in 4d) */}
          <Card layered style={{ padding: 18, position: 'sticky', top: 12, minHeight: 300 }}>
            {!selected ? (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 13 }}>
                Select a product to see details.
              </div>
            ) : (
              <div>
                <div className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>Product</div>
                <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 4 }}>{selected.name || 'Unnamed product'}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 12 }}>{selected.shortDescription || 'No description.'}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{selected.price ? fmt(selected.price) : 'Price on request'}</div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-3)' }} className="mono">{selected.partNumber ? 'Part # ' + selected.partNumber : ''}</div>
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(180,140,60,0.15)' }}>
                  <div className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>Supplier</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{selected.vendorName}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{selected.vendorCountry || '—'}</div>
                  {selected.vendorDescription && <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 6 }}>{selected.vendorDescription}</div>}
                </div>
                {/* 4d: live quantity, image, docs. 4e: Create PO / Link actions. */}
              </div>
            )}
          </Card>

        </div>
      )}
    </div>
  );
};
// ▲▲▲ MARKETPLACE ▲▲▲