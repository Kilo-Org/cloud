/* eslint-disable typescript-eslint/no-deprecated -- native selection is mounted with the DOM-free renderer */
import { createElement, Fragment, type ReactNode, useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import { type RepoPickerBridge } from '@/lib/picker-bridge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import RepoPickerScreen from '@/app/(app)/agent-chat/repo-picker';
import { NewSessionRepositorySection } from './new-session-repository-section';
import { normalizeSessionRepository, type RepositoryGroup } from './new-session-repository-state';

const native = vi.hoisted(() => ({
  bridge: undefined as RepoPickerBridge | undefined,
  setOpen: undefined as ((open: boolean) => void) | undefined,
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
  FlatList: ({
    data,
    renderItem,
  }: {
    data: { key: string }[];
    renderItem: (input: { item: { key: string } }) => ReactNode;
  }) => data.map(item => createElement(Fragment, { key: item.key }, renderItem({ item }))),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'icon',
  ExternalLink: 'icon',
  RefreshCw: 'icon',
  Check: 'icon',
  Info: 'icon',
  Lock: 'icon',
  Search: 'icon',
  SearchX: 'icon',
  Unlock: 'icon',
}));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: ({ message }: { message: string | null }) => createElement('Text', {}, message),
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: { title: string; message: string; onRetry?: () => void }) => (
    <>
      <Text>
        {props.title}
        {props.message}
      </Text>
      {props.onRetry ? (
        <Button onPress={props.onRetry}>
          <Text>retry</Text>
        </Button>
      ) : null}
    </>
  ),
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: ({ children }: { children: ReactNode }): ReactNode => children,
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: vi.fn() }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.test' }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { provider?: string; label?: string }) =>
      [key, params?.provider, params?.label].filter(Boolean).join(' '),
  }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/lib/trpc', () => ({ useTRPC: vi.fn() }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => {
    useEffect(effect, [effect]);
  },
  useRouter: () => ({
    push: () => {
      native.setOpen?.(true);
    },
    back: () => {
      native.setOpen?.(false);
    },
  }),
}));
vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: '',
  useRouteRegistry: vi.fn(),
  repoPickerSlot: {
    get: () => native.bridge,
    set: (_key: string, bridge: RepoPickerBridge) => {
      native.bridge = bridge;
    },
    clear: () => {
      native.bridge = undefined;
    },
  },
}));

