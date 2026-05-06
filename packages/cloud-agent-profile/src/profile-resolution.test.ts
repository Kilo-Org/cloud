import { describe, test, expect } from 'vitest';
import { resolveProfileLayers } from './profile-resolution';

// Short fake UUIDs, only identity matters in this pure-logic test.
const REPO_P = 'repo-profile';
const DEFAULT_P = 'default-profile';
const EXPLICIT_P = 'explicit-profile';

describe('resolveProfileLayers', () => {
  test('nothing picked and no fallbacks: nothing applies', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: null,
      })
    ).toEqual({ automatic: null, explicit: null });
  });

  test('only effective default: default fills the automatic slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      automatic: { profileId: DEFAULT_P, source: 'default' },
      explicit: null,
    });
  });

  test('only repo binding: repo binding fills the automatic slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      automatic: { profileId: REPO_P, source: 'repo-binding' },
      explicit: null,
    });
  });

  test('repo binding beats effective default in the automatic slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      automatic: { profileId: REPO_P, source: 'repo-binding' },
      explicit: null,
    });
  });

  test('repo binding coexists with an explicit override: base + override', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      automatic: { profileId: REPO_P, source: 'repo-binding' },
      explicit: EXPLICIT_P,
    });
  });

  test('explicit pick suppresses the default (default is a fallback, not a co-layer)', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      automatic: null,
      explicit: EXPLICIT_P,
    });
  });

  test('explicit pick equal to the repo binding is deduped to a no-op override', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: REPO_P,
      })
    ).toEqual({
      automatic: { profileId: REPO_P, source: 'repo-binding' },
      explicit: null,
    });
  });

  test('explicit pick equal to the effective default: no default fallback; explicit alone', () => {
    // The default is not pulled into `automatic` because an explicit pick was made.
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: DEFAULT_P,
      })
    ).toEqual({
      automatic: null,
      explicit: DEFAULT_P,
    });
  });

  test('explicit pick with no repo binding and no default: explicit alone', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      automatic: null,
      explicit: EXPLICIT_P,
    });
  });
});
