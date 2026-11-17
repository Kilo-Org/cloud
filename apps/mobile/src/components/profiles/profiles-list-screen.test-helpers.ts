/**
 * Shared fixtures for the Profiles list screen's mounted tests. Two sibling
 * suites mount the same screen (the list, and the repo-defaults entry it
 * hosts), so the profile fixture and the tree readers live here once.
 */

import { type ReactTestInstance } from '@/test/renderer';

/** The catalog title of the repo-defaults entry the list hosts. */
const REPO_DEFAULTS_TITLE = 'Default profiles';

/** The catalog word over the settings group that hosts the entry. */
export const REPO_DEFAULTS_HEADING = 'Repositories';

/** The profile summary shape the mocked `agentProfiles.list` answers with. */
export type ProfileSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  varCount: number;
  commandCount: number;
  mcpServerCount: number;
  skillCount: number;
  kiloCommandCount: number;
  agentCount: number;
  ownerType?: 'organization' | 'user';
};

export function profile(overrides: Partial<ProfileSummary> & { id: string }): ProfileSummary {
  return {
    name: 'Backend debugging',
    isDefault: false,
    varCount: 0,
    commandCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    kiloCommandCount: 0,
    agentCount: 0,
    ...overrides,
  };
}

export function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

export function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

export function rowTitles(root: ReactTestInstance): string[] {
  return findAll(root, 'ConfigureRow').map(row => String(row.props.title));
}

export function textChildren(root: ReactTestInstance): string[] {
  return findAll(root, 'Text').map(node => String(node.props.children));
}

/** The repo-defaults entry the list renders after its profile sections. */
export function repoDefaultsRow(root: ReactTestInstance): ReactTestInstance {
  const row = findAll(root, 'ConfigureRow').find(
    candidate => candidate.props.title === REPO_DEFAULTS_TITLE
  );
  if (!row) {
    throw new Error('repo defaults entry missing');
  }
  return row;
}

/** A row by its title, wherever the list renders it. */
export function rowByTitle(root: ReactTestInstance, title: string): ReactTestInstance {
  const row = findAll(root, 'ConfigureRow').find(candidate => candidate.props.title === title);
  if (!row) {
    throw new Error(`${title} row missing`);
  }
  return row;
}

/** The container element that directly holds `row`, with nothing else mixed in. */
export function rowGroup(root: ReactTestInstance, row: ReactTestInstance): ReactTestInstance {
  for (const view of findAll(root, 'View')) {
    if (view.children.includes(row)) {
      return view;
    }
  }
  throw new Error('row group missing');
}

/** The elements directly inside `group`, without the text fragments between them. */
export function groupChildren(group: ReactTestInstance): ReactTestInstance[] {
  return group.children.filter((child): child is ReactTestInstance => typeof child !== 'string');
}

/** The `Text` elements a group renders, its heading first. */
export function groupTexts(group: ReactTestInstance): ReactTestInstance[] {
  return findAll(group, 'Text');
}

/** The heading that opens the group hosting the repo-defaults entry. */
export function repoDefaultsHeading(root: ReactTestInstance): ReactTestInstance {
  const [heading] = groupTexts(rowGroup(root, repoDefaultsRow(root)));
  if (!heading) {
    throw new Error('repo defaults group has no heading');
  }
  return heading;
}
