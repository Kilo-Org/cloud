// One implementation for both platforms in the credit-pack purchase flow.
//
// The catalog, the four pack rows, the store sheet, the grant, recovery, the
// refunds and the error copy are shared JS and must behave identically on iOS
// and Android. The platforms differ on two capabilities: the store itself —
// iOS has StoreKit and no Google Play Billing, Android has Play Billing and no
// App Store, and the backend validates a purchase against the store that made
// it — and whether an in-app link to an external billing page is allowed, which
// App Store review forbids and Play permits. `storefront.ts` names the first,
// `external-billing-link.ts` the second; every other module asks those two
// instead of branching. The shared `AddCreditsRow` routes its gate through the
// second. This suite reads the sources in node and holds all of them to that: a
// per-platform branch anywhere else fails here.

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

/**
 * The other capability fork: whether the platform may link out to a billing
 * page. App Store review forbids it on iOS while Play permits it.
 */
const EXTERNAL_BILLING_FILE = 'external-billing-link.ts';

/** Every module allowed to read the platform, in the order the suite reports them. */
const CAPABILITY_FILES = [EXTERNAL_BILLING_FILE, STOREFRONT_FILE];

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
  it('reads the platform only in the two capability modules', () => {
    const sources = flowSources();
    expect(sources.length).toBeGreaterThan(0);
    const forked = sources
      .filter(({ source }) => PLATFORM_BRANCH.test(codeOf(source)))
      .map(({ file }) => file);
    expect(forked).toEqual(CAPABILITY_FILES);
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

  it('routes the row gate through the shared capability, named in its comment', () => {
    // App Store review forbids an in-app link to an external purchase on iOS, so
    // `AddCreditsRow` renders only its in-app CTA there and names that in the
    // comment above the gate. The row asks the shared gate instead of reading
    // the platform itself, so both platforms keep one implementation.
    const source = readFileSync(ADD_CREDITS_ROW, 'utf8');
    expect(source.match(/if \(!onPress && !canOpenExternalBilling\(\)\) \{/g) ?? []).toHaveLength(
      1
    );
    expect(source).toContain('App Store review');
    expect(source).not.toMatch(PLATFORM_BRANCH);
  });
});
