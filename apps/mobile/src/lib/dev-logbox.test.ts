/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the app entry is a source file: reading it from disk is the only way to assert the LogBox filter is wired before the router entry loads */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { applyDevLogBoxFilters, SUPPRESSED_DEV_LOG_SUBSTRINGS } from './dev-logbox';

/**
 * The exact message LogBox builds for the capture: `ExpoIapConsole.error`
 * prefixes `'[Expo-IAP]'` and LogBox joins the args, so the failed
 * available-purchases query reaches the banner as one string.
 */
const PLAY_STORE_UNAVAILABLE_LOG =
  '[Expo-IAP] Error fetching available purchases: Error: Play Store service is not connected';

describe('applyDevLogBoxFilters', () => {
  it('passes the suppressed substrings to LogBox.ignoreLogs', () => {
    const ignoreLogs = vi.fn<(patterns: readonly string[]) => void>();
    applyDevLogBoxFilters({ ignoreLogs });

    expect(ignoreLogs).toHaveBeenCalledWith(SUPPRESSED_DEV_LOG_SUBSTRINGS);
  });

  it('matches the message LogBox builds for the Play Store failure', () => {
    expect(
      SUPPRESSED_DEV_LOG_SUBSTRINGS.some(pattern => PLAY_STORE_UNAVAILABLE_LOG.includes(pattern))
    ).toBe(true);
  });

  it('does not silence every expo-iap log', () => {
    expect(SUPPRESSED_DEV_LOG_SUBSTRINGS).not.toContain('[Expo-IAP]');
  });
});

describe('design-gate probe', () => {
  it('drops the layout-measure warning only in a design-gate bundle', () => {
    const probeSource = readFileSync(
      join(__dirname, '..', 'components', 'design-gate-probe.tsx'),
      'utf8'
    );
    const entrySource = readFileSync(join(__dirname, '..', '..', 'index.js'), 'utf8');
    const configSource = readFileSync(join(__dirname, 'config.ts'), 'utf8');
    // The suppression is gated on the bundle-time flag, never applied app-wide:
    // the entry registers no filter for this message, and the probe applies one
    // only when IS_DESIGN_GATE_BUNDLE is true.
    expect(configSource).toContain("EXPO_PUBLIC_DESIGN_GATE === '1'");
    expect(probeSource).toContain('if (IS_DESIGN_GATE_BUNDLE)');
    expect(entrySource).not.toContain("Can't perform a React state update on a component");
  });
});

describe('app entry', () => {
  const entrySource = readFileSync(join(__dirname, '..', '..', 'index.js'), 'utf8');

  it('requires the dev LogBox filter module', () => {
    expect(entrySource).toContain('./src/lib/dev-logbox');
  });

  it('applies the filters before the router entry loads', () => {
    const filterCall = entrySource.indexOf('applyDevLogBoxFilters(LogBox)');
    const routerEntry = entrySource.indexOf("require('expo-router/entry')");

    expect(filterCall).toBeGreaterThan(-1);
    expect(routerEntry).toBeGreaterThan(-1);
    expect(filterCall).toBeLessThan(routerEntry);
  });
});
