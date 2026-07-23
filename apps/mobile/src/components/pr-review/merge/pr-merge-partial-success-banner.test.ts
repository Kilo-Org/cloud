import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const BANNER_SOURCE = readFileSync(
  fileURLToPath(new URL('./pr-merge-partial-success-banner.tsx', import.meta.url)),
  'utf8'
);

describe('PrMergePartialSuccessBanner', () => {
  it('renders the merge-success headline and the branch-delete failure reason', () => {
    // The banner is a small, pure presentational component. Source-level
    // assertions are enough to lock the contract: (a) the merge itself
    // is presented as successful, (b) the failure reason is interpolated,
    // (c) an accessibilityLabel stitches the two together for screen
    // readers, and (d) there is NO button — the user already merged and
    // there is no client-side retry / undo.
    expect(BANNER_SOURCE).toContain('Merged');
    expect(BANNER_SOURCE).toContain("Couldn't delete the branch: ${reason}");
    expect(BANNER_SOURCE).toContain('accessibilityLabel=');
    expect(BANNER_SOURCE).toContain('accessibilityLiveRegion="polite"');
  });

  it('contains NO Button or Pressable (no destructive CTA — there is nothing to retry or undo)', () => {
    // The simplest way to assert "this component cannot render a
    // destructive action": if it imported `@/components/ui/button` or
    // `Pressable`, that would be a regression.
    expect(BANNER_SOURCE).not.toMatch(/from\s+['"]@\/components\/ui\/button['"]/);
    expect(BANNER_SOURCE).not.toMatch(/<Button\b/);
    expect(BANNER_SOURCE).not.toMatch(/<Pressable\b/);
  });
});
