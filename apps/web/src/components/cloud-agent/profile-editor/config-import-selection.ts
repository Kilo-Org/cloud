/** Item and section selection for the config import preview. */
import {
  IMPORT_CATEGORIES,
  type ImportCategory,
  type ImportSelection,
} from '@kilocode/cloud-agent-profile/import';

type SelectablePreview = Record<
  ImportCategory,
  { added: Array<{ id: string }>; changed: Array<{ id: string }> }
>;

/** Identities the preview offers for import, per category. */
export type SelectableIds = Record<ImportCategory, readonly string[]>;

export type ImportSelectionState = Record<ImportCategory, ReadonlySet<string>>;

export type SectionCheckState = boolean | 'indeterminate';

function mapCategories<T>(build: (category: ImportCategory) => T): Record<ImportCategory, T> {
  return {
    agents: build('agents'),
    commands: build('commands'),
    skills: build('skills'),
    instructions: build('instructions'),
  };
}

export function getSelectableIds(preview: SelectablePreview): SelectableIds {
  return mapCategories(category => [
    ...preview[category].added.map(entry => entry.id),
    ...preview[category].changed.map(entry => entry.id),
  ]);
}

/** Identities that already exist on the profile, so importing them overwrites cloud edits. */
export function getChangedIds(preview: SelectablePreview): SelectableIds {
  return mapCategories(category => preview[category].changed.map(entry => entry.id));
}

/** Every offered item starts selected. */
export function selectAll(ids: SelectableIds): ImportSelectionState {
  return mapCategories(category => new Set(ids[category]));
}

export function setItemSelected(
  state: ImportSelectionState,
  category: ImportCategory,
  id: string,
  selected: boolean
): ImportSelectionState {
  const next = new Set(state[category]);
  if (selected) next.add(id);
  else next.delete(id);
  return { ...state, [category]: next };
}

export function setSectionSelected(
  state: ImportSelectionState,
  ids: SelectableIds,
  category: ImportCategory,
  selected: boolean
): ImportSelectionState {
  return { ...state, [category]: new Set(selected ? ids[category] : []) };
}

export function getSectionCheckState(
  state: ImportSelectionState,
  ids: SelectableIds,
  category: ImportCategory
): SectionCheckState {
  const selectedCount = ids[category].filter(id => state[category].has(id)).length;
  if (selectedCount === 0) return false;
  return selectedCount === ids[category].length ? true : 'indeterminate';
}

/** Count the selected identities among `ids`. */
export function countSelected(state: ImportSelectionState, ids: SelectableIds): number {
  return IMPORT_CATEGORIES.reduce(
    (total, category) => total + ids[category].filter(id => state[category].has(id)).length,
    0
  );
}

export function toImportSelection(state: ImportSelectionState): ImportSelection {
  return mapCategories(category => [...state[category]]);
}
