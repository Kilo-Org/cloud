import { type ModeOption } from '@/components/agents/mode-normalize';
import { type RepoOption, type RepoPickerSection } from '@/lib/picker-bridge';
import {
  branchPickerSlot,
  folderPickerSlot,
  modePickerSlot,
  repoPickerSlot,
  UNFENCED_ROUTE_KEY,
} from '@/lib/route-registry';

/**
 * Development-only entries for the new-session pickers that only the composer
 * opens: branch, folder, mode, and repository. Each sheet reads its rows from
 * the bridge the composer writes, so a deep link alone renders the expired
 * state. These fixtures write the same bridge and open the same route, which is
 * the only way a design-gate run can measure the sheets. No fixture presses a
 * row, so each bridge's `onSelect` has nothing to report.
 *
 * Links (development scheme, mapped in `src/app/+native-intent.tsx`):
 * - `kiloapp:///dev/branch-picker-fixture/<listed|long|truncated>`: a short
 *   list with the default branch selected, forty long branch names, or a list
 *   the provider cut short (the truncation note shows).
 * - `kiloapp:///dev/mode-picker-fixture/<builtin|custom>`: the built-in modes,
 *   or the built-in modes plus a profile's custom agents with long copy.
 * - `kiloapp:///dev/repo-picker-fixture/<listed|empty|long>`: recents and two
 *   providers, no repository at all, or many long names in every provider.
 * - `kiloapp:///dev/folder-picker-fixture?connection=<id>&project=<name>`: the
 *   folder sheet lists the live directories of that CLI connection, as the
 *   composer opens it. A connection that is not live shows the sheet's own
 *   failure state.
 */
const FIXTURE_PATH =
  /(?:^|\/)dev\/(branch|mode|repo|folder)-picker-fixture(?:\/([a-z]+))?\/?(?:\?([^#]*))?(?:#.*)?$/;

const BRANCH_STATES = ['listed', 'long', 'truncated'] as const;
const MODE_STATES = ['builtin', 'custom'] as const;
const REPO_STATES = ['listed', 'empty', 'long'] as const;

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return values.some(candidate => candidate === value);
}

function longBranchNames(): string[] {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `feature/${String(index + 1).padStart(2, '0')}-mobile-design-gate-long-branch-name`
  );
}

function openBranchPicker(state: (typeof BRANCH_STATES)[number]): string {
  const branches =
    state === 'long' ? ['main', ...longBranchNames()] : ['main', 'develop', 'release/2026-11'];
  branchPickerSlot.set(UNFENCED_ROUTE_KEY, {
    branches,
    defaultBranch: 'main',
    selectedBranch: 'main',
    truncated: state === 'truncated',
    onSelect: () => undefined,
  });
  return '/(app)/agent-chat/branch-picker';
}

const CUSTOM_MODES: ModeOption[] = [
  {
    value: 'release-reviewer',
    label: 'Release reviewer',
    description:
      'Reads the release branch, compares it with the last tag, and writes a short list of risks for the release owner before the store submission.',
  },
  {
    value: 'docs-writer',
    label: 'Documentation writer with a long name that wraps',
    description: '',
  },
];

function openModePicker(state: (typeof MODE_STATES)[number]): string {
  modePickerSlot.set(UNFENCED_ROUTE_KEY, {
    currentValue: 'code',
    onSelect: () => undefined,
    customOptions: state === 'custom' ? CUSTOM_MODES : undefined,
  });
  return '/(app)/agent-chat/mode-picker';
}

function githubRepo(fullName: string, isPrivate = false): RepoOption {
  return { platform: 'github', fullName, isPrivate };
}

function gitlabRepo(fullName: string, isPrivate = false): RepoOption {
  return { platform: 'gitlab', fullName, isPrivate };
}

function repoSections(state: (typeof REPO_STATES)[number]): RepoPickerSection[] {
  if (state === 'empty') {
    return [];
  }
  const count = state === 'long' ? 20 : 3;
  const github = Array.from({ length: count }, (_, index) =>
    githubRepo(
      state === 'long'
        ? `kilo-org-with-a-long-name/repository-${index + 1}-with-a-very-long-name`
        : `kilo-org/repo-${index + 1}`,
      index % 2 === 1
    )
  );
  const gitlab = Array.from({ length: count }, (_, index) =>
    gitlabRepo(
      state === 'long'
        ? `group/subgroup/project-${index + 1}-with-a-very-long-name`
        : `group/project-${index + 1}`,
      index % 2 === 0
    )
  );
  const recents = [...github.slice(0, 1), ...gitlab.slice(0, 1)];
  return [
    { key: 'recents', titleKey: 'agentChat.newSession.recentlyUsed', repos: recents },
    { key: 'github', titleKey: 'common.github', repos: github },
    { key: 'gitlab', titleKey: 'common.gitlab', repos: gitlab },
  ];
}

function openRepoPicker(state: (typeof REPO_STATES)[number]): string {
  const sections = repoSections(state);
  repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
    repositories: sections.filter(section => section.key !== 'recents').flatMap(s => s.repos),
    sections,
    organizationId: null,
    currentValue: sections[0]?.repos[0]?.fullName ?? '',
    onSelect: () => undefined,
  });
  return '/(app)/agent-chat/repo-picker';
}

function openFolderPicker(query: URLSearchParams): string {
  folderPickerSlot.set(UNFENCED_ROUTE_KEY, {
    connectionId: query.get('connection') ?? 'fixture-missing-connection',
    projectName: query.get('project') ?? 'fixture-project',
    currentPath: '',
    onSelect: () => undefined,
  });
  return '/(app)/agent-chat/folder-picker';
}

export function agentChatPickerFixtureRoute(path: string): string | null {
  const match = FIXTURE_PATH.exec(path);
  if (!match) {
    return null;
  }
  const [, picker, state = '', query = ''] = match;
  if (picker === 'folder') {
    return state === '' ? openFolderPicker(new URLSearchParams(query)) : null;
  }
  if (picker === 'branch') {
    return isOneOf(BRANCH_STATES, state) ? openBranchPicker(state) : null;
  }
  if (picker === 'mode') {
    return isOneOf(MODE_STATES, state) ? openModePicker(state) : null;
  }
  return isOneOf(REPO_STATES, state) ? openRepoPicker(state) : null;
}
