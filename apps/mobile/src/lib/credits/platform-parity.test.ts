// One implementation for both platforms in the credit-pack purchase flow.
//
// The catalog, the four pack rows, the store sheet, the grant, recovery, the
// refunds and the error copy are shared JS and must behave identically on iOS
// and Android. The one capability the platforms differ on is the store itself:
// iOS has StoreKit and no Google Play Billing, Android has Play Billing and no
// App Store, and the backend validates a purchase against the store that made
// it. `storefront.ts` names that fork and is the flow's only platform read —
// every other module calls `getCreditStorefront()` instead of branching. The
// shared `AddCreditsRow`, whose external-billing variant only Android may
// offer, keeps its own gate under the same rule. This suite reads the sources
// in node and holds both to that: a per-platform branch that would ship to one
// platform only fails here.

/* eslint-disable eslint-plugin-import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/* eslint-enable eslint-plugin-import/no-nodejs-modules */

import { describe, expect, it } from 'vitest';

const CREDITS_LIB = fileURLToPath(new URL('./', import.meta.url));
const CREDITS_COMPONENTS = fileURLToPath(new URL('../../components/credits/', import.meta.url));
const ADD_CREDITS_ROW = fileURLToPath(
  new URL('../../components/add-credits-row.tsx', import.meta.url)
);

/** The one capability fork the flow keeps: the store the platform actually has. */
const STOREFRONT_FILE = 'storefront.ts';

/** Every shared (non-test) module of the credit-pack flow, with its source. */
function flowSources(): { file: string; source: string }[] {
  return [CREDITS_LIB, CREDITS_COMPONENTS].flatMap(directory =>
    readdirSync(directory)
      .filter(name => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.'))
      .toSorted()
      .map(name => ({ file: name, source: readFileSync(`${directory}${name}`, 'utf8') }))
  );
}

/**
 * The source with comments removed, so prose about a branch (`the one platform
 * read`) is not read as the branch itself.
 */
function codeOf(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
}

/**
 * The source with comment markers and line wrapping flattened, so a sentence
 * the author wrapped across two comment lines reads as one string.
 */
function proseOf(source: string): string {
  return source.replaceAll(/^\s*\*\s?/gm, '').replaceAll(/\s+/g, ' ');
}

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module.
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

describe('one implementation for both platforms in the credit-pack purchase flow', () => {
  it('derives the platform in exactly one module: the storefront the platform has', () => {
    const sources = flowSources();
    expect(sources.length).toBeGreaterThan(0);
    const forked = sources
      .filter(({ source }) => PLATFORM_BRANCH.test(codeOf(source)))
      .map(({ file }) => file);
    expect(forked).toEqual([STOREFRONT_FILE]);
  });

  it('names the capability that fork covers, and nothing else on the path picks a store per platform', () => {
    const storefront = flowSources().find(({ file }) => file === STOREFRONT_FILE);
    expect(storefront).toBeDefined();
    const prose = proseOf(storefront?.source ?? '');
    expect(storefront?.source).toContain("return Platform.OS === 'ios' ? 'app_store' : 'play';");
    // The comment has to name what each platform has and lacks, or the fork is
    // indistinguishable from a preference.
    expect(prose).toContain('iOS ships StoreKit and has no Google Play Billing');
    expect(prose).toContain('Android ships Play Billing and has no App Store');
  });

  it('keeps the row gate only where the platform lacks the capability, named in its comment', () => {
    // App Store review forbids an in-app link to an external purchase on iOS, so
    // `AddCreditsRow` renders only its in-app CTA there and names that in the doc
    // comment above the gate. Nothing else on the row branches on the platform.
    const source = readFileSync(ADD_CREDITS_ROW, 'utf8');
    expect(source.match(/if \(!onPress && Platform\.OS === 'ios'\) \{/g) ?? []).toHaveLength(1);
    expect(source).toContain('App Store review forbids');
    expect(source).not.toMatch(/Platform\.select\b|Platform\.Version\b/);
  });
});