function repo(integrationId: string, owner = 'org-1') {
  const reference: LaunchRepositoryReference = {
    repository: {
      provider: 'gitlab',
      instanceUrl: `https://${integrationId}.example.com/base`,
      repositoryId: '7',
      fullName: 'group/nested/repo',
      defaultBranch: 'develop',
    },
    authorization: { kind: 'ownerIntegration', owner: { type: 'org', id: owner }, integrationId },
  };
  const result = normalizeSessionRepository(
    { private: true, repositoryReference: reference },
    'user-1',
    owner
  );
  assert(result, 'Invalid fixture');
  return result;
}
const rows = [repo('integration-1'), repo('integration-2')];
function Harness({
  groups,
  repositories = rows,
}: {
  groups: RepositoryGroup[];
  repositories?: typeof rows;
}) {
  const [value, setValue] = useState('');
  const [isOpen, setOpen] = useState(false);
  const [recovery, setRecovery] = useState('');
  native.setOpen = setOpen;
  return (
    <>
      <NewSessionRepositorySection
        disabled={false}
        isRetrying={false}
        onChange={setValue}
        onConnect={setRecovery}
        onRefreshRepos={() => {
          setRecovery('refresh');
        }}
        repositories={repositories}
        recents={repositories.slice(0, 1)}
        groups={groups}
        value={value}
      />
      {isOpen ? <RepoPickerScreen /> : null}
      {createElement('output', { value, recovery })}
    </>
  );
}
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
async function render(groups: RepositoryGroup[], repositories = rows) {
  await act(() => {
    const tree = <Harness groups={groups} repositories={repositories} />;
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
  });
}
function output() {
  return renderer?.root.findByType('output').props as { value: string; recovery: string };
}
function text() {
  return JSON.stringify(renderer?.toJSON());
}
type Control = {
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean };
};
function controls() {
  return renderer?.root.findAllByType(Pressable).map(node => node.props as Control) ?? [];
}
function trigger() {
  return controls().find(props =>
    props.accessibilityLabel?.startsWith('agentChat.repoPicker.accessibility')
  );
}
async function open() {
  await act(() => {
    trigger()?.onPress();
  });
}
async function press(label: string) {
  const button = renderer?.root
    .findAllByType(Button)
    .find(node => node.findAllByType(Text).some(child => child.children.includes(label)));
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  await act(() => {
    (button.props as Control).onPress();
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  native.bridge = undefined;
});
afterEach(async () => {
  await act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

it('keeps loaded rows selectable and labels both picker states with exact identity', async () => {
  await render([
    { key: 'gitlab', status: 'repos', repositories: rows },
    { key: 'github', status: 'loading', repositories: [] },
    { key: 'bitbucket', status: 'loading', repositories: [] },
  ]);
  expect(text()).toContain(
    'agentChat.newSession.loadingRepositories agentChat.repoPicker.platformGithub'
  );
  expect(text()).toContain(
    'agentChat.newSession.loadingRepositories agentChat.repoPicker.platformBitbucket'
  );
  expect(trigger()?.disabled).toBe(false);
  await open();
  expect(native.bridge?.repositories.map(row => row.reference)).toEqual(
    rows.map(row => row.reference)
  );
  const options = controls().filter(props =>
    props.accessibilityLabel?.includes('group/nested/repo')
  );
  expect(options).toHaveLength(2);
  expect(options[1]?.accessibilityLabel).toContain('org:org-1');
  await act(() => {
    options[1]?.onPress();
  });
  expect(output().value).toBe(rows[1]?.key);
  expect(trigger()?.accessibilityLabel).toContain('integration-2.example.com/base');
  await open();
  const selected = controls().filter(props => props.accessibilityState?.selected);
  expect(selected).toHaveLength(1);
  expect(selected[0]?.accessibilityLabel).toContain('integration-2.example.com/base');
});

it.each([
  ['error', 'couldNotLoadGithubRepositories', 'refresh'],
  ['identity-unavailable', 'repositoryIdentityUnavailable', 'refresh'],
  ['access-denied', 'repositoryAccessDenied', 'github'],
  ['connected-empty', 'noRepositoriesVisible', 'github'],
  ['connect', 'connectGithubDescription', 'github'],
] as const)(
  'keeps loaded rows available beside %s and exposes its recovery',
  async (status, message, recovery) => {
    await render([
      { key: 'github', status, repositories: [] },
      { key: 'bitbucket', status: 'repos', repositories: [] },
    ]);
    expect(trigger()?.disabled).toBe(false);
    expect(text()).toContain(message);
    if (status === 'access-denied') {
      expect(text()).not.toContain('refreshRepositories');
    }
    await press(recovery === 'refresh' ? 'retry' : 'agentChat.newSession.openGithub');
    expect(output().recovery).toBe(recovery);
  }
);

it('rejects a stale picker callback after the owner changes without choosing a same-name repository', async () => {
  const groups: RepositoryGroup[] = [{ key: 'bitbucket', status: 'repos', repositories: [] }];
  await render(groups);
  await open();
  const previous = native.bridge;
  await render(groups, [repo('integration-1', 'org-2')]);
  await act(() => {
    previous?.onSelect(rows[0].key);
  });
  expect(output().value).toBe('');
});

it('keeps first-use empty selection normal and explains a removed selection', async () => {
  const groups: RepositoryGroup[] = [
    { key: 'gitlab', status: 'connected-empty', repositories: [] },
    { key: 'bitbucket', status: 'repos', repositories: [] },
  ];
  await render(groups, []);
  expect(text()).toContain('noRepositoriesVisibleGitlab');
  expect(text()).not.toContain('repositoryUnavailable');
  expect(trigger()).toBeUndefined();
  await render(groups);
  await open();
  await act(() => {
    native.bridge?.onSelect(rows[0].key);
  });
  await render(groups, []);
  expect(text()).toContain('repositoryUnavailable');
});
