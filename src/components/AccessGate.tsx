import React, { useState } from 'react';
import { LegalDocModal, TERMS_TEXT, PRIVACY_TEXT } from './LegalDocs';

type Props = {
  onUnlock: (password: string) => boolean;
};

const TERMS_KEY = 'vhay_terms_accepted_v1';

export const AccessGate: React.FC<Props> = ({ onUnlock }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const [termsAccepted, setTermsAccepted] = useState<boolean>(
    () => localStorage.getItem(TERMS_KEY) === 'true'
  );
  const [termsDone, setTermsDone] = useState<boolean>(() => localStorage.getItem(TERMS_KEY) === 'true');
  const [privacyDone, setPrivacyDone] = useState<boolean>(() => localStorage.getItem(TERMS_KEY) === 'true');
  const [openDoc, setOpenDoc] = useState<null | 'terms' | 'privacy'>(null);

  const markAccepted = (which: 'terms' | 'privacy') => {
    const nextTerms = which === 'terms' ? true : termsDone;
    const nextPrivacy = which === 'privacy' ? true : privacyDone;
    setTermsDone(nextTerms);
    setPrivacyDone(nextPrivacy);
    setOpenDoc(null);
    if (nextTerms && nextPrivacy) {
      setTermsAccepted(true);
      localStorage.setItem(TERMS_KEY, 'true');
    }
  };

  const submit = () => {
    if (!termsAccepted) return;
    const ok = onUnlock(password);
    if (!ok) { setError(true); setPassword(''); }
  };

  const linkStyle: React.CSSProperties = {
    color: 'oklch(0.62 0.15 70)', textDecoration: 'underline', cursor: 'pointer',
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

        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12.5,
          color: 'var(--ink-2)', lineHeight: 1.5, cursor: 'default',
        }}>
          <input
            type="checkbox"
            checked={termsAccepted}
            readOnly
            style={{ marginTop: 2, accentColor: 'oklch(0.72 0.14 78)', cursor: 'default' }}
          />
          <span>
            I agree to the{' '}
            <span style={linkStyle} onClick={() => setOpenDoc('terms')}>Terms of Use</span>
            {' '}and{' '}
            <span style={linkStyle} onClick={() => setOpenDoc('privacy')}>Privacy Policy</span>
            {!termsAccepted && (
              <span style={{ color: 'var(--ink-3)' }}> (open and read both to continue)</span>
            )}
          </span>
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={!termsAccepted}
          style={{
            padding: '11px 18px', borderRadius: 12, border: 0,
            cursor: termsAccepted ? 'pointer' : 'default',
            opacity: termsAccepted ? 1 : 0.5,
            background: 'linear-gradient(180deg, oklch(0.92 0.1 86), oklch(0.82 0.14 78))',
            color: '#2a1f08', fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 4px 12px -4px rgba(200,150,50,0.6)',
          }}
        >
          Enter
        </button>
      </div>

      {openDoc === 'terms' && (
        <LegalDocModal
          title="Terms of Use"
          text={TERMS_TEXT}
          onAccept={() => markAccepted('terms')}
          onClose={() => setOpenDoc(null)}
        />
      )}
      {openDoc === 'privacy' && (
        <LegalDocModal
          title="Privacy Policy"
          text={PRIVACY_TEXT}
          onAccept={() => markAccepted('privacy')}
          onClose={() => setOpenDoc(null)}
        />
      )}
    </div>
  );
};