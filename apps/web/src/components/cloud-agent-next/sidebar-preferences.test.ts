import { describe, expect, it } from '@jest/globals';
import type { SidebarPreferences } from './sidebar-preferences';
import { encodeSidebarPreferences, parseSidebarPreferences } from './sidebar-preferences';

const preferences = {
  platformFilter: ['cloud-agent'],
  projectFilter: ['https://github.com/acme/app'],
  collapsedFolderIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
};

// The server reads the cookie value decoded.
function roundTrip(value: SidebarPreferences, writer: string, reader: string) {
  return parseSidebarPreferences(
    decodeURIComponent(encodeSidebarPreferences(value, writer)),
    reader
  );
}

describe('sidebar preferences cookie', () => {
  it('reads back what it wrote for the same user', () => {
    expect(roundTrip(preferences, 'user-1', 'user-1')).toEqual(preferences);
  });

  it('ignores a value written for another user', () => {
    expect(roundTrip(preferences, 'user-1', 'user-2')).toBeNull();
  });

  it('ignores a missing or malformed value', () => {
    expect(parseSidebarPreferences(undefined, 'user-1')).toBeNull();
    expect(parseSidebarPreferences('{not json', 'user-1')).toBeNull();
    expect(parseSidebarPreferences(JSON.stringify({ u: 'user-1', p: 'x' }), 'user-1')).toBeNull();
  });

  it('stays under the cookie size and keeps the most recent collapsed folders', () => {
    const collapsedFolderIds = Array.from(
      { length: 60 },
      (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`
    );
    const projectFilter = Array.from(
      { length: 20 },
      (_, index) => `https://github.com/an-organization-with-a-long-name/repository-${index}`
    );
    const value = { ...preferences, projectFilter, collapsedFolderIds };

    const encoded = encodeSidebarPreferences(value, 'user-1');
    const parsed = parseSidebarPreferences(decodeURIComponent(encoded), 'user-1');

    expect(encoded.length).toBeLessThanOrEqual(3800);
    expect(parsed?.projectFilter).toEqual(projectFilter);
    expect(parsed?.collapsedFolderIds.length).toBeGreaterThan(0);
    expect(collapsedFolderIds.slice(-(parsed?.collapsedFolderIds.length ?? 0))).toEqual(
      parsed?.collapsedFolderIds
    );
  });
});
