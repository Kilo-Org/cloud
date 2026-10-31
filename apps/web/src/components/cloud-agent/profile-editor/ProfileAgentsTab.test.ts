/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Register Jest mocks before loading the component. */
import { jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ProfileAgentsTabModule from './ProfileAgentsTab';
import type { ProfileAgent } from '@/hooks/useCloudAgentProfiles';

const mockMutations = {};

jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useProfileMutations: () => mockMutations,
}));

const { ProfileAgentsTab } = require('./ProfileAgentsTab') as typeof ProfileAgentsTabModule;

Object.assign(globalThis, { React });

function agent(id: string, name: string, slug: string): ProfileAgent {
  return {
    id,
    profileId: 'profile-1',
    slug,
    name,
    config: { mode: 'primary' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ProfileAgent;
}

function renderTab(agents: ProfileAgent[]): string {
  return renderToStaticMarkup(
    createElement(ProfileAgentsTab, {
      profileId: 'profile-1',
      organizationId: undefined,
      agents,
      readOnly: true,
    })
  );
}

describe('ProfileAgentsTab slug chip', () => {
  it('leaves out the slug of an agent whose name it only repeats', () => {
    const html = renderTab([
      agent('a', 'Reviewer', 'reviewer'),
      agent('b', 'Code Reviewer', 'code-reviewer'),
      agent('c', 'Reviewer', 'reviewer-pro'),
    ]);

    expect(html).not.toContain('>reviewer<');
    expect(html).not.toContain('>code-reviewer<');
    expect(html).toContain('>reviewer-pro<');
  });
});