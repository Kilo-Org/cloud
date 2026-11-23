/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { translatePush } from './i18n';
import en from './locales/en.json';
import { genericPushContentForPushData } from './push-copy';
import type { PushData } from './push-data';
import {
  SECURITY_FINDING_PUSH_TITLE_KEYS,
  pushBodyCatalogKey,
  pushTitleCatalogKey,
} from './push-i18n-keys';
import { internalDispatchSecurityFindingRequestSchema } from './rpc-schemas';

const SECURITY_FINDING_KINDS =
  internalDispatchSecurityFindingRequestSchema.shape.notificationKind.options;

const FINDING_PARAMS = { findingTitle: 'XSS in admin', repoFullName: 'acme/api' };

const FINDING_PUSH_KEYS_BY_KIND = [
  ['new_finding', 'internal.securityFindingNew', 'internal.securityFindingNew.title'],
  ['sla_warning', 'internal.securityFindingSlaWarning', 'internal.securityFindingSlaWarning.title'],
  ['sla_breach', 'internal.securityFindingSlaBreach', 'internal.securityFindingSlaBreach.title'],
] as const;

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

  it.each(FINDING_PUSH_KEYS_BY_KIND)(
    'routes the %s push title to %s and its body to the shared sentence',
    (_kind, i18nKey, titleKey) => {
      expect(pushTitleCatalogKey(i18nKey)).toBe(titleKey);
      expect(pushBodyCatalogKey(i18nKey)).toBe('internal.securityFinding.body');
    }
  );

  it.each(['internal.lowBalance', 'sessionReady', 'agentSession.notification', 'chat.untitled'])(
    'keeps the body of %s under its own entry',
    key => {
      expect(pushBodyCatalogKey(key)).toBe(`${key}.body`);
    }
  );

  it('defines the shared body sentence with the finding placeholders', () => {
    const body = catalogEntry('internal.securityFinding.body');
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
    expect(
      translatePush('es', bodyKey, FINDING_PARAMS, '{{findingTitle}} in {{repoFullName}}')
    ).toBe('XSS in admin en acme/api');
    expect(
      translatePush('en', bodyKey, FINDING_PARAMS, '{{findingTitle}} in {{repoFullName}}')
    ).toBe('XSS in admin in acme/api');
  });
});

const SESSION_KINDS = ['agentSession.notification', 'sessionReady'] as const;
const LIFECYCLE_KEY = 'internal.securityLifecycle';
const LIFECYCLE_PAYLOAD: PushData = {
  type: 'security_lifecycle',
  event: 'analysis_completed',
  findingId: 'finding-1',
  scope: 'org-example',
};

describe('shared push copy', () => {
  it('gives both session kinds one shared title entry', () => {
    const keys = SESSION_KINDS.map(pushTitleCatalogKey);
    expect(keys[0]).toBe('session.title');
    expect(keys[1]).toBe(keys[0]);
  });

  it('points the security lifecycle push at the product name and the generic update', () => {
    expect(pushTitleCatalogKey(LIFECYCLE_KEY)).toBe('generic.title');
    expect(pushBodyCatalogKey(LIFECYCLE_KEY)).toBe('generic.body.securityUpdate');
  });

  it('keeps an ordinary kind under its own title entry', () => {
    expect(pushTitleCatalogKey('internal.lowBalance')).toBe('internal.lowBalance.title');
  });

  it('names a title and a body entry the English catalog defines for every shared kind', () => {
    const kinds = [
      ...SESSION_KINDS,
      LIFECYCLE_KEY,
      ...Object.values(SECURITY_FINDING_PUSH_TITLE_KEYS),
    ];
    for (const kind of kinds) {
      expect(typeof catalogEntry(pushTitleCatalogKey(kind))).toBe('string');
      expect(typeof catalogEntry(pushBodyCatalogKey(kind))).toBe('string');
    }
  });

  // This comparison is the tie between the key mapping and the preview's own
  // leaf table: re-point `GENERIC_BODY_LEAF_BY_TYPE.security_lifecycle` and the
  // two lines stop matching here. It is conclusive because no two generic body
  // leaves hold the same English string, which the catalog audit enforces.
  it('renders the lifecycle push as the copy the generic preview shows', () => {
    for (const locale of ['en', 'es']) {
      const preview = genericPushContentForPushData(LIFECYCLE_PAYLOAD, locale);
      expect(translatePush(locale, pushTitleCatalogKey(LIFECYCLE_KEY), undefined, 'Kilo')).toBe(
        preview.title
      );
      expect(
        translatePush(
          locale,
          pushBodyCatalogKey(LIFECYCLE_KEY),
          undefined,
          'A security check has an update'
        )
      ).toBe(preview.body);
    }
  });
});

