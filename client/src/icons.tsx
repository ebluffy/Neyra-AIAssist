import type { ReactNode } from 'react';

type Props = { size?: number };

function Glyph({ size = 20, children }: Props & { children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

export function GearIcon(props: Props) {
  return <Glyph {...props}><circle cx="12" cy="12" r="3" /><path d="M12 3.2v1.8M12 19v1.8M3.2 12h1.8M19 12h1.8M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M18.4 5.6l-1.3 1.3M6.9 17.1l-1.3 1.3" /></Glyph>;
}

export function MicIcon(props: Props) {
  return <Glyph {...props}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5M8.5 20.5h7" /></Glyph>;
}

export function WaveIcon(props: Props) {
  return <Glyph {...props}><path d="M3 12h1.5M7 8.5v7M12 5v14M17 8.5v7M20.5 12H22" /></Glyph>;
}

export function SendIcon(props: Props) {
  return <Glyph {...props}><path d="M5 12h12M13 6l6 6-6 6" /></Glyph>;
}

export function CloseIcon(props: Props) {
  return <Glyph {...props}><path d="M6 6l12 12M18 6L6 18" /></Glyph>;
}
