/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the existing DOM-free hook harness. */
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { normalizeSessionRepository } from './new-session-repository-state';
import {
  useNewSessionPrefillTargets,
  type UseNewSessionPrefillTargetsInput,
} from './use-new-session-prefill';

const mocks = vi.hoisted(() => {
  const params: { prefillRepo?: string; prefillModel?: string } = {};
  return { params, notes: [] as string[] };
});
vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.params }));
vi.mock('sonner-native', () => ({
  toast: { info: (message: string) => mocks.notes.push(message) },
}));
vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));

let renderer: ReactTestRenderer | undefined = undefined;
let latest: ReturnType<typeof useNewSessionPrefillTargets> | undefined = undefined;
function result() {
  assert(latest, 'Prefill hook did not render');
  return latest;
}
function Harness(props: UseNewSessionPrefillTargetsInput) {
  latest = useNewSessionPrefillTargets(props);
  return null;
}
function mountPrefill(input: UseNewSessionPrefillTargetsInput) {
  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness, input));
  });
}
function updatePrefill(input: UseNewSessionPrefillTargetsInput) {
  act(() => renderer?.update(React.createElement(Harness, input)));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.params = {};
  mocks.notes.length = 0;
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([
  { provider: 'github', repo: 'owner/repo' },
  { provider: 'gitlab', repo: 'https://gitlab.com/owner/repo.git' },
] as const)(
  'announces the unavailable model once while legacy $provider prefill stays unresolved',
  ({ provider, repo }) => {
    mocks.params = { prefillRepo: repo, prefillModel: 'unavailable/model' };
    const repository = normalizeSessionRepository(
      {
        private: true,
        repositoryReference: {
          repository: {
            provider,
            instanceUrl: `https://${provider}.com`,
            repositoryId: '7',
            fullName: 'owner/repo',
            defaultBranch: 'main',
          },
          authorization: {
            kind: 'ownerIntegration',
            owner: { type: 'org', id: 'org-1' },
            integrationId: 'integration-1',
          },
        },
      },
      'user-1',
      'org-1'
    );
    assert(repository, 'Authorized repository fixture is missing');
    const input: UseNewSessionPrefillTargetsInput = {
      repositories: [repository],
      reposSettled: true,
      models: [],
      modelsSettled: false,
    };
    mountPrefill(input);
    expect(result().selectedRepo).toBe('');
    expect(mocks.notes).toEqual([]);

    // A loading or failed model request cannot yet prove that the model is missing.
    const models = [{ id: 'available/model', variants: [] }];
    updatePrefill({ ...input, models });
    expect(mocks.notes).toEqual([]);
    updatePrefill({ ...input, models, modelsSettled: true });
    const expectedNotice = i18n.t('agentChat.newSession.prefillModelUnavailable', {
      model: 'unavailable/model',
    });
    expect(mocks.notes).toEqual([expectedNotice]);
    expect(result().selectedRepo).toBe('');

    act(() => {
      result().setSelectedRepo(repository.key);
    });
    updatePrefill({ ...input, models: [...models], modelsSettled: true });
    expect(result().selectedRepo).toBe(repository.key);
    expect(mocks.notes).toEqual([expectedNotice]);
  }
);

it.each(['available/model', undefined])(
  'keeps unresolved repository prefill silent when requested model is %s',
  prefillModel => {
    mocks.params = { prefillRepo: 'owner/repo', prefillModel };
    mountPrefill({
      repositories: [],
      reposSettled: true,
      models: [{ id: 'available/model', variants: [] }],
      modelsSettled: true,
    });
    expect(result().selectedRepo).toBe('');
    expect(mocks.notes).toEqual([]);
  }
);

it('keeps empty prefill silent while discovery is empty', () => {
  mountPrefill({ repositories: [], reposSettled: true, models: [], modelsSettled: false });
  expect(result().selectedRepo).toBe('');
  expect(mocks.notes).toEqual([]);
});
