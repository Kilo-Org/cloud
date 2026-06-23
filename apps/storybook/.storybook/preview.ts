import { withQueryClient } from './../src/decorators/withQueryClient';
import type { Decorator, Preview } from '@storybook/nextjs';
import { Inter, JetBrains_Mono, Roboto_Mono } from 'next/font/google';
import { withTRPC } from '../src/decorators/withTRPC';
import { withSessionProvider } from '../src/decorators/withSessionProvider';
import './mockDate'; // Mock Date for consistent screenshots
import './storybook.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans-loaded',
});

const mono = Roboto_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono-loaded',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

const productionFontClasses = [
  inter.variable,
  mono.variable,
  jetbrainsMono.variable,
  'font-sans',
  'antialiased',
].filter(Boolean);

function applyProductionFontClasses() {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.classList.add(...productionFontClasses);
  document.body.classList.add('font-sans', 'antialiased');
}

applyProductionFontClasses();

const withProductionFonts: Decorator = Story => {
  applyProductionFontClasses();
  return Story();
};

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'canvas',
      values: [
        { name: 'canvas', value: 'var(--surface-background)' },
        { name: 'raised', value: 'var(--surface-raised)' },
        { name: 'overlay', value: 'var(--surface-overlay)' },
      ],
    },
    nextjs: {
      appDirectory: true, // Enable Next.js 13+ App Router hooks support
    },
  },
  decorators: [withProductionFonts, withTRPC, withQueryClient, withSessionProvider],
};

export default preview;
