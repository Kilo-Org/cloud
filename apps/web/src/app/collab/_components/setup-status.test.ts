import { describe, expect, test } from '@jest/globals';
import {
  buildPlatformSetupStatuses,
  getConnectedPlatformIds,
  getSelectedServiceIdsToAuthorize,
  hasAnyConfiguredOrSelectedPlatform,
} from './setup-status';
import { CHAT_PLATFORM_IDS, CODE_PLATFORM_IDS, type PlatformId } from './platforms';

describe('collab setup status', () => {
  test('marks installed integrations as already set up with account details', () => {
    const statuses = buildPlatformSetupStatuses({
      data: [
        { platform: 'slack', installed: true, installation: { teamName: 'Kilo Team' } },
        { platform: 'github', installed: true, installation: { accountLogin: 'kilocode' } },
        { platform: 'linear', installed: false, installation: null },
      ],
      isError: false,
      isLoading: false,
    });

    expect(statuses.slack).toEqual({
      kind: 'connected',
      label: 'Already set up',
      detail: 'Kilo Team',
    });
    expect(statuses.github).toEqual({
      kind: 'connected',
      label: 'Already set up',
      detail: 'kilocode',
    });
    expect(statuses.linear).toEqual({ kind: 'not_connected', label: 'Not set up' });
  });

  test('keeps services without an authorization path out of selection', () => {
    const statuses = buildPlatformSetupStatuses({
      data: [],
      isError: false,
      isLoading: false,
    });
    const selected: PlatformId[] = ['microsoft-teams', 'google-chat', 'slack'];

    expect(statuses['microsoft-teams']).toEqual({
      kind: 'unavailable',
      label: 'Not available yet',
    });
    expect(statuses['google-chat']).toEqual({
      kind: 'unavailable',
      label: 'Not available yet',
    });
    expect(getSelectedServiceIdsToAuthorize(selected, statuses)).toEqual(['slack']);
  });

  test('counts already set up services toward chat and code coverage', () => {
    const statuses = buildPlatformSetupStatuses({
      data: [
        { platform: 'slack', installed: true, installation: { teamName: 'Kilo Team' } },
        { platform: 'gitlab', installed: true, installation: { accountLogin: 'kilocode' } },
      ],
      isError: false,
      isLoading: false,
    });

    expect(hasAnyConfiguredOrSelectedPlatform(CHAT_PLATFORM_IDS, [], statuses)).toBe(true);
    expect(hasAnyConfiguredOrSelectedPlatform(CODE_PLATFORM_IDS, [], statuses)).toBe(true);
  });

  test('filters connected services out of the authorization queue', () => {
    const statuses = buildPlatformSetupStatuses({
      data: [
        { platform: 'slack', installed: true, installation: { teamName: 'Kilo Team' } },
        { platform: 'github', installed: false, installation: null },
      ],
      isError: false,
      isLoading: false,
    });

    expect(getConnectedPlatformIds(statuses)).toEqual(['slack']);
    expect(getSelectedServiceIdsToAuthorize(['slack', 'github'], statuses)).toEqual(['github']);
  });

  test('treats background refetches as checking before using cached setup status', () => {
    const statuses = buildPlatformSetupStatuses({
      data: [{ platform: 'github', installed: false, installation: null }],
      isError: false,
      isFetching: true,
      isLoading: false,
    });

    expect(statuses.github).toEqual({ kind: 'checking', label: 'Checking' });
  });
});
