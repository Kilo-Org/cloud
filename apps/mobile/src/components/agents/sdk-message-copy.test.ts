import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { CATALOG_LOADERS } from '@/i18n/catalogs';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';

import { localizeSdkMessage, sdkMessageCopy } from './sdk-message-copy';

/**
 * Every literal `@kilocode/cloud-agent-sdk` writes into the status indicator,
 * with the catalog key that holds the reader's copy. Kept in step with the
 * table in `sdk-message-copy.ts`.
 */
const SDK_MESSAGES = [
  ['Setting up environment…', 'agentChat.composer.preparingPlaceholder'],
  ['Wrapping up…', 'agentChat.composer.finalizingPlaceholder'],
  ['Committing…', 'agentChat.status.committing'],
  ['Committed', 'agentChat.status.committed'],
  ['Commit failed', 'agentChat.status.commitFailed'],
  ['Session stopped', 'agentChat.status.sessionStopped'],
  ['Session terminated', 'agentChat.status.sessionTerminated'],
  ['Agent connection lost', 'agentChat.session.connectionTrouble'],
  ['Failed to stop execution', 'agentChat.session.failedToStopExecution'],
] as const;

/** The value at a dotted catalog key, so an assertion reads the real copy. */
function copyAt(catalog: object, key: string): string {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') {
    throw new TypeError(`${key} is not a string`);
  }
  return node;
}

/**
 * Put the singleton on Spanish with the real catalog loaded. The lazy backend
 * only fetches a language once, so a catalog a previous test removed with
 * `removeResourceBundle` is not re-fetched; loading the bundle directly keeps
 * each test independent of that cache.
 */
async function useSpanish(): Promise<void> {
  await i18n.changeLanguage('es');
  i18n.addResourceBundle('es', 'translation', CATALOG_LOADERS.es(), true, true);
}

const UNRECOGNIZED = 'Service Unavailable: The service is temporarily unavailable.';

describe('sdkMessageCopy', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each(SDK_MESSAGES)('maps the pinned SDK literal %s to its English copy', (raw, key) => {
    expect(sdkMessageCopy(raw)).toBe(copyAt(en, key));
  });

  // The five new `agentChat.status` keys are not in the non-English catalogs
  // yet (a translation slice adds them), so each case installs its own
  // translation instead of reading es.json.
  it.each(SDK_MESSAGES)(
    'maps the pinned SDK literal %s to the active language copy',
    async (raw, key) => {
      await useSpanish();
      i18n.addResource('es', 'translation', key, `es:${key}`);
      expect(sdkMessageCopy(raw)).toBe(`es:${key}`);
      i18n.removeResourceBundle('es', 'translation');
    }
  );

  it('resolves an SDK literal into copy already translated in the catalog', async () => {
    await useSpanish();
    expect(sdkMessageCopy('Agent connection lost')).toBe(
      copyAt(es, 'agentChat.session.connectionTrouble')
    );
    i18n.removeResourceBundle('es', 'translation');
  });

  it('returns null for text the SDK merely forwards', () => {
    expect(sdkMessageCopy(UNRECOGNIZED)).toBeNull();
  });

  it('ignores inherited Object.prototype names', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(sdkMessageCopy(name)).toBeNull();
    }
  });
});

describe('localizeSdkMessage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('returns the catalog copy for a pinned SDK literal', async () => {
    await useSpanish();
    i18n.addResource('es', 'translation', 'agentChat.status.sessionStopped', 'Sesión detenida');
    expect(localizeSdkMessage('Session stopped')).toBe('Sesión detenida');
    i18n.removeResourceBundle('es', 'translation');
  });

  it('returns an unrecognized message unchanged, so the indicator never blanks', () => {
    expect(localizeSdkMessage(UNRECOGNIZED)).toBe(UNRECOGNIZED);
  });
});
