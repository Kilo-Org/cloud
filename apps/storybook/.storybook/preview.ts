import { withQueryClient } from './../src/decorators/withQueryClient';
import type { Preview } from '@storybook/nextjs';
import { withThemeByClassName } from '@storybook/addon-themes';
import { withTRPC } from '../src/decorators/withTRPC';
import { withSessionProvider } from '../src/decorators/withSessionProvider';
import './mockDate'; // Mock Date for consistent screenshots
import './storybook.css';

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
      values: [
        { name: 'dark', value: 'var(--background)' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    nextjs: {
      appDirectory: true, // Enable Next.js 13+ App Router hooks support
    },
  },
  decorators: [
    withThemeByClassName({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme: 'dark',
      parentSelector: 'html', // apply the class on <html> for Tailwind dark mode
    }),
    withTRPC,
    withQueryClient,
    withSessionProvider,
  ],
};

export default preview;
