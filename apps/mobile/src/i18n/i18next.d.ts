import 'i18next';

import type en from './locales/en.json';

declare module 'i18next' {
  type CustomTypeOptions = {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  };
}
