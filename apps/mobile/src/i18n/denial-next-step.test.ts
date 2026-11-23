import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';
import en from './locales/en.json';

/**
 * The privileged organization screens name the next step by reusing the boundary
 * sentence, so a plain member reads the same ask wherever the app refuses a
 * screen: the AI Guardrails form, and the audit log, billing and request-log
 * states that offer no action of their own. The checker keeps the reference
 * identical in every catalog; this pins that the reference is still there, and
 * that every language resolves it instead of printing `$t(`.
 */
const NEXT_STEP_KEY = 'organization.boundary.accessDeniedDescription';

const DENIALS = [
  {
    key: 'organizationGuardrails.permissionDenied',
    copy: en.organizationGuardrails.permissionDenied,
  },
  {
    key: 'organization.auditLog.permissionDenied',
    copy: en.organization.auditLog.permissionDenied,
  },
  { key: 'organization.billing.permissionDenied', copy: en.organization.billing.permissionDenied },
  {
    key: 'organization.requestLogs.permissionDenied',
    copy: en.organization.requestLogs.permissionDenied,
  },
] as const;

const i18n = createInstance();
await i18n.init({
  resources: Object.fromEntries(
    SUPPORTED_LANGUAGES.map(tag => [tag, { translation: CATALOG_LOADERS[tag]() }])
  ),
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

describe('organization denial next step', () => {
  it('names the next step by key in English', () => {
    for (const { copy } of DENIALS) {
      expect(copy).toContain(`$t(${NEXT_STEP_KEY})`);
    }
  });

  it.each(SUPPORTED_LANGUAGES)('resolves the next step in %s', async tag => {
    await i18n.changeLanguage(tag);
    const nextStep = i18n.t(NEXT_STEP_KEY);
    for (const { key } of DENIALS) {
      const denial = i18n.t(key);
      expect(denial).toContain(nextStep);
      expect(denial).not.toContain('$t(');
    }
  });
});
