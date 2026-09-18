import { describe, expect, it } from 'vitest';

import {
  defaultControlLabel,
  defaultDescriptionKey,
  deleteErrorMessage,
  metadataFormKey,
  overviewSectionRows,
} from '@/components/profiles/profile-overview-model';

describe('defaultControlLabel', () => {
  it('offers to set the profile as default when it is not', () => {
    expect(defaultControlLabel(false)).toBe('profiles.setAsDefault');
  });

  it('offers to remove the default when it is', () => {
    expect(defaultControlLabel(true)).toBe('profiles.removeDefault');
  });
});

describe('defaultDescriptionKey', () => {
  it('explains the personal rule for a personal profile', () => {
    expect(defaultDescriptionKey(false)).toBe('profiles.personalDefaultDescription');
  });

  it('explains the organization rule for an org profile', () => {
    expect(defaultDescriptionKey(true)).toBe('profiles.organizationDefaultDescription');
  });
});

describe('deleteErrorMessage', () => {
  it('classifies a PRECONDITION_FAILED response as blocked', () => {
    expect(deleteErrorMessage({ data: { code: 'PRECONDITION_FAILED' } })).toBe('blocked');
  });

  it('classifies a generic failure as failed', () => {
    expect(deleteErrorMessage(new Error('network down'))).toBe('failed');
    expect(deleteErrorMessage({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe('failed');
    expect(deleteErrorMessage(null)).toBe('failed');
    expect(deleteErrorMessage(undefined)).toBe('failed');
  });
});

describe('metadataFormKey', () => {
  it('is stable when only the profile timestamp changes', () => {
    expect(metadataFormKey({ name: 'Backend', description: 'Old' })).toBe(
      metadataFormKey({ name: 'Backend', description: 'Old' })
    );
  });

  it('changes when the name or the description changes', () => {
    const base = metadataFormKey({ name: 'Backend', description: 'Old' });
    expect(metadataFormKey({ name: 'Renamed', description: 'Old' })).not.toBe(base);
    expect(metadataFormKey({ name: 'Backend', description: 'New' })).not.toBe(base);
  });

  it('treats an absent description as an empty one', () => {
    expect(metadataFormKey({ name: 'Backend', description: null })).toBe(
      metadataFormKey({ name: 'Backend', description: '' })
    );
  });
});

describe('overviewSectionRows', () => {
  it('returns the six sections in a fixed order with their counts', () => {
    const rows = overviewSectionRows({
      vars: [{ key: 'A' }, { key: 'B' }, { key: 'C' }],
      commands: ['pnpm install', 'pnpm build'],
      kiloCommands: [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }, { id: 'k4' }],
      mcpServers: [{ id: 'm1' }],
      skills: [{ id: 'skill-1' }],
      agents: [{ id: 'a1' }, { id: 'a2' }],
    });

    expect(rows).toEqual([
      { key: 'variables', titleKey: 'profiles.variablesTitle', count: 3 },
      { key: 'commands', titleKey: 'profiles.commandsTitle', count: 2 },
      { key: 'slashCommands', titleKey: 'profiles.slashCommands.title', count: 4 },
      { key: 'mcp', titleKey: 'profiles.mcp.title', count: 1 },
      { key: 'skills', titleKey: 'profiles.skillsTitle', count: 1 },
      { key: 'agents', titleKey: 'profiles.agents.title', count: 2 },
    ]);
  });

  it('keeps every row with zero counts for an empty profile', () => {
    expect(
      overviewSectionRows({
        vars: [],
        commands: [],
        kiloCommands: [],
        mcpServers: [],
        skills: [],
        agents: [],
      })
    ).toEqual([
      { key: 'variables', titleKey: 'profiles.variablesTitle', count: 0 },
      { key: 'commands', titleKey: 'profiles.commandsTitle', count: 0 },
      { key: 'slashCommands', titleKey: 'profiles.slashCommands.title', count: 0 },
      { key: 'mcp', titleKey: 'profiles.mcp.title', count: 0 },
      { key: 'skills', titleKey: 'profiles.skillsTitle', count: 0 },
      { key: 'agents', titleKey: 'profiles.agents.title', count: 0 },
    ]);
  });
});
