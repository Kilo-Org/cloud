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

const populated = makePreview({
  agents: {
    added: [{ id: 'agent-new', item: { slug: 'reviewer' } }],
    changed: [{ id: 'agent-existing', after: { slug: 'planner' } }],
  },
  commands: { added: [{ id: 'command-1', item: { name: 'explain' } }], changed: [] },
  skills: {
    added: [],
    changed: [{ id: 'skill-1', after: { name: 'pdf-tools' } }],
  },
  instructions: {
    added: [{ id: 'instruction-1', item: { name: 'release-notes' } }],
    changed: [],
  },
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
            { severity: 'error', message: 'line 2, column 4: Unexpected token' },
            { severity: 'warning', message: 'Ignored an unmapped file' },
          ],
        })
      )
    ).toEqual([
      { severity: 'error', message: 'line 2, column 4: Unexpected token' },
      { severity: 'warning', message: 'Ignored an unmapped file' },
    ]);
  });
});
