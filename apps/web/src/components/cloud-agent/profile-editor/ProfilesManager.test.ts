/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Register Jest mocks before loading the component. */
import { jest } from '@jest/globals';
import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ProfilesManagerModule from './ProfilesManager';
import type { ProfileDetailPane } from './ProfileDetailPane';
import type { ProfileSummary, ProfileSummaryWithOwner } from '@/hooks/useCloudAgentProfiles';

const mockCanManage = jest.fn<() => { data?: { canManage: boolean }; error?: Error }>();
const mockProfiles = jest.fn<() => { data: ProfileSummary[] }>(() => ({ data: [] }));
const mockCombinedProfiles = jest.fn<
  () => {
    data?: { orgProfiles: ProfileSummaryWithOwner[]; personalProfiles: ProfileSummaryWithOwner[] };
    isLoading?: boolean;
  }
>();
const mockDetailPane = jest.fn<(props: ComponentProps<typeof ProfileDetailPane>) => null>(
  () => null
);

const personalProfile: ProfileSummaryWithOwner = {
  id: 'profile-1',
  name: 'My Profile',
  ownerType: 'user',
  description: null,
  isDefault: false,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  varCount: 2,
  commandCount: 0,
  mcpServerCount: 1,
  skillCount: 6,
  agentCount: 0,
  kiloCommandCount: 0,
  instructionCount: 0,
};

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useCloudAgentSettings: () => mockCanManage(),
}));

jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useCombinedProfiles: () => mockCombinedProfiles(),
  useProfiles: () => mockProfiles(),
  useCombinedProfileMutations: () => ({}),
  useProfileMutations: () => ({}),
}));

jest.mock('./ProfileDetailPane', () => ({
  ProfileDetailPane: (props: ComponentProps<typeof ProfileDetailPane>) => mockDetailPane(props),
}));

const { ProfilesManager } = require('./ProfilesManager') as typeof ProfilesManagerModule;

Object.assign(globalThis, { React });

function renderManager(props: ComponentProps<typeof ProfilesManager>): string {
  return renderToStaticMarkup(createElement(ProfilesManager, props));
}

beforeEach(() => {
  mockCanManage.mockReset().mockReturnValue({});
  mockProfiles.mockReset().mockReturnValue({ data: [] });
  mockCombinedProfiles
    .mockReset()
    .mockReturnValue({ data: { orgProfiles: [], personalProfiles: [] } });
  mockDetailPane.mockClear();
});

describe('ProfilesManager owner scope', () => {
  it('shows profile names without abbreviated collection counts', () => {
    mockProfiles.mockReturnValue({ data: [personalProfile] });

    const markup = renderManager({ owner: 'user' });

    expect(markup).toContain('My Profile');
    expect(markup).not.toContain('2v');
    expect(markup).not.toContain('1m');
    expect(markup).not.toContain('6s');
  });

  it.each([
    ['organization', 'Team Profile', 'My Profile'],
    ['user', 'My Profile', 'Team Profile'],
  ] as const)('only lists %s profiles in an organization workspace', (owner, shown, hidden) => {
    mockCombinedProfiles.mockReturnValue({
      data: {
        orgProfiles: [
          {
            ...personalProfile,
            id: 'org-profile',
            name: 'Team Profile',
            ownerType: 'organization',
          },
        ],
        personalProfiles: [personalProfile],
      },
    });

    const markup = renderManager({ owner, organizationId: 'org-1' });

    expect(markup).toContain(shown);
    expect(markup).not.toContain(hidden);
  });

  it('opens an organization profile by ID before the list loads', () => {
    mockCombinedProfiles.mockReturnValue({ isLoading: true });

    renderManager({
      owner: 'organization',
      organizationId: 'org-1',
      initialSelectedProfileId: 'org-profile',
    });

    expect(mockDetailPane).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'org-profile',
        ownerType: 'organization',
        organizationId: 'org-1',
      })
    );
  });
});

describe('ProfilesManager creation permissions', () => {
  it('allows organization creation for managers', () => {
    mockCanManage.mockReturnValue({ data: { canManage: true } });

    const markup = renderManager({
      owner: 'organization',
      organizationId: 'org-1',
      openToNewProfile: true,
    });

    expect(markup).not.toContain('>Owner</label>');
    expect(markup).not.toContain('organization-profile-permission');
  });

  it.each([
    [
      'member or billing manager',
      { data: { canManage: false } },
      'Only organization owners and admins can create organization profiles.',
    ],
    ['loading', {}, 'Checking organization permissions...'],
    [
      'failed permission query',
      { error: new Error('Permission lookup failed') },
      'Could not check organization permissions.',
    ],
    [
      'failed refetch with cached permissions',
      { data: { canManage: true }, error: new Error('Permission lookup failed') },
      'Could not check organization permissions.',
    ],
  ])('disables organization creation for %s', (_state, permissions, message) => {
    mockCanManage.mockReturnValue(permissions);

    const markup = renderManager({
      owner: 'organization',
      organizationId: 'org-1',
      openToNewProfile: true,
    });

    expect(markup).not.toContain('>Owner</label>');
    expect(markup).toContain('aria-describedby="organization-profile-permission"');
    expect(markup).toContain(message);
    expect(markup).toContain('New Profile');
    expect(markup).toContain('id="new-profile-name"');
  });

  it('does not show organization ownership in personal context', () => {
    mockCanManage.mockReturnValue({});

    const markup = renderManager({ owner: 'user', openToNewProfile: true });

    expect(markup).not.toContain('>Owner</label>');
    expect(markup).not.toContain('organization-profile-permission');
    expect(markup).toContain('New Profile');
    expect(markup).toContain('id="new-profile-name"');
  });
});
