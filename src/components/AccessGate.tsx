import React, { useState } from 'react';

type Props = {
  onUnlock: (password: string) => boolean;
};

export const AccessGate: React.FC<Props> = ({ onUnlock }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const submit = () => {
    const ok = onUnlock(password);
    if (!ok) { setError(true); setPassword(''); }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div className="glass" style={{
        width: '100%', maxWidth: 520, borderRadius: 20, padding: 36,
        display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
          <img
            src="/logo.png"
            alt="Vhay"
            style={{ width: 300, height: 300, objectFit: 'contain' }}
          />
          <span className="mono" style={{
            fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)',
          }}>
            <span style={{ fontWeight: 700, color: 'oklch(0.72 0.14 78)' }}>Vhay</span>
            {' — Your trade platform for the modern supply chain'}
          </span>
        </div>
        
        <div className="mono" style={{
          fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)',
          marginBottom: -8,
        }}>
          Invite-only preview — enter your access password
        </div>
        <div className="etched" style={{
          display: 'flex', alignItems: 'center', padding: '8px 12px', borderRadius: 12,
        }}>
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(false); }}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="Access password"
            autoFocus
            style={{
              flex: 1, border: 0, background: 'transparent', outline: 'none',
              fontSize: 13, color: 'var(--ink)', fontFamily: 'inherit',
            }}
          />
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'oklch(0.55 0.18 25)' }}>
            Incorrect password. Please try again.
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          style={{
            padding: '11px 18px', borderRadius: 12, border: 0, cursor: 'pointer',
            background: 'linear-gradient(180deg, oklch(0.92 0.1 86), oklch(0.82 0.14 78))',
            color: '#2a1f08', fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 4px 12px -4px rgba(200,150,50,0.6)',
          }}
        >
          Enter
        </button>
      </div>
    </div>
  );
};
