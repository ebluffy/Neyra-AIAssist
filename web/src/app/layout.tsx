import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-mono-jetbrains',
  display: 'swap',
});

export const metadata = {
  title: 'Neyra',
  description: 'Персональный AI-ассистент',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-[var(--bg)] text-[var(--text)] font-sans antialiased selection:bg-[var(--accent-quiet)] selection:text-[var(--text)]">
        {children}
      </body>
    </html>
  );
}
