import React from 'react';
import {
  IconPlus,
  IconSpark,
  IconChart,
  IconWallet,
  IconBook,
  IconUser,
  IconBox,
} from './icons';
import type { IconProps } from './icons';
import {
  displayToInternal,
  internalToDisplay,
  DisplayTab,
  InternalTab,
  Mode,
} from './navMapping';

type NavItem = {
  k: DisplayTab;
  label: string;
  icon: React.FC<IconProps>;
  hint?: string | null;
};

type Props = {
  mode: Mode;
  activeTab: InternalTab;
  setActiveTab: (tab: InternalTab) => void;
};

export const Sidebar: React.FC<Props> = ({ mode, activeTab, setActiveTab }) => {
  const items: NavItem[] = mode === 'customer'
    ? [
        { k: 'create',     label: 'Create',     icon: IconPlus,   hint: 'New PO' },
        { k: 'action',     label: 'Action',     icon: IconSpark,  hint: null },
        { k: 'overview',   label: 'Overview',   icon: IconChart,  hint: null },
        { k: 'financing',  label: 'Financing',  icon: IconWallet, hint: 'yield' },
        { k: 'accounting', label: 'Accounting', icon: IconBook,   hint: null },
        { k: 'profile',    label: 'Profile',    icon: IconUser,   hint: null },
      ]
    : [
        { k: 'overview',   label: 'Overview',   icon: IconChart,  hint: null },
        { k: 'action',     label: 'Action',     icon: IconSpark,  hint: null },
        { k: 'inventory',  label: 'Inventory',  icon: IconBox,    hint: null },
        { k: 'financing',  label: 'Financing',  icon: IconWallet, hint: 'credit' },
        { k: 'accounting', label: 'Accounting', icon: IconBook,   hint: null },
        { k: 'profile',    label: 'Profile',    icon: IconUser,   hint: null },
      ];

  const activeDisplay = internalToDisplay(activeTab);

  return (
    <div style={{ position: 'sticky', top: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <nav
      className="glass layered-plate"
      style={{
        padding: 14,
        borderRadius: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minHeight: 440,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: 'var(--ink-3)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          padding: '8px 10px 12px',
        }}
      >
        {mode === 'customer' ? 'Purchasing' : 'Sales & Stock'}
      </div>

      {items.map((it) => {
        const active = activeDisplay === it.k;
        const I = it.icon;
        return (
          <button
            type="button"
            key={it.k}
            onClick={() => setActiveTab(displayToInternal(it.k, mode))}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 12,
              background: active ? 'rgba(255, 248, 220, 0.85)' : 'transparent',
              boxShadow: active
                ? 'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 2px rgba(120,80,20,0.08)'
                : 'none',
              border: active ? '1px solid rgba(180,140,60,0.18)' : '1px solid transparent',
              color: active ? 'var(--ink)' : 'var(--ink-2)',
              fontSize: 13.5,
              fontWeight: active ? 600 : 500,
              transition: 'all 0.2s ease',
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <I size={16} stroke={active ? 1.8 : 1.5} />
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.hint && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: 'var(--ink-3)',
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: 'rgba(180, 140, 60, 0.1)',
                  whiteSpace: 'nowrap',
                }}
              >
                {it.hint}
              </span>
            )}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />
      
    </nav>

    {/* Brand mark — below the ribbon, prominent brand statement */}
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <img
        src="/logo.png"
        alt="Vhay"
        style={{
          width: 200,
          height: 200,
          objectFit: 'contain',
          filter: 'drop-shadow(0 6px 20px rgba(180, 120, 20, 0.35))',
          opacity: 0.95,
        }}
      />
    </div>
    </div>
  );
};