const LOCALES_DIR = fileURLToPath(new URL('./locales/', import.meta.url));

const SAMPLE_PUSH_KEYS: readonly { key: string; params: Record<string, string> }[] = [
  { key: 'internal.securityFindingNew.title', params: { severity: 'high' } },
  { key: 'internal.securityFindingSlaWarning.title', params: {} },
  { key: 'internal.securityFindingSlaBreach.title', params: {} },
  { key: 'internal.securityFinding.body', params: FINDING_PARAMS },
  { key: 'generic.body.securityUpdate', params: {} },
  { key: 'generic.title', params: {} },
  { key: 'session.title', params: { sessionTitle: 'Fix the login bug' } },
  { key: 'sessionReady.body', params: {} },
];

function readShippedCatalogs(): Record<string, unknown> {
  const catalogs: Record<string, unknown> = {};
  for (const file of readdirSync(LOCALES_DIR)) {
    if (!file.endsWith('.json')) continue;
    const locale = file.slice(0, -'.json'.length);
    catalogs[locale] = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
  }
  return catalogs;
}

/**
 * The value a catalog itself holds at a dotted key, without i18next's English
 * fallback. A locale that lacks the entry still renders English, so only the
 * raw lookup shows the gap.
 */
function ownEntry(catalog: unknown, key: string): unknown {
  let entry: unknown = catalog;
  for (const part of key.split('.')) {
    if (entry === null || typeof entry !== 'object') return undefined;
    entry = (entry as Record<string, unknown>)[part];
  }
  return entry;
}

describe('shipped push catalogs', () => {
  it('renders every push key in every shipped locale', () => {
    const catalogs = readShippedCatalogs();
    expect(Object.keys(catalogs).length).toBeGreaterThan(80);

    const failures: string[] = [];
    for (const locale of Object.keys(catalogs)) {
      for (const { key, params } of SAMPLE_PUSH_KEYS) {
        // i18next answers with the English entry when this catalog lacks the
        // key, so check the catalog's own entry first.
        const own = ownEntry(catalogs[locale], key);
        if (typeof own !== 'string' || own.trim() === '') {
          failures.push(`${locale} ${key}: catalog defines no entry`);
          continue;
        }
        if (own === key) {
          failures.push(`${locale} ${key}: catalog holds the key itself`);
        }
        // The production callers all pass the English copy as the fallback;
        // this catalog audit renders with the same argument.
        const english = ownEntry(en, key);
        const rendered = translatePush(
          locale,
          key,
          params,
          typeof english === 'string' ? english : key
        );
        if (typeof rendered !== 'string' || rendered.trim() === '') {
          failures.push(`${locale} ${key}: rendered an empty string`);
          continue;
        }
        if (rendered.includes('{{')) {
          failures.push(`${locale} ${key}: left a placeholder unresolved: ${rendered}`);
        }
        for (const [name, value] of Object.entries(params)) {
          if (!rendered.includes(value)) {
            failures.push(`${locale} ${key}: dropped the ${name} value: ${rendered}`);
          }
        }
      }
    }

    expect(
      failures,
      'every shipped catalog must render every push key with its placeholders filled'
    ).toEqual([]);
  });

  it('keeps the English product name in every shipped catalog', () => {
    const catalogs = readShippedCatalogs();
    const productName = ownEntry(en, 'generic.title');
    expect(typeof productName).toBe('string');
    const drifted = Object.keys(catalogs)
      .filter(locale => ownEntry(catalogs[locale], 'generic.title') !== productName)
      .map(locale => `${locale}: ${String(ownEntry(catalogs[locale], 'generic.title'))}`);
    // The push title is the product name, not translatable copy: one locale
    // that renames it renames the product in the OS notification shade.
    expect(drifted).toEqual([]);
  });
});
