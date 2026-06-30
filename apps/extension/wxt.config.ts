import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: ({ browser }) => ({
    action: {
      default_title: 'Kilo',
    },
    browser_specific_settings: {
      gecko: {
        data_collection_permissions: {
          required: ['none'],
        },
        id: 'kilo-extension@kilocode.ai',
      },
    },
    description: 'Kilo browser extension.',
    host_permissions: [
      '<all_urls>',
      'file:///*',
      'https://app.kilo.ai/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    name: 'Kilo Extension',
    permissions:
      browser === 'firefox'
        ? ['identity', 'scripting', 'storage', 'tabs']
        : ['debugger', 'identity', 'scripting', 'storage'],
  }),
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
