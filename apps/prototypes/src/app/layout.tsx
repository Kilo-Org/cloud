import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Roboto_Mono } from 'next/font/google';
import {
  createPrototypeHostClassName,
  PROTOTYPE_HOST_METADATA,
  PROTOTYPE_HOST_VIEWPORT,
} from '@/lib/prototype-host';
import '@web/app/globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const mono = Roboto_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

export const metadata: Metadata = PROTOTYPE_HOST_METADATA;

export const viewport: Viewport = PROTOTYPE_HOST_VIEWPORT;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={createPrototypeHostClassName([
        inter.variable,
        mono.variable,
        jetbrainsMono.variable,
      ])}
    >
      <body>{children}</body>
    </html>
  );
}
