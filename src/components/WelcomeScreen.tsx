import React, { useState } from 'react';

type Props = {
  onEnter: () => void;
};

const SECTIONS: { title: string; body: string }[] = [
  {
    title: 'What is Vhay?',
    body: 'Vhay is a B2B procurement platform built on the XRP Ledger. Purchase orders, escrow-backed settlement, and permissioned credentials all run live on-chain — giving buyers and sellers a verifiable, trust-minimized way to transact.',
  },
  {
    title: 'Buyer vs. Seller Mode',
    body: 'Use the Buy / Sell toggle at the top to switch roles. In Buyer mode you find products and sellers in a central marketplace, then create and fund purchase orders. In Seller mode you list inventory, accept incoming POs, and claim settlement. Your profile and links carry across both.',
  },
  {
    title: 'Creating & Managing a PO (Buyer)',
    body: 'In Buyer mode, open Create to draft a PO — pick a linked vendor, add line items, set payment terms, and issue it on-chain. From there you can edit or recall an open PO, and fund the escrow when you\u2019re ready to commit the payment.',
  },
  {
    title: 'Accepting & Claiming a PO (Seller)',
    body: 'In Seller mode, incoming POs appear for you to accept. Once a buyer funds the escrow, use the Action tab to manage the order and claim settlement — the locked funds release to you on-chain when the terms are met.',
  },
  {
    title: 'Listing Inventory (Seller)',
    body: 'Sellers tokenize inventory as on-chain items that buyers can reference when creating POs. Add stock from the inventory area; each item is minted to your warehouse and tracked as units are ordered and settled.',
  },
];

export const WelcomeScreen: React.FC<Props> = ({ onEnter }) => {
  const [step, setStep] = useState(0);
  const isFirst = step === 0;
  const isLast = step === SECTIONS.length - 1;
  const section = SECTIONS[step];

  const next = () => { if (isLast) onEnter(); else setStep(s => s + 1); };
  const back = () => { if (!isFirst) setStep(s => s - 1); };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div className="glass" style={{
        width: '100%', maxWidth: 520, borderRadius: 20,
        padding: 32, display: 'flex', flexDirection: 'column', gap: 20, position: 'relative',
      }}>
        {/* Skip — always available */}
        <button
          type="button"
          onClick={onEnter}
          style={{
            position: 'absolute', top: 18, right: 20,
            background: 'transparent', border: 0, cursor: 'pointer',
            fontSize: 12, fontWeight: 500, color: 'var(--ink-3)', fontFamily: 'inherit',
          }}
        >
          Skip
        </button>

        {/* Wordmark */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{
            fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 700, fontSize: 32,
            lineHeight: 1.05, letterSpacing: '-0.02em', color: 'oklch(0.82 0.14 78)',
            textShadow: '0 1px 0 rgba(255,255,255,0.7), 0 -1px 1px rgba(90,55,10,0.4)',
          }}>
            Vhay
          </span>
          <span className="mono" style={{
            fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)',
          }}>
            Your trade platform for the modern supply chain
          </span>
        </div>

        {/* Current step card */}
        <div className="etched" style={{ padding: 20, borderRadius: 12, minHeight: 180 }}>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--ink)', marginBottom: 8,
          }}>
            {section.title}
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            {section.body}
          </div>
        </div>

        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
          {SECTIONS.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === step ? 20 : 8,
                height: 8,
                borderRadius: 999,
                background: i === step ? 'oklch(0.82 0.14 78)' : 'rgba(180,140,60,0.3)',
                transition: 'width 0.25s, background 0.25s',
              }}
            />
          ))}
        </div>

        {/* Nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={back}
            disabled={isFirst}
            style={{
              padding: '11px 18px', borderRadius: 12, cursor: isFirst ? 'default' : 'pointer',
              background: 'transparent',
              border: '1px solid rgba(180, 140, 60, 0.28)',
              color: isFirst ? 'rgba(133,121,89,0.4)' : 'var(--ink-2)',
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
              opacity: isFirst ? 0.5 : 1,
            }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={next}
            style={{
              flex: 1,
              padding: '12px 18px', borderRadius: 12, border: 0, cursor: 'pointer',
              background: 'linear-gradient(180deg, oklch(0.92 0.1 86), oklch(0.82 0.14 78))',
              color: '#2a1f08', fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 4px 12px -4px rgba(200,150,50,0.6)',
            }}
          >
            {isLast ? 'Enter Vhay' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
};