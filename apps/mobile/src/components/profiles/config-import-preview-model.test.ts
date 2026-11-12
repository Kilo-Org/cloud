import { describe, expect, it } from 'vitest';

import {
  defaultImportSelection,
  hasImportableItems,
  importCategoryViews,
  importIssueViews,
  type ImportPreviewInput,
  importSelectionRequest,
  selectedImportCount,
  selectedOverwriteCount,
} from '@/components/profiles/config-import-preview-model';

function makePreview(overrides: {
  agents?: ImportPreviewInput['agents'];
  commands?: ImportPreviewInput['commands'];
  skills?: ImportPreviewInput['skills'];
  instructions?: ImportPreviewInput['instructions'];
  issues?: ImportPreviewInput['issues'];
}): ImportPreviewInput {
  const empty = { added: [], changed: [] };
  return {
    agents: overrides.agents ?? empty,
    commands: overrides.commands ?? empty,
    skills: overrides.skills ?? empty,
    instructions: overrides.instructions ?? empty,
    issues: overrides.issues ?? [],
  };
}

type AgentItem = ImportPreviewInput['agents']['added'][number]['item'];
type CommandItem = ImportPreviewInput['commands']['added'][number]['item'];
type SkillItem = ImportPreviewInput['skills']['added'][number]['item'];
type InstructionItem = ImportPreviewInput['instructions']['added'][number]['item'];

/** Fixtures hold the server's own item shapes, so a fixture cannot describe a definition it never sends. */
function added<T>(id: string, item: T) {
  return { id, item };
}

function changed<T>(id: string, item: T) {
  return { id, before: item, after: item, changes: [] };
}

function agent(slug: string): AgentItem {
  return { slug, name: slug, config: {} };
}

function command(name: string): CommandItem {
  return {
    name,
    description: null,
    template: '',
    agent: null,
    model: null,
    subtask: false,
    enabled: true,
  };
}

function skill(name: string): SkillItem {
  return {
    name,
    description: null,
    rawMarkdown: '',
    files: {},
    enabled: true,
    sourceType: 'custom',
    sourceUrl: null,
  };
}

function instruction(name: string): InstructionItem {
  return { name, content: '', enabled: true };
}

function issue(
  severity: ImportPreviewInput['issues'][number]['severity'],
  message: string
): ImportPreviewInput['issues'][number] {
  return { severity, code: 'parse', category: 'archive', path: null, field: null, message };
}

const populated = makePreview({
  agents: {
    added: [added('agent-new', agent('reviewer'))],
    changed: [changed('agent-existing', agent('planner'))],
  },
  commands: { added: [added('command-1', command('explain'))], changed: [] },
  skills: { added: [], changed: [changed('skill-1', skill('pdf-tools'))] },
  instructions: { added: [added('instruction-1', instruction('release-notes'))], changed: [] },
});

describe('importCategoryViews', () => {
  it('lists each category with its added and changed definitions', () => {
    const views = importCategoryViews(populated);
    expect(views.map(section => section.category)).toEqual([
      'agents',
      'commands',
      'skills',
      'instructions',
    ]);
    expect(views[0]?.items).toEqual([
      { id: 'agent-new', label: 'reviewer', status: 'added' },
      { id: 'agent-existing', label: 'planner', status: 'changed' },
    ]);
  });

  it('drops a category with nothing to import', () => {
    const views = importCategoryViews(
      makePreview({ instructions: populated.instructions, issues: [] })
    );
    expect(views.map(section => section.category)).toEqual(['instructions']);
  });

  it('reports nothing to import for an archive that matches the profile', () => {
    expect(hasImportableItems(importCategoryViews(makePreview({})))).toBe(false);
  });
});

describe('selection', () => {
  const views = importCategoryViews(populated);

  it('selects every section with something to import', () => {
    expect(defaultImportSelection(views)).toEqual({
      agents: true,
      commands: true,
      skills: true,
      instructions: true,
    });
  });

  it('counts the definitions the selection imports', () => {
    expect(selectedImportCount(views, defaultImportSelection(views))).toBe(5);
    expect(
      selectedImportCount(views, {
        agents: true,
        commands: false,
        skills: false,
        instructions: false,
      })
    ).toBe(2);
  });

  it('counts the definitions that overwrite a cloud definition', () => {
    expect(selectedOverwriteCount(views, defaultImportSelection(views))).toBe(2);
    expect(
      selectedOverwriteCount(views, {
        agents: false,
        commands: false,
        skills: false,
        instructions: true,
      })
    ).toBe(0);
  });

  it('builds the id lists the server takes, dropping unselected sections', () => {
    expect(
      importSelectionRequest(views, {
        agents: true,
        commands: false,
        skills: true,
        instructions: false,
      })
    ).toEqual({
      agents: ['agent-new', 'agent-existing'],
      commands: [],
      skills: ['skill-1'],
      instructions: [],
    });
  });
});

describe('importIssueViews', () => {
  it('keeps the server severity and message', () => {
    expect(
      importIssueViews(
        makePreview({
          issues: [
            issue('error', 'line 2, column 4: Unexpected token'),
            issue('warning', 'Ignored an unmapped file'),
          ],
        })
      )
    ).toEqual([
      { severity: 'error', message: 'line 2, column 4: Unexpected token' },
      { severity: 'warning', message: 'Ignored an unmapped file' },
    ]);
  });
});
