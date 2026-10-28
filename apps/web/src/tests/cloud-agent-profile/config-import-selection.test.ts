import { describe, expect, test } from '@jest/globals';
import {
  countSelected,
  getChangedIds,
  getSectionCheckState,
  getSelectableIds,
  selectAll,
  setItemSelected,
  setSectionSelected,
  toImportSelection,
} from '@/components/cloud-agent/profile-editor/config-import-selection';

const preview = {
  agents: { added: [{ id: 'reviewer' }, { id: 'triage' }], changed: [{ id: 'auditor' }] },
  commands: { added: [], changed: [{ id: 'fix' }] },
  skills: { added: [], changed: [] },
  instructions: { added: [{ id: 'style' }], changed: [] },
};

describe('config import selection', () => {
  const ids = getSelectableIds(preview);

  test('starts with every offered definition selected', () => {
    const selection = selectAll(ids);
    expect(toImportSelection(selection)).toEqual({
      agents: ['reviewer', 'triage', 'auditor'],
      commands: ['fix'],
      skills: [],
      instructions: ['style'],
    });
    expect(countSelected(selection, ids)).toBe(5);
    expect(countSelected(selection, getChangedIds(preview))).toBe(2);
  });

  test('marks a section indeterminate when only some items are selected', () => {
    const selection = setItemSelected(selectAll(ids), 'agents', 'triage', false);
    expect(getSectionCheckState(selection, ids, 'agents')).toBe('indeterminate');
    expect(getSectionCheckState(selection, ids, 'commands')).toBe(true);
    expect(toImportSelection(selection).agents).toEqual(['reviewer', 'auditor']);
  });

  test('toggles a whole section without touching other sections', () => {
    const cleared = setSectionSelected(selectAll(ids), ids, 'agents', false);
    expect(getSectionCheckState(cleared, ids, 'agents')).toBe(false);
    expect(countSelected(cleared, ids)).toBe(2);

    const restored = setSectionSelected(cleared, ids, 'agents', true);
    expect(getSectionCheckState(restored, ids, 'agents')).toBe(true);
    expect(countSelected(restored, ids)).toBe(5);
  });
});
