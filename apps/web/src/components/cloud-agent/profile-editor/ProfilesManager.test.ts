/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Register Jest mocks before loading the component. */
import { jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ProfilesManagerModule from './ProfilesManager';

const mockCanManage = jest.fn<() => { data?: { canManage: boolean }; error?: Error }>();

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useCloudAgentSettings: () => mockCanManage(),
}));

jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useCombinedProfiles: () => ({ data: { orgProfiles: [], personalProfiles: [] } }),
  useProfiles: () => ({ data: [] }),
  useCombinedProfileMutations: () => ({}),
  useProfileMutations: () => ({}),
}));

jest.mock('./ProfileDetailPane', () => ({ ProfileDetailPane: () => null }));

const { ProfilesManager } = require('./ProfilesManager') as typeof ProfilesManagerModule;

Object.assign(globalThis, { React });

function renderManager(organizationId: string | undefined = 'org-1'): string {
  return renderToStaticMarkup(
    createElement(ProfilesManager, { organizationId, openToNewProfile: true })
  );
}

describe('ProfilesManager creation permissions', () => {
  it('allows organization creation for managers', () => {
    mockCanManage.mockReturnValue({ data: { canManage: true } });

    const markup = renderManager();

    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>.*?Organization<\/button>/);
    expect(markup).not.toContain('disabled="" aria-pressed="false"');
    expect(markup).not.toContain('Only organization owners and admins');
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

    const markup = renderManager();

    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*aria-pressed="false"[^>]*aria-describedby="organization-profile-permission"[^>]*>.*?Organization<\/button>/
    );
    expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*?Personal<\/button>/);
    expect(markup).not.toContain('disabled="" aria-pressed="true"');
    expect(markup).toContain(message);
    expect(markup).toContain('New Profile');
    expect(markup).toContain('id="new-profile-name"');
  });

  it('does not show organization ownership in personal context', () => {
    mockCanManage.mockReturnValue({});

    const markup = renderManager('');

    expect(markup).not.toContain('Organization</button>');
    expect(markup).not.toContain('Only organization owners and admins');
    expect(markup).toContain('New Profile');
    expect(markup).toContain('id="new-profile-name"');
  });
});
