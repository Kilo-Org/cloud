import { createElement, type ElementType, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import NewSessionScreen from '@/app/(app)/agent-chat/new';

const state = vi.hoisted(() => ({
  organization: { organizationId: undefined as string | undefined, isResolved: true },
}));
vi.mock('@/components/agents/use-new-session-organization', () => ({
  useNewSessionOrganization: () => ({ ...state.organization, isCloneEntry: false }),
}));
vi.mock('@/components/agents/new-session-screen-body', () => ({
  NewSessionScreenBody: 'Body',
}));
vi.mock('@/components/agents/new-session-model-provider', () => ({
  NewSessionModelProvider: (props: { organizationId?: string; children?: ReactNode }) =>
    createElement('ModelProvider', { organizationId: props.organizationId }, props.children),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({ View: 'View' }));

const ModelProvider = 'ModelProvider' as ElementType;
const Body = 'Body' as ElementType;
const Loading = 'ActivityIndicator' as ElementType;

async function render() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(NewSessionScreen));
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('renderer did not mount');
  }
  return ref.current;
}

function unmount(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

beforeEach(() => {
  state.organization = { organizationId: undefined, isResolved: true };
});

describe('NewSessionScreen account gate', () => {
  it('mounts nothing account-scoped until the account resolves', async () => {
    state.organization = { organizationId: undefined, isResolved: false };
    const renderer = await render();
    // A form mounted here would read as Personal until the account settles,
    // and its model selection would stay on that first list.
    expect(renderer.root.findAllByType(ModelProvider)).toHaveLength(0);
    expect(renderer.root.findAllByType(Loading)).toHaveLength(1);
    unmount(renderer);
  });

  it('mounts the form with the resolved organization', async () => {
    state.organization = { organizationId: 'org-a', isResolved: true };
    const renderer = await render();
    expect(renderer.root.findByType(ModelProvider).props.organizationId).toBe('org-a');
    expect(renderer.root.findAllByType(Body)).toHaveLength(1);
    unmount(renderer);
  });

  it('mounts a personal form with no organization', async () => {
    const renderer = await render();
    expect(renderer.root.findByType(ModelProvider).props.organizationId).toBeUndefined();
    unmount(renderer);
  });
});
