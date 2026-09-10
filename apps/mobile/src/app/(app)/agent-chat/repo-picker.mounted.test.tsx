/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { act, createElement, type EffectCallback, type ReactNode, useEffect } from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import RepoPickerScreen from './repo-picker';
import { i18n } from '@/i18n';
import {
  REPO_PLATFORM_LABEL_KEYS,
  type RepoOption,
  type RepoPickerSection,
} from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { renderWithProviders } from '@/test/render-with-providers';

// The Bitbucket note is keyed on the SCOPE, not on the rendered sections: it
// explains the personal-context gap ("personal Bitbucket never lists
// repositories") and would read as wrong copy inside an organization, where
// Bitbucket IS available. The scope rides through this mock.
const orgState = vi.hoisted(() => ({ organizationId: null as string | null }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: orgState.organizationId }),
}));

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: EffectCallback) => {
    useEffect(effect, [effect]);
  },
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: ({ children, headerContent }: { children?: ReactNode; headerContent?: ReactNode }) =>
    createElement('PickerSheet', {}, headerContent, children),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  Info: 'Info',
  Lock: 'Lock',
  Search: 'Search',
  SearchX: 'SearchX',
  Unlock: 'Unlock',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));

const githubRepo: RepoOption = { platform: 'github', fullName: 'org/repo', isPrivate: false };
const bitbucketRepo: RepoOption = {
  platform: 'bitbucket',
  fullName: 'team/api',
  isPrivate: false,
};

function setBridge(
  sections: { key: Exclude<RepoPickerSection['key'], 'recents'>; repos: RepoOption[] }[]
) {
  repoPickerSlot.set(UNFENCED_ROUTE_KEY, {
    repositories: sections.flatMap(section => section.repos),
    sections: sections.map(section => ({
      key: section.key,
      titleKey: REPO_PLATFORM_LABEL_KEYS[section.key],
      repos: section.repos,
    })),
    currentValue: '',
    onSelect: vi.fn<() => void>(),
  });
}

type MountedRenderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

async function mountPicker(): Promise<MountedRenderer> {
  const mounted = await renderWithProviders(createElement(RepoPickerScreen));
  onTestFinished(mounted.unmount);
  return mounted.renderer;
}

function texts(renderer: MountedRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

const orgOnlyCopy = i18n.t('agentChat.newSession.bitbucketOrganizationsOnly');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  orgState.organizationId = null;
});

describe('repo picker Bitbucket org-only note', () => {
  it('explains the missing Bitbucket group in personal scope', async () => {
    // Personal Bitbucket can never list repositories, so the grouped list
    // would end at GitLab with nothing explaining the gap.
    setBridge([{ key: 'github', repos: [githubRepo] }]);

    const renderer = await mountPicker();

    expect(texts(renderer)).toContain(orgOnlyCopy);
    expect(texts(renderer)).toContain('org/repo');
  });

  it('stays silent in an organization context without Bitbucket repositories', async () => {
    // In an organization the copy would be wrong — Bitbucket is available
    // there — and the form's connect card already covers the unconnected
    // case, so the note must not render.
    setBridge([{ key: 'github', repos: [githubRepo] }]);
    orgState.organizationId = 'org-1';

    const renderer = await mountPicker();

    expect(texts(renderer)).not.toContain(orgOnlyCopy);
  });

  it('stays silent when the connected org lists Bitbucket repositories', async () => {
    setBridge([
      { key: 'github', repos: [githubRepo] },
      { key: 'bitbucket', repos: [bitbucketRepo] },
    ]);
    orgState.organizationId = 'org-1';

    const renderer = await mountPicker();

    expect(texts(renderer)).not.toContain(orgOnlyCopy);
    // The Bitbucket rows render as usual.
    expect(texts(renderer)).toContain('team/api');
  });

  it('hides the note while searching', async () => {
    setBridge([{ key: 'github', repos: [githubRepo] }]);

    const renderer = await mountPicker();
    const input = renderer.root.findAll(
      node =>
        // TextInput is mocked to the string host 'TextInput'.
        String(node.type) === 'TextInput' && typeof node.props.onChangeText === 'function'
    )[0];
    if (input === undefined) {
      throw new Error('the search input did not render');
    }
    act(() => {
      (input.props.onChangeText as (text: string) => void)('org');
    });

    expect(texts(renderer)).not.toContain(orgOnlyCopy);
    expect(texts(renderer)).toContain('org/repo');
  });
});
