import { describe, expect, it } from 'vitest';

import { translatePush } from './i18n';
import en from './locales/en.json';
import {
  SECURITY_FINDING_PUSH_BODY_KEY,
  SECURITY_FINDING_PUSH_TITLE_KEYS,
  pushBodyCatalogKey,
} from './push-i18n-keys';
import { internalDispatchSecurityFindingRequestSchema } from './rpc-schemas';

const SECURITY_FINDING_KINDS =
  internalDispatchSecurityFindingRequestSchema.shape.notificationKind.options;

const FINDING_PARAMS = { findingTitle: 'XSS in admin', repoFullName: 'acme/api' };

function catalogEntry(key: string): unknown {
  let entry: unknown = en;
  for (const part of key.split('.')) {
    if (entry === null || typeof entry !== 'object') return undefined;
    entry = (entry as Record<string, unknown>)[part];
  }
  return entry;
}

describe('security finding push keys', () => {
  it('names a title key for every kind the dispatcher can send', () => {
    expect(Object.keys(SECURITY_FINDING_PUSH_TITLE_KEYS).sort()).toEqual(
      [...SECURITY_FINDING_KINDS].sort()
    );
  });

  it.each(SECURITY_FINDING_KINDS)('routes the %s push body to the shared entry', kind => {
    expect(pushBodyCatalogKey(SECURITY_FINDING_PUSH_TITLE_KEYS[kind])).toBe(
      SECURITY_FINDING_PUSH_BODY_KEY
    );
  });

  it.each(['internal.lowBalance', 'sessionReady', 'chat.untitled'])(
    'keeps the body of %s under its own entry',
    key => {
      expect(pushBodyCatalogKey(key)).toBe(`${key}.body`);
    }
  );

  it('defines the shared body sentence with the finding placeholders', () => {
    expect(SECURITY_FINDING_PUSH_BODY_KEY).toBe('internal.securityFinding.body');
    const body = catalogEntry(SECURITY_FINDING_PUSH_BODY_KEY);
    expect(typeof body).toBe('string');
    expect(body).toContain('{{findingTitle}}');
    expect(body).toContain('{{repoFullName}}');
  });

  it('defines a title and no body under each kind entry', () => {
    for (const titleKey of Object.values(SECURITY_FINDING_PUSH_TITLE_KEYS)) {
      expect(typeof catalogEntry(`${titleKey}.title`)).toBe('string');
      expect(catalogEntry(`${titleKey}.body`)).toBeUndefined();
    }
  });

  it('translates the shared body sentence into the token language', () => {
    const bodyKey = pushBodyCatalogKey('internal.securityFindingSlaWarning');
    expect(translatePush('es', bodyKey, FINDING_PARAMS)).toBe('XSS in admin en acme/api');
    expect(translatePush('en', bodyKey, FINDING_PARAMS)).toBe('XSS in admin in acme/api');
  });
});
