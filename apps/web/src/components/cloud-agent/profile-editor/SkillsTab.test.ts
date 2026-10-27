/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Register Jest mocks before loading the component. */
import { jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as SkillsTabModule from './SkillsTab';
import type { ProfileSkill } from '@/hooks/useCloudAgentProfiles';

const mockMutations = {
  createCustomSkill: { mutateAsync: jest.fn() },
  createSkillsShSkill: { mutateAsync: jest.fn(), isPending: false },
  deleteSkill: { mutateAsync: jest.fn() },
  setSkillEnabled: { mutateAsync: jest.fn(), isPending: false },
};

jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useProfileMutations: () => mockMutations,
}));

const { SkillsTab, skillsShSourceError, skillsShSubmitError } =
  require('./SkillsTab') as typeof SkillsTabModule;

Object.assign(globalThis, { React });

function renderSkillsTab(skills: ProfileSkill[]): string {
  return renderToStaticMarkup(
    createElement(SkillsTab, { profileId: 'profile-1', organizationId: undefined, skills })
  );
}

function skill(overrides: Partial<ProfileSkill>): ProfileSkill {
  return {
    id: 'skill-1',
    name: 'skill',
    description: null,
    sourceType: 'custom',
    sourceUrl: null,
    rawMarkdown: '',
    files: {},
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SkillsTab', () => {
  it('maps invalid skills.sh sources to readable validation copy', () => {
    expect(skillsShSourceError('')).toBe('Enter a skills.sh source.');
    expect(skillsShSourceError('not a source')).toContain('owner/repo@skill');
    expect(skillsShSourceError('https://evil.example/owner/repo/skill')).toContain(
      'owner/repo@skill'
    );
    expect(skillsShSourceError('owner/repo@skill')).toBeNull();
    expect(skillsShSourceError('https://skills.sh/owner/repo/skill')).toBeNull();
    expect(skillsShSubmitError(new Error('[{"code":"custom","message":"Invalid"}]'))).toBe(
      'Could not add skill. Check the skills.sh reference and try again.'
    );
    expect(skillsShSubmitError(new Error('Profiles are limited to 50 skills'))).toBe(
      'Profiles are limited to 50 skills'
    );
  });

  it('renders a skills.sh source form with an example and directory link', () => {
    const markup = renderSkillsTab([]);

    expect(markup).toContain('Add from skills.sh');
    expect(markup).toContain('anthropics/skills@frontend-design');
    expect(markup).toContain('href="https://skills.sh"');
    expect(markup).toContain('Browse skills.sh');
  });

  it('renders remote skills with their source and container setup status', () => {
    const markup = renderSkillsTab([
      skill({
        name: 'frontend-design',
        sourceType: 'skills-sh',
        sourceUrl: 'https://skills.sh/anthropics/skills/frontend-design',
        rawMarkdown: '',
        enabled: true,
      }),
    ]);

    expect(markup).toContain('Installed during container setup');
    expect(markup).not.toContain('0.0 KB');
    expect(markup).toContain('href="https://skills.sh/anthropics/skills/frontend-design"');
    expect(markup).toContain('skills.sh/anthropics/skills/frontend-design');
    expect(markup).toContain('aria-label="Disable skill frontend-design"');
  });

  it('does not offer manual editing for remote skills', () => {
    const markup = renderSkillsTab([
      skill({
        name: 'frontend-design',
        sourceType: 'skills-sh',
        sourceUrl: 'https://skills.sh/anthropics/skills/frontend-design',
      }),
    ]);

    expect(markup).not.toContain('Edit skill frontend-design');
  });

  it('keeps manual editing and size for custom skills', () => {
    const markup = renderSkillsTab([
      skill({
        name: 'my-skill',
        rawMarkdown: 'x'.repeat(2048),
        sourceType: 'custom',
      }),
    ]);

    expect(markup).toContain('2.0 KB');
    expect(markup).toContain('aria-label="Edit skill my-skill"');
    expect(markup).not.toContain('Installed during container setup');
  });
});
