import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { useNewSessionPrefillTargets } from '@/components/agents/use-new-session-prefill';
import { act, TestRenderer } from '@/test/renderer';

type Harness = {
  params: Record<string, string>;
  repositories: { platform: string; fullName: string }[];
  reposSettled: boolean;
  providerQueriesResolved: boolean;
  toastInfo: Mock;
};

const harness = vi.hoisted(
  (): Harness => ({
    params: {},
    repositories: [],
    reposSettled: false,
    providerQueriesResolved: false,
    toastInfo: vi.fn(),
  })
);

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => harness.params,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
}));

vi.mock('sonner-native', () => ({
  toast: { info: harness.toastInfo, error: vi.fn() },
}));

const repositories = [
  { platform: 'gitlab', fullName: 'Saved/Repository' },
  { platform: 'github', fullName: 'Saved/Repository' },
];

function Consumer() {
  const { selectedRepo, repoSeedPending } = useNewSessionPrefillTargets({
    repositories: harness.repositories,
    reposSettled: harness.reposSettled,
    providerQueriesResolved: harness.providerQueriesResolved,
    models: [],
    modelsSettled: true,
  });
  return (
    <View>
      <Text accessibilityLabel="Selected repository">{selectedRepo}</Text>
      <Text accessibilityLabel="Seed pending">{repoSeedPending ? 'pending' : 'settled'}</Text>
    </View>
  );
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let queryClient = new QueryClient();

function render() {
  const element = (
    <QueryClientProvider client={queryClient}>
      <Consumer />
    </QueryClientProvider>
  );
  if (renderer) {
    renderer.update(element);
    return;
  }
  renderer = TestRenderer.create(element);
}

function labelText(label: string) {
  if (!renderer) {
    throw new Error('The new-session form is not mounted');
  }
  return renderer.root.find(
    node => (node.type as string) === 'Text' && node.props.accessibilityLabel === label
  ).props.children;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  renderer = undefined;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.params = {};
  harness.repositories = [];
  harness.reposSettled = false;
  harness.providerQueriesResolved = false;
  harness.toastInfo.mockClear();
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('new-session prefill repository targets', () => {
  it('seeds the prefilled repository in the render the lists settle', () => {
    harness.params = { prefillRepo: 'Saved/Repository' };
    harness.repositories = repositories;
    act(() => {
      render();
    });
    expect(labelText('Selected repository')).toBe('');

    harness.reposSettled = true;
    harness.providerQueriesResolved = true;
    act(() => {
      render();
    });

    expect(labelText('Selected repository')).toBe('github:Saved/Repository');
    expect(labelText('Seed pending')).toBe('settled');
  });

  it('gives the prefill up when the bound settles the region first', () => {
    harness.params = { prefillRepo: 'Saved/Repository' };
    act(() => {
      render();
    });
    expect(labelText('Selected repository')).toBe('');
    expect(labelText('Seed pending')).toBe('pending');

    harness.providerQueriesResolved = true;
    act(() => {
      render();
    });
    expect(labelText('Selected repository')).toBe('');
    expect(labelText('Seed pending')).toBe('settled');

    harness.repositories = repositories;
    harness.reposSettled = true;
    act(() => {
      render();
    });

    expect(labelText('Selected repository')).toBe('');
    expect(labelText('Seed pending')).toBe('settled');
  });

  it('reports a pending seed while the bound has not expired', () => {
    harness.params = { prefillRepo: 'Saved/Repository' };
    harness.repositories = repositories;
    act(() => {
      render();
    });

    expect(labelText('Selected repository')).toBe('');
    expect(labelText('Seed pending')).toBe('pending');
  });
});
