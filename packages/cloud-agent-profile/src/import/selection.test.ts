import { describe, expect, test } from 'vitest';
import { selectImportItems } from './selection';
import type { ParsedLocalConfig } from './types';

const config: ParsedLocalConfig = {
  agents: [
    { slug: 'reviewer', name: 'reviewer', config: { prompt: 'Review.' } },
    { slug: 'triage', name: 'triage', config: { prompt: 'Triage.' } },
  ],
  commands: [{ name: 'fix', template: 'Fix it' }],
  skills: [{ name: 'deploy', rawMarkdown: '# Deploy', files: {} }],
  instructions: [{ name: 'style', content: 'Small functions.' }],
};

describe('selectImportItems', () => {
  test('keeps only the selected definitions in each category', () => {
    const result = selectImportItems(config, {
      agents: ['triage'],
      commands: [],
      skills: ['deploy'],
      instructions: [],
    });
    expect(result).toEqual({
      ok: true,
      config: {
        agents: [config.agents[1]],
        commands: [],
        skills: config.skills,
        instructions: [],
      },
    });
  });

  test('rejects an identity the archive cannot import', () => {
    const result = selectImportItems(config, {
      agents: ['reviewer'],
      commands: ['plan'],
      skills: [],
      instructions: [],
    });
    expect(result).toEqual({ ok: false, category: 'commands', id: 'plan' });
  });
});
