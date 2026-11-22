/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import en from './locales/en.json';
import { localizedPushParams, SECURITY_FINDING_SEVERITY_KEYS } from './push-params';

const FINDING_KEY = 'internal.securityFindingNew';

const FINDING_PARAMS = {
  severity: 'high',
  findingTitle: 'XSS in admin',
  repoFullName: 'acme/api',
};

const LOCALES_DIR = fileURLToPath(new URL('./locales/', import.meta.url));

/** The severity and the catalog entry that translates it, for each known level. */
const SEVERITY_ENTRIES = Object.entries(SECURITY_FINDING_SEVERITY_KEYS);

/**
 * The one subtree a push catalog must carry for a severity to render. Read as a
 * record rather than as four named fields, so the check walks the keys
 * `SECURITY_FINDING_SEVERITY_KEYS` names instead of a second list of them.
 */
const severityCatalogSchema = z.object({
  internal: z.object({ securityFindingSeverity: z.record(z.string(), z.string()) }),
});

describe('localizedPushParams', () => {
  it('translates a known severity into the finding language', () => {
    expect(localizedPushParams('en', FINDING_KEY, FINDING_PARAMS)).toEqual({
      ...FINDING_PARAMS,
      severity: 'High',
    });
    expect(localizedPushParams('pt-BR', FINDING_KEY, FINDING_PARAMS)).toEqual({
      ...FINDING_PARAMS,
      severity: 'Nível alto',
    });
    expect(
      localizedPushParams('pt-BR', FINDING_KEY, { ...FINDING_PARAMS, severity: 'critical' })
    ).toEqual({ ...FINDING_PARAMS, severity: 'Nível crítico' });
  });

  it('leaves the user-authored params untouched', () => {
    const params = localizedPushParams('pt-BR', FINDING_KEY, FINDING_PARAMS);
    expect(params?.findingTitle).toBe('XSS in admin');
    expect(params?.repoFullName).toBe('acme/api');
  });

  it('keeps a severity this build does not know', () => {
    const params = { ...FINDING_PARAMS, severity: 'moderate' };
    expect(localizedPushParams('pt-BR', FINDING_KEY, params)?.severity).toBe('moderate');
  });

  it('passes the params of a push that carries no finding severity through', () => {
    const params = { organizationName: 'Acme', minimumBalanceUsd: '5' };
    expect(localizedPushParams('pt-BR', 'internal.lowBalance', params)).toBe(params);
    expect(localizedPushParams('pt-BR', undefined, FINDING_PARAMS)).toBe(FINDING_PARAMS);
    expect(localizedPushParams('pt-BR', FINDING_KEY, undefined)).toBeUndefined();
    expect(localizedPushParams('pt-BR', FINDING_KEY, { findingTitle: 'XSS in admin' })).toEqual({
      findingTitle: 'XSS in admin',
    });
  });
});

const ENGLISH_SEVERITIES = severityCatalogSchema.parse(en).internal.securityFindingSeverity;

describe('shipped severity copy', () => {
  it('translates a known severity to the words the catalog holds', () => {
    for (const [severity] of SEVERITY_ENTRIES) {
      expect(localizedPushParams('en', FINDING_KEY, { severity })?.severity).toBe(
        ENGLISH_SEVERITIES[severity]
      );
    }
  });

  it('defines all four severities, non-empty, in every shipped locale', () => {
    const files = readdirSync(LOCALES_DIR).filter(file => file.endsWith('.json'));
    expect(files.length).toBeGreaterThan(80);

    const failures: string[] = [];
    for (const file of files) {
      const locale = file.slice(0, -'.json'.length);
      const parsed = severityCatalogSchema.safeParse(
        JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'))
      );
      if (!parsed.success) {
        failures.push(`${locale}: catalog carries no internal.securityFindingSeverity entry`);
        continue;
      }
      const severities = parsed.data.internal.securityFindingSeverity;
      for (const [severity] of SEVERITY_ENTRIES) {
        const value = severities[severity];
        if (typeof value !== 'string' || value.trim() === '') {
          failures.push(`${locale} ${severity}: catalog defines no entry`);
        }
      }
    }

    expect(failures, 'every shipped catalog must define every severity').toEqual([]);
  });
});
