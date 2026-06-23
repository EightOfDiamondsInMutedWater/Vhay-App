import React from 'react';
import { COMING_SOON_LABEL } from './featureFlags';

// Frosted "paused" cover: content stays faintly visible but un-clickable; the cover eats all clicks.
// Styled to match the app's warm/cream confirm-dialog look, not a hard dark scrim.
export const ComingSoonOverlay: React.FC<{
  active: boolean;
  label?: string;
  children: React.ReactNode;
}> = ({ active, label = COMING_SOON_LABEL, children }) => {
  if (!active) return <>{children}</>;
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ opacity: 0.35, pointerEvents: 'none', userSelect: 'none' }} aria-hidden>
        {children}
      </div>
      <div
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
        style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          paddingTop: '14vh',
          background: 'rgba(250, 243, 224, 0.55)',
          backdropFilter: 'blur(1.5px)', WebkitBackdropFilter: 'blur(1.5px)',
          cursor: 'not-allowed',
        }}
      >
        <div style={{
          padding: '18px 26px', borderRadius: 16, textAlign: 'center',
          background: 'rgba(255, 252, 245, 0.92)',
          border: '1px solid rgba(200, 160, 70, 0.35)',
          boxShadow: '0 8px 30px -8px rgba(120, 90, 30, 0.30)',
          color: 'var(--ink, #2a2118)', fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em',
          maxWidth: 360,
        }}>
          <div style={{ fontSize: 22, marginBottom: 4 }}>✨</div>
          {label}
        </div>
      </div>
    </div>
  );
};
