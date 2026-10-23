import {
  getHandoff,
  loadTargets,
  savedList,
  todo,
} from './todo-start-prefill.mounted.test-helpers';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NewSessionModelProvider,
  useNewSessionModelState,
} from '@/components/agents/new-session-model-provider';
import {
  useNewSessionPrefill,
  useNewSessionPrefillTargets,
} from '@/components/agents/use-new-session-prefill';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { act, TestRenderer } from '@/test/renderer';

import '@/i18n';

import { TodoListScreen } from './todo-list-screen';

const handoff = getHandoff();

function NewSessionConsumer() {
  const { organizationId } = useLocalSearchParams<{ organizationId?: string }>();
  const prefill = useNewSessionPrefill();
  const { mode, setMode, model, setModel, variant, setVariant } = useNewSessionModelState();
  const { models } = useAvailableModels(organizationId);
  const usualSelection = useAutoSelectModel(models, organizationId);
  const { selectedRepo, setSelectedRepo } = useNewSessionPrefillTargets({
    repositories: handoff.repositories,
    reposSettled: handoff.reposSettled,
    models,
    modelsSettled: models.length > 0,
  });
  const [prompt, setPrompt] = useState<string | null>(() => prefill.prompt ?? null);
  return (
    <View>
      <TextInput
        accessibilityLabel="Repository"
        value={selectedRepo}
        onChangeText={setSelectedRepo}
      />
      <TextInput accessibilityLabel="Mode" value={mode} onChangeText={setMode} />
      <TextInput accessibilityLabel="Model" value={model} onChangeText={setModel} />
      <TextInput accessibilityLabel="Variant" value={variant} onChangeText={setVariant} />
      <TextInput accessibilityLabel="Prompt" value={prompt ?? ''} onChangeText={setPrompt} />
      <Text accessibilityLabel="Linked to-do">{prefill.todoId}</Text>
      <Text accessibilityLabel="Session title">{prefill.todoTitle}</Text>
      <Text accessibilityLabel="Organization">{organizationId ?? 'personal'}</Text>
      <Text accessibilityLabel="Usual model">{usualSelection.model}</Text>
    </View>
  );
}

function NewSessionEntry() {
  const { organizationId } = useLocalSearchParams<{ organizationId?: string }>();
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionConsumer />
    </NewSessionModelProvider>
  );
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let queryClient = new QueryClient();

type FieldProps = {
  value: string;
  onChangeText: (text: string) => void;
};

function root() {
  if (!renderer) {
    throw new Error('The handoff screen is not mounted');
  }
  return renderer.root;
}

function field(label: string): FieldProps {
  return root().find(
    node => (node.type as string) === 'TextInput' && node.props.accessibilityLabel === label
  ).props as FieldProps;
}

function labelText(label: string) {
  return root().find(
    node => (node.type as string) === 'Text' && node.props.accessibilityLabel === label
  ).props.children;
}

function pressRowStart() {
  const start = root().find(
    node =>
      (node.type as string) === 'SortableTouchable' &&
      node.props.accessibilityLabel === 'Start session'
  ) as unknown as { props: { onTap: () => void } };
  start.props.onTap();
}

function renderEntry() {
  if (!renderer) {
    throw new Error('The handoff screen is not mounted');
  }
  renderer.update(
    <QueryClientProvider client={queryClient}>
      <NewSessionEntry />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  renderer = undefined;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  handoff.params = {};
  handoff.models = [];
  handoff.repositories = [];
  handoff.reposSettled = false;
  handoff.toastInfo.mockClear();
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  queryClient.clear();
  vi.unstubAllGlobals();
});

const cases = [
  { scope: 'personal', organizationId: null, first: 'repositories' },
  { scope: 'personal', organizationId: null, first: 'catalog' },
  {
    scope: 'organization',
    organizationId: '33333333-3333-4333-8333-333333333333',
    first: 'repositories',
  },
  {
    scope: 'organization',
    organizationId: '33333333-3333-4333-8333-333333333333',
    first: 'catalog',
  },
] as const;

function verifyHandoff(case_: {
  organizationId: string | null;
  first: 'repositories' | 'catalog';
}) {
  const { organizationId, first } = case_;
  handoff.organizationId = organizationId;
  handoff.lists = [{ ...savedList, organizationId }];
  handoff.items = [todo];
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <TodoListScreen listId={savedList.id} />
      </QueryClientProvider>
    );
  });

  act(() => {
    pressRowStart();
    renderEntry();
  });

  expect(field('Repository').value).toBe('');
  expect(field('Model').value).toBe('');
  expect(field('Mode').value).toBe('plan');
  expect(field('Prompt').value).toBe(
    'Review search & filters\n\nKeep the query when returning.\nCover empty results.'
  );
  expect(labelText('Linked to-do')).toBe(todo.id);
  expect(labelText('Session title')).toBe(todo.title);
  expect(labelText('Organization')).toBe(organizationId ?? 'personal');

  loadTargets();
  const models = handoff.models;
  const repositories = handoff.repositories;
  if (first === 'repositories') {
    handoff.models = [];
  } else {
    handoff.repositories = [];
    handoff.reposSettled = false;
  }
  act(() => {
    renderEntry();
  });
  expect(field('Repository').value).toBe(first === 'repositories' ? 'github:Saved/Repository' : '');
  expect(field('Model').value).toBe(first === 'catalog' ? savedList.model : '');

  handoff.models = models;
  handoff.repositories = repositories;
  handoff.reposSettled = true;
  act(() => {
    renderEntry();
  });

  expect(labelText('Usual model')).toBe('provider/usual-model');
  expect(field('Repository').value).toBe('github:Saved/Repository');
  expect(field('Mode').value).toBe(savedList.mode);
  expect(field('Model').value).toBe(savedList.model);
  expect(field('Variant').value).toBe(savedList.variant);
  expect(handoff.toastInfo).not.toHaveBeenCalled();

  act(() => {
    field('Repository').onChangeText('github:Other/Repository');
    field('Mode').onChangeText('debug');
    field('Model').onChangeText('provider/usual-model');
    field('Variant').onChangeText('low');
    field('Prompt').onChangeText('A revised prompt');
  });
  loadTargets();
  act(() => {
    renderEntry();
  });

  expect(field('Repository').value).toBe('github:Other/Repository');
  expect(field('Mode').value).toBe('debug');
  expect(field('Model').value).toBe('provider/usual-model');
  expect(field('Variant').value).toBe('low');
  expect(field('Prompt').value).toBe('A revised prompt');
  expect(labelText('Linked to-do')).toBe(todo.id);
  expect(labelText('Session title')).toBe(todo.title);
}

describe('to-do row Start to new-session form', () => {
  it.each(cases)(
    'restores $scope list defaults with delayed $first first, without overwriting edits',
    verifyHandoff
  );
});
