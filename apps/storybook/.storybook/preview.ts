import { createElement } from 'react';
import { Inter, JetBrains_Mono, Roboto_Mono } from 'next/font/google';
import { withQueryClient } from './../src/decorators/withQueryClient';
import type { Decorator, Preview } from '@storybook/nextjs';
import { withThemeByClassName } from '@storybook/addon-themes';
import { withTRPC } from '../src/decorators/withTRPC';
import { withSessionProvider } from '../src/decorators/withSessionProvider';
import './mockDate'; // Mock Date for consistent screenshots
import './storybook.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans-loaded',
});

const robotoMono = Roboto_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono-loaded',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

const withFonts: Decorator = Story =>
  createElement(
    'div',
    {
      className: `${inter.variable} ${robotoMono.variable} ${jetbrainsMono.variable} min-h-screen font-sans`,
    },
    createElement(Story)
  );

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
      default: 'dark',
      values: [{ name: 'dark', value: 'var(--background)' }],
    },
    nextjs: {
      appDirectory: true, // Enable Next.js 13+ App Router hooks support
    },
  },
  decorators: [
    withFonts,
    withThemeByClassName({
      themes: { dark: 'dark' },
      defaultTheme: 'dark',
      parentSelector: 'html', // apply the class on <html> for Tailwind dark mode
    }),
    withTRPC,
    withQueryClient,
    withSessionProvider,
  ],
};

export default preview;
