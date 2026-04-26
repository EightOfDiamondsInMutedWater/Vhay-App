import React from 'react';

// ————————————————————————————————————————————————————————————————
// Vhay icon set — minimal line icons, 1.5 stroke, rounded
// ————————————————————————————————————————————————————————————————

export type IconProps = {
  size?: number;
  stroke?: number;
  fill?: string;
  style?: React.CSSProperties;
  className?: string;
};

type InnerProps = IconProps & { children: React.ReactNode };

const Icon: React.FC<InnerProps> = ({
  size = 18,
  stroke = 1.5,
  fill = 'none',
  children,
  style,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    className={className}
  >
    {children}
  </svg>
);

export const IconPlus: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
);
export const IconArrowRight: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>
);
export const IconArrowUp: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Icon>
);
export const IconArrowDown: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Icon>
);
export const IconCheck: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M4 12l5 5L20 6" /></Icon>
);
export const IconX: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>
);
export const IconSearch: React.FC<IconProps> = (p) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>
);
export const IconBell: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 0 0 4 0" /></Icon>
);
export const IconSettings: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.12.67.36.88.67.21.3.32.66.32 1.03" />
  </Icon>
);
export const IconBox: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
  </Icon>
);
export const IconCart: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
  </Icon>
);
export const IconTag: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" />
    <circle cx="7" cy="7" r="1.5" />
  </Icon>
);
export const IconChart: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-5" /></Icon>
);
export const IconFile: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </Icon>
);
export const IconUser: React.FC<IconProps> = (p) => (
  <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>
);
export const IconBook: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </Icon>
);
export const IconTruck: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7" />
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="18.5" r="2.5" />
  </Icon>
);
export const IconFilter: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /></Icon>
);
export const IconMore: React.FC<IconProps> = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></Icon>
);
export const IconSpark: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M12 3l1.9 5.5L19 10l-5.1 1.5L12 17l-1.9-5.5L5 10l5.1-1.5z" />
    <path d="M19 3v4M21 5h-4M5 17v4M7 19H3" />
  </Icon>
);
export const IconLock: React.FC<IconProps> = (p) => (
  <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 1 1 8 0v4" /></Icon>
);
export const IconCalendar: React.FC<IconProps> = (p) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Icon>
);
export const IconClock: React.FC<IconProps> = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
);
export const IconDot: React.FC<IconProps> = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="4" fill="currentColor" /></Icon>
);
export const IconSend: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></Icon>
);
export const IconRefresh: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
  </Icon>
);
export const IconGrid: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
  </Icon>
);
export const IconLayer: React.FC<IconProps> = (p) => (
  <Icon {...p}><path d="M12 2 2 7l10 5 10-5z" /><path d="M2 17l10 5 10-5M2 12l10 5 10-5" /></Icon>
);
export const IconWallet: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M20 7H5a2 2 0 0 1 0-4h14v4z" />
    <path d="M3 5v14a2 2 0 0 0 2 2h16v-7M17 14h5v-4h-5a2 2 0 0 0 0 4z" />
  </Icon>
);
export const IconSliders: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Icon>
);
