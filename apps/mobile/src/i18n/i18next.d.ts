import 'i18next';

import type en from './locales/en.json';

declare module 'i18next' {
  // i18next requires an interface for declaration merging.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
