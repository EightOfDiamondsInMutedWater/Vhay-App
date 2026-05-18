import React, { useMemo } from 'react';
import {
  IconCart,
  IconTag,
  IconSearch,
  IconBell,
  IconSettings,
} from './icons';
import type { Mode } from './navMapping';

export type TopBarNotification = {
  id: string | number;
  message: string;
  type?: 'info' | 'warning' | 'success';
  timestamp: number;
  read: boolean;
};

type Props = {
  mode: Mode;
  setMode: (m: Mode) => void;
  onAdminClick: () => void;
  onProfileClick: () => void;
  onBellClick: () => void;
  onClearNotifications: () => void;
  showNotifications: boolean;
  notifications: TopBarNotification[];
  unreadCount: number;
  profileName?: string;
};

export const TopBar: React.FC<Props> = ({
  mode,
  setMode,
  onAdminClick,
  onProfileClick,
  onBellClick,
  onClearNotifications,
  showNotifications,
  notifications,
  unreadCount,
  profileName,
}) => {
  const isBuy = mode === 'customer';

  const initials = useMemo(() => {
    if (!profileName) return '';
    const parts = profileName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    return (first + last).toUpperCase();
  }, [profileName]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        padding: '18px 28px',
        gap: 24,
        position: 'relative',
        zIndex: 2,
      }}
    >
      {/* Brand slot — logo moved to sidebar bottom */}
      <div/>

      {/* Mode toggle */}
      <div
        className="glass-strong"
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: 4,
          borderRadius: 999,
          position: 'relative',
          width: 280,
          height: 44,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 4,
            bottom: 4,
            left: isBuy ? 4 : '50%',
            width: 'calc(50% - 4px)',
            background: 'linear-gradient(180deg, oklch(0.92 0.1 86), oklch(0.82 0.14 78))',
            borderRadius: 999,
            transition: 'left 0.35s cubic-bezier(0.2, 0.9, 0.3, 1)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8), 0 4px 12px -4px rgba(200,150,50,0.6)',
          }}
        />
        <button
          type="button"
          onClick={() => setMode('customer')}
          style={{
            flex: 1,
            height: '100%',
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: isBuy ? '#2a1f08' : 'var(--ink-3)',
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: '-0.01em',
            transition: 'color 0.25s ease',
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <IconCart size={14} /> Buy
        </button>
        <button
          type="button"
          onClick={() => setMode('vendor')}
          style={{
            flex: 1,
            height: '100%',
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: !isBuy ? '#2a1f08' : 'var(--ink-3)',
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: '-0.01em',
            transition: 'color 0.25s ease',
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <IconTag size={14} /> Sell
        </button>
      </div>

      {/* Right cluster */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifySelf: 'end' }}>
        {/* Search — visual only */}
        <div
          className="glass etched"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 12px',
            borderRadius: 999,
          }}
        >
          <IconSearch size={14} style={{ color: 'var(--ink-3)' }} />
          <input
            placeholder="Search POs, SKUs, suppliers…"
            readOnly
            style={{
              border: 0,
              background: 'transparent',
              outline: 'none',
              width: 220,
              fontSize: 13,
              color: 'inherit',
              fontFamily: 'inherit',
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: 'var(--ink-3)',
              padding: '2px 6px',
              background: 'rgba(255,255,255,0.5)',
              borderRadius: 4,
              border: '1px solid rgba(180,140,60,0.15)',
            }}
          >
            ⌘K
          </span>
        </div>

        {/* Bell + dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="glass"
            onClick={onBellClick}
            aria-label="Notifications"
            style={{
              position: 'relative',
              width: 40,
              height: 40,
              borderRadius: 999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'inherit',
              fontFamily: 'inherit',
            }}
          >
            <IconBell size={16} />
            {unreadCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'oklch(0.7 0.15 55)',
                }}
              />
            )}
          </button>
          {showNotifications && (
            <div
              className="glass-strong"
              style={{
                position: 'absolute',
                right: 0,
                top: 48,
                width: 320,
                borderRadius: 16,
                zIndex: 9999,
                maxHeight: 400,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid rgba(180,140,60,0.15)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>
                  Notifications
                </span>
                <button
                  type="button"
                  onClick={onClearNotifications}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--ink-3)',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontFamily: 'inherit',
                  }}
                >
                  Clear all
                </button>
              </div>
              {notifications.length === 0 ? (
                <p
                  style={{
                    padding: 20,
                    textAlign: 'center',
                    color: 'var(--ink-3)',
                    margin: 0,
                    fontSize: 13,
                  }}
                >
                  No notifications
                </p>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid rgba(180,140,60,0.08)',
                      background: n.read ? 'transparent' : 'rgba(255, 248, 222, 0.4)',
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: 13,
                        color:
                          n.type === 'warning'
                            ? 'oklch(0.58 0.16 55)'
                            : n.type === 'success'
                            ? 'oklch(0.55 0.14 140)'
                            : 'var(--ink)',
                      }}
                    >
                      {n.message}
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--ink-3)' }}>
                      {new Date(n.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Gear — Admin */}
        <button
          type="button"
          className="glass"
          onClick={onAdminClick}
          aria-label="Admin"
          style={{
            position: 'relative',
            width: 40,
            height: 40,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'inherit',
            fontFamily: 'inherit',
          }}
        >
          <IconSettings size={16} />
        </button>

        {/* Avatar — Profile */}
        <button
          type="button"
          className="glass"
          onClick={onProfileClick}
          aria-label="Profile"
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(180deg, oklch(0.88 0.13 82), oklch(0.72 0.14 62))',
            color: '#2a1f08',
            border: 0,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 12 }}>{initials || '—'}</span>
        </button>
      </div>
    </div>
  );
};
