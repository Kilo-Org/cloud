import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  artifactMirrorFixtureManifest,
  handleArtifactMirrorFixturePath,
} from '@/lib/artifacts/artifact-mirror-fixture';
import { safeArtifactDisplayName } from '@/lib/artifacts/artifact-mirror-manifest';

// The dev-only fixture behind `kiloapp:///dev/artifact-mirror-fixture/<name>`.
//
// It exists so the iOS Files app walkthrough (the only runtime surface of the
// `targets/ArtifactsFileProvider` extension) can run without a signed-in crawl:
// the links write a mirror into the app group the extension reads, then signal
// the provider domain. These tests hold the two things the walkthrough depends
// on: the links stay behind the fixture path, and the seeded index carries both
// shapes the extension resolves — the app's own output, and a stale index whose
// names still need sanitizing and deduplicating.

const spies = vi.hoisted(() => ({
  applyArtifactSnapshot: vi.fn(),
  clearArtifactMirror: vi.fn(),
  notifyArtifactsChanged: vi.fn(),
  registerArtifactsProviderDomain: vi.fn(),
}));

vi.mock('expo-file-system', () => ({ File: vi.fn() }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('@/lib/artifacts/artifact-mirror', () => ({
  applyArtifactSnapshot: spies.applyArtifactSnapshot,
  clearArtifactMirror: spies.clearArtifactMirror,
  // The walkthrough's own device has a container; the fixture writes no bytes
  // without one, which is what a test host reports.
  mirrorSessionDir: () => null,
}));
vi.mock('@/lib/artifacts/artifact-provider-native', () => ({
  notifyArtifactsChanged: spies.notifyArtifactsChanged,
  registerArtifactsProviderDomain: spies.registerArtifactsProviderDomain,
}));

const CRAWL = 'sess_fixture_artifacts';
const STALE = 'sess_fixture_stale_index';

const sessionOf = (id: string) => {
  const session = artifactMirrorFixtureManifest().sessions.find(entry => entry.id === id);
  if (!session) {
    throw new Error(`the fixture seeds no ${id} session`);
  }
  return session;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('artifact mirror fixture links', () => {
  it('seeds the index through the writer and signals the provider', () => {
    expect(handleArtifactMirrorFixturePath('/dev/artifact-mirror-fixture/seed')).toBe(true);

    expect(spies.applyArtifactSnapshot).toHaveBeenCalledOnce();
    expect(spies.applyArtifactSnapshot).toHaveBeenCalledWith(artifactMirrorFixtureManifest());
    expect(spies.registerArtifactsProviderDomain).toHaveBeenCalledOnce();
    expect(spies.notifyArtifactsChanged).toHaveBeenCalledOnce();
    expect(spies.clearArtifactMirror).not.toHaveBeenCalled();
  });

  it('releases the index and signals the provider', () => {
    expect(handleArtifactMirrorFixturePath('/dev/artifact-mirror-fixture/release')).toBe(true);

    expect(spies.clearArtifactMirror).toHaveBeenCalledOnce();
    expect(spies.notifyArtifactsChanged).toHaveBeenCalledOnce();
    expect(spies.applyArtifactSnapshot).not.toHaveBeenCalled();
  });

  it('answers an unknown fixture name without navigating or touching the mirror', () => {
    expect(handleArtifactMirrorFixturePath('/dev/artifact-mirror-fixture/seed-typo')).toBe(true);

    expect(spies.applyArtifactSnapshot).not.toHaveBeenCalled();
    expect(spies.clearArtifactMirror).not.toHaveBeenCalled();
    expect(spies.notifyArtifactsChanged).not.toHaveBeenCalled();
  });

  it('leaves every other link to the router', () => {
    expect(handleArtifactMirrorFixturePath('/dev/glanceable-fixture/compact')).toBe(false);
    expect(handleArtifactMirrorFixturePath('/agents/session-1')).toBe(false);

    expect(spies.applyArtifactSnapshot).not.toHaveBeenCalled();
    expect(spies.clearArtifactMirror).not.toHaveBeenCalled();
  });
});

describe('artifact mirror fixture manifest', () => {
  it("carries the app's own output, numbered exactly as the writer numbers it", () => {
    const names = sessionOf(CRAWL).files.map(file => file.name);

    expect(names).toContain('Quarterly report (2).csv');
    expect(names).toContain('Quarterly report (3).csv');
    // Distinct: the extension only has to sanitize and bound what it is given.
    expect(new Set(names).size).toBe(names.length);
  });

  it('carries a stale index whose names still need sanitizing and deduplicating', () => {
    const session = sessionOf(STALE);
    const names = session.files.map(file => file.name);

    // The extension resolves these itself, in manifest order.
    expect(names.filter(name => name === 'report.csv')).toHaveLength(2);
    expect(names).toContain('../../etc/passwd');
    expect(names).toContain('trailing.');
    expect(names).toContain('');
    // The reader is given names the writer would never write, which is the point.
    const sanitized = session.files.map(file => safeArtifactDisplayName(file));
    expect(sanitized).not.toEqual(names);
    // Ids stay unique, so a single-item lookup addresses one entry.
    expect(new Set(session.files.map(file => file.id)).size).toBe(session.files.length);
  });

  it('states every entry’s size from the bytes it writes', () => {
    for (const session of artifactMirrorFixtureManifest().sessions) {
      for (const file of session.files) {
        expect(file.size).toBeGreaterThan(0);
      }
    }
  });
});
