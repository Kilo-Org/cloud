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
    ).toEqual({ base: null, top: null });
  });

  test('only effective default: default fills the top slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      base: null,
      top: { profileId: DEFAULT_P, source: 'default' },
    });
  });

  test('only repo binding: repo binding fills the base slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      base: { profileId: REPO_P, source: 'repo-binding' },
      top: null,
    });
  });

  test('repo binding + effective default: both apply (default on top of repo)', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      base: { profileId: REPO_P, source: 'repo-binding' },
      top: { profileId: DEFAULT_P, source: 'default' },
    });
  });

  test('repo binding + explicit override: both apply (override on top of repo)', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      base: { profileId: REPO_P, source: 'repo-binding' },
      top: { profileId: EXPLICIT_P, source: 'explicit' },
    });
  });

  test('repo binding + default + explicit: explicit replaces default in the top slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      base: { profileId: REPO_P, source: 'repo-binding' },
      top: { profileId: EXPLICIT_P, source: 'explicit' },
    });
  });

  test('explicit pick replaces the default in the top slot (no repo binding)', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      base: null,
      top: { profileId: EXPLICIT_P, source: 'explicit' },
    });
  });

  test('explicit pick equal to the repo binding is deduped to a no-op top', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: REPO_P,
      })
    ).toEqual({
      base: { profileId: REPO_P, source: 'repo-binding' },
      top: null,
    });
  });

  test('default equal to the repo binding is deduped to a no-op top', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: REPO_P,
        effectiveDefaultProfileId: REPO_P,
        explicitOverrideProfileId: null,
      })
    ).toEqual({
      base: { profileId: REPO_P, source: 'repo-binding' },
      top: null,
    });
  });

  test('explicit pick equal to the effective default: explicit alone in top slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: DEFAULT_P,
        explicitOverrideProfileId: DEFAULT_P,
      })
    ).toEqual({
      base: null,
      top: { profileId: DEFAULT_P, source: 'explicit' },
    });
  });

  test('explicit pick with no repo binding and no default: explicit alone in top slot', () => {
    expect(
      resolveProfileLayers({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: EXPLICIT_P,
      })
    ).toEqual({
      base: null,
      top: { profileId: EXPLICIT_P, source: 'explicit' },
    });
  });
});
