import React, { useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────
// INTERIM DRAFT LEGAL TEXT — pending legal review.
// Replace TERMS_TEXT and PRIVACY_TEXT with lawyer-finalized copy.
// [TBD] markers indicate values the entity/lawyer must supply.
//
// NOTES FOR LEGAL COUNSEL (not shown to users):
// - Clause 2: a prior draft asserted Vhay "is not a broker, dealer, financial
//   institution, or intermediary" — that assertion was removed. The financing/
//   yield flows (currently inactive) may place Vhay in a payment path; please
//   advise on appropriate characterization and any MTL/MSB/GENIUS Act framing.
// - Section 10: financing features (escrow yield, PO financing, inventory
//   financing) involve licensed lender partners and payment routing, raising
//   separate regulatory questions (MTL, true-lender doctrine, broker/CFDL
//   disclosures). Terms covering them should be added before those features
//   are enabled for users.
// - Outstanding [TBD] items: governing-law state, data-controller contact email.
// - Acceptance is currently a per-device localStorage flag; real users should
//   have acceptance recorded server-side (timestamp + version).
// ─────────────────────────────────────────────────────────────

export const TERMS_TEXT = `DRAFT — PENDING LEGAL REVIEW. Interim terms for the invite-only preview. Not final legal text.

Terms of Use

1. Acceptance
By accessing Vhay (the "Platform", operated by Vhay Hold LLC), you agree to these Terms of Use. If you do not agree, do not use the Platform. This is an invite-only preview provided for testing and evaluation.

2. The Platform is a tool
Vhay is software that lets users create purchase orders, lock and settle payments in escrow, and manage credentials and inventory on the XRP Ledger ("XRPL"), a public blockchain. For the core purchase-order and escrow workflow, the Platform provides a non-custodial interface: transactions are signed and submitted from your own self-custodial wallet, and Vhay does not take custody of your funds or hold your wallet seeds.

3. Wallet and key responsibility
You are solely responsible for the security of your XRPL wallet(s), seed(s), and any credentials you enter. Vhay does not store, recover, or have access to your wallet seeds. Anyone with your seed controls your funds. Loss of a seed means permanent loss of access, and Vhay cannot recover it.

4. On-chain activity is irreversible
Transactions submitted to the XRPL are permanent and irreversible once validated. You are responsible for reviewing every transaction before you sign and submit it, including amounts, recipients, and terms. Vhay is not liable for losses arising from transactions you authorize, from smart-contract or ledger behavior, from network conditions, or from your own errors.

5. Acceptable use
You agree not to use the Platform for any unlawful purpose, to defraud or harm others, to launder funds, to evade sanctions, or in violation of any applicable law. You agree not to interfere with the Platform's operation or attempt unauthorized access to it or to other users' data.

6. No warranty
The Platform is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose, availability, or that it will be error-free or uninterrupted. This is preview software and may contain bugs.

7. Limitation of liability
To the maximum extent permitted by applicable law, Vhay Hold LLC and its operators shall not be liable for any indirect, incidental, or consequential damages, or for lost funds, lost profits, or lost data, arising from your use of the Platform.

8. Changes
These Terms may be updated. Continued use after an update constitutes acceptance of the revised Terms.

9. Governing law
These Terms are governed by [GOVERNING LAW / JURISDICTION — TBD: expected to be the U.S. state of Vhay Hold LLC's formation; confirm with counsel].

10. Financial products not active in this preview
Advanced financial features (escrow yield, purchase-order financing, and inventory financing) are not active in this invite-only preview.

Contact: [CONTACT EMAIL — TBD]

[Note for legal review: for real (non-preview) users, acceptance should be recorded server-side with timestamp and version, rather than the current per-device localStorage flag.]`;
export const PRIVACY_TEXT = `DRAFT — PENDING LEGAL REVIEW. Interim privacy notice for the invite-only preview. Not final legal text.

Privacy Policy

1. Who we are
This preview of Vhay (the "Platform") is operated by Vhay Hold LLC. Data controller contact: [DATA CONTROLLER CONTACT — TBD].

2. Data we process
- Profile information you enter (e.g. company name, contact details, addresses).
- XRPL wallet addresses associated with your activity.
- Documents and profile data pinned to IPFS via third-party pinning services.
- Your access to the preview (the invite password you use is not tied to a personal identity in this phase).

3. Public and permanent on-chain / IPFS data
IMPORTANT: Data written to the XRP Ledger and data pinned to IPFS is public by design and permanent. It cannot be edited or deleted once published. This includes wallet addresses, transaction data, and profile/document content anchored on-chain or pinned to IPFS. Because of this permanence, the right to erasure (where it would otherwise apply) cannot be exercised over data already published to these public, decentralized systems.

4. Legal basis (where GDPR applies)
Where the EU General Data Protection Regulation applies, we process data on the basis of your consent (your use of this preview), our legitimate interest in operating and securing the preview, and to perform the service you request.

5. Third-party processors
The Platform uses third-party IPFS pinning providers (e.g. Pinata, Filebase) to store profile and document data. Data handled by these providers is subject to their own terms and privacy practices.

6. Retention
On-chain and IPFS data is permanent and cannot be deleted (see section 3). Any locally stored data (e.g. in your browser) persists on your device until you clear it.

7. Your rights
Subject to applicable law and the permanence limitations above, you may request access to, or correction of, personal data we hold off-chain. Contact [DATA CONTROLLER CONTACT — TBD]. Where GDPR applies, you also have the right to lodge a complaint with your local supervisory authority.

8. Changes
This notice may be updated. Material changes will be reflected here.

Contact: [DATA CONTROLLER CONTACT — TBD]`;

type DocModalProps = {
  title: string;
  text: string;
  onAccept: () => void;
  onClose: () => void;
};

export const LegalDocModal: React.FC<DocModalProps> = ({ title, text, onAccept, onClose }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      const fits = el.scrollHeight <= el.clientHeight + 4;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      if (fits || atEnd) setReachedEnd(true);
    };
    check();
    el.addEventListener('scroll', check);
    return () => el.removeEventListener('scroll', check);
  }, []);

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(40,25,8,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div className="glass-strong" style={{
        width: '100%', maxWidth: 560, maxHeight: '82vh', borderRadius: 18, padding: 28,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
        <div
          ref={scrollRef}
          style={{
            overflowY: 'auto', fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.6,
            whiteSpace: 'pre-wrap', paddingRight: 6,
          }}
        >
          {text}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '9px 16px', borderRadius: 10, background: 'transparent',
              border: '1px solid rgba(180, 140, 60, 0.28)', color: 'var(--ink-2)',
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Close
          </button>
          {reachedEnd && (
            <button
              type="button"
              onClick={onAccept}
              style={{
                padding: '9px 18px', borderRadius: 10, border: 0, cursor: 'pointer',
                background: 'linear-gradient(180deg, oklch(0.92 0.1 86), oklch(0.82 0.14 78))',
                color: '#2a1f08', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              }}
            >
              Accept
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
