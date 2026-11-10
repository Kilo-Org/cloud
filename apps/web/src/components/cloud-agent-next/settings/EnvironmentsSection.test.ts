/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- @swc/jest does not hoist `jest.mock` above imports, so mocked modules are required after the mocks register. */
import { act } from 'react';
import * as React from 'react';
import type { ReactNode } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { EnvironmentResponse, EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import type * as EnvironmentHooks from '@/hooks/useCloudAgentEnvironments';
import type { EnvironmentRepositoryChoice } from '@/hooks/useEnvironmentRepositoryChoices';
import type { EnvironmentBuildStatus } from '../environment-build-display';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

Object.assign(globalThis, { React });

const createdAt = '2026-01-01T00:00:00.000Z';
let nextCreatedId = 'env-created';
let mockEnvironments: EnvironmentSummary[] = [];
let mockDetails: Record<string, EnvironmentResponse | undefined> = {};
let mockRepoChoices: EnvironmentRepositoryChoice[] = [];
let mockDetailErrorId: string | null = null;
let mockListHasData = true;
let mockListLoading = false;
let mockListError = false;
let mockListOptions: { organizationId?: string; enabled?: boolean } | null = null;
let mockBuildStatusOptions: Record<string, { organizationId?: string; enabled?: boolean }> = {};
let mockBuildStatuses: Record<string, EnvironmentBuildStatus | undefined> = {};

const mockRefetchList = jest.fn(async () => undefined);
const mockRefetchDetail = jest.fn(async () => undefined);
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
const mockConfirm = jest.fn<() => boolean>();

type CreateInput = {
  name: string;
  repositories: Array<
    | { platform: 'github'; fullName: string }
    | { platform: 'gitlab'; projectPath: string }
    | {
        platform: 'bitbucket';
        fullName: string;
        workspaceUuid: string;
        repositoryUuid: string;
      }
  >;
};

const mockCreate = jest.fn<(input: CreateInput) => Promise<{ id: string }>>(async input => {
  const id = nextCreatedId;
  const first = input.repositories[0];
  if (!first) throw new Error('Create requires a repository');
  const repoFullName = first.platform === 'gitlab' ? first.projectPath : first.fullName;
  const summary = makeEnvironmentSummary(id, input.name, repoFullName);
  mockEnvironments = [...mockEnvironments, summary];
  mockDetails[id] = makeEnvironmentDetail(id, input.name, repoFullName);
  return { id };
});

const mockUpdate = jest.fn<(input: Record<string, unknown>) => Promise<void>>(async input => {
  const environmentId = typeof input.environmentId === 'string' ? input.environmentId : null;
  const name = typeof input.name === 'string' ? input.name : null;
  if (!environmentId || !name) return;
  const existing = mockDetails[environmentId];
  if (!existing) return;
  mockDetails[environmentId] = { ...existing, name };
  mockEnvironments = mockEnvironments.map(environment =>
    environment.id === environmentId ? { ...environment, name } : environment
  );
});
const mockDelete = jest.fn<(input: { environmentId: string }) => Promise<void>>(
  async ({ environmentId }) => {
    mockEnvironments = mockEnvironments.filter(environment => environment.id !== environmentId);
    delete mockDetails[environmentId];
  }
);

jest.mock('@/hooks/useCloudAgentEnvironments', () => {
  const react = jest.requireActual<typeof React>('react');
  const usePendingMutation = <TInput, TResult>(
    mutateAsync: (input: TInput) => Promise<TResult>
  ) => {
    const [isPending, setPending] = react.useState(false);
    const run = async (input: TInput): Promise<TResult> => {
      setPending(true);
      try {
        return await mutateAsync(input);
      } finally {
        setPending(false);
      }
    };
    return { isPending, mutateAsync: run };
  };

  return {
    ...jest.requireActual<typeof EnvironmentHooks>('@/hooks/useCloudAgentEnvironments'),
    useCloudAgentEnvironmentsForOwner: (options: {
      organizationId?: string;
      enabled?: boolean;
    }) => {
      mockListOptions = options;
      return {
        data: mockListHasData ? mockEnvironments : undefined,
        isLoading: mockListLoading,
        isError: mockListError,
        refetch: mockRefetchList,
      };
    },
    useCloudAgentEnvironment: (environmentId: string | null) => ({
      data:
        environmentId && environmentId !== mockDetailErrorId
          ? mockDetails[environmentId]
          : undefined,
      isLoading: false,
      isError: environmentId !== null && environmentId === mockDetailErrorId,
      refetch: mockRefetchDetail,
    }),
    useCloudAgentEnvironmentMutations: () => ({
      createEnvironment: usePendingMutation(mockCreate),
      updateEnvironment: usePendingMutation(mockUpdate),
      deleteEnvironment: usePendingMutation(mockDelete),
    }),
    useEnvironmentBuildStatus: (
      environmentId: string,
      options: { organizationId?: string; enabled?: boolean }
    ) => {
      mockBuildStatusOptions[environmentId] = options;
      return { data: mockBuildStatuses[environmentId] };
    },
  };
});

jest.mock('@/hooks/useEnvironmentRepositoryChoices', () => ({
  useEnvironmentRepositoryChoices: () => mockRepoChoices,
}));

jest.mock('@/hooks/useEnvironmentProfiles', () => ({
  useEnvironmentProfiles: () => ({
    profiles: [],
    isLoading: false,
    isError: false,
    retry: async () => undefined,
  }),
}));

jest.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

jest.mock('@/components/ui/popover', () => {
  const react = jest.requireActual<typeof React>('react');
  const content = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return { Popover: content, PopoverTrigger: content, PopoverContent: content };
});

jest.mock('@/components/ui/command', () => {
  const react = jest.requireActual<typeof React>('react');
  const content = ({ children }: { children?: ReactNode }) =>
    react.createElement('div', null, children);
  return {
    Command: content,
    CommandEmpty: content,
    CommandGroup: content,
    CommandList: content,
    CommandInput: () => react.createElement('input'),
    CommandItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) =>
      react.createElement('button', { type: 'button', onClick: onSelect }, children),
  };
});

jest.mock('@/lib/trpc/utils', () => {
  const queryOptions = () => ({ queryKey: ['mock'], queryFn: async () => undefined });
  const repositories = {
    listGitHubRepositories: { queryOptions },
    listGitLabRepositories: { queryOptions },
  };
  return {
    useTRPC: () => ({
      cloudAgentNext: repositories,
      organizations: {
        cloudAgentNext: {
          ...repositories,
          listBitbucketRepositories: { queryOptions },
        },
      },
    }),
  };
});

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));

jest.mock('../EnvironmentSandboxField', () => ({ EnvironmentSandboxField: () => null }));

jest.mock('../EnvironmentNetworkField', () => ({ EnvironmentNetworkField: () => null }));

jest.mock('../EnvironmentBuildPanel', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    EnvironmentBuildPanel: () => react.createElement('div', { 'data-testid': 'build-panel' }),
  };
});

jest.mock('../EnvironmentDeleteDialog', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    EnvironmentDeleteDialog: ({
      onDelete,
      disabled,
    }: {
      onDelete: () => Promise<void>;
      disabled: boolean;
    }) =>
      react.createElement(
        'button',
        { type: 'button', disabled, onClick: () => void onDelete() },
        'Delete environment test'
      ),
  };
});

function makeEnvironmentSummary(
  id: string,
  name: string,
  repoFullName: string
): EnvironmentSummary {
  return {
    id,
    name,
    platform: 'github',
    repoFullName,
    gitlabCloneUrl: null,
    bitbucketWorkspaceUuid: null,
    bitbucketRepositoryUuid: null,
    createdAt,
    updatedAt: createdAt,
    plainVarCount: 0,
    secretCount: 0,
    commandCount: 0,
    configurationRevision: 1,
    sandboxAllocation: null,
  };
}

function makeEnvironmentDetail(
  id: string,
  name: string,
  repoFullName: string
): EnvironmentResponse {
  return {
    ...makeEnvironmentSummary(id, name, repoFullName),
    plainVars: [],
    commands: [],
    startCommands: [],
    egressMode: null,
    egressAllowlist: null,
    secretKeys: [],
  };
}

beforeEach(() => {
  mockEnvironments = [
    makeEnvironmentSummary('env-1', 'Kilo Environment', 'Kilo-Org/kilocode'),
    makeEnvironmentSummary('env-2', 'Other Environment', 'Kilo-Org/cloud'),
  ];
  mockDetails = {
    'env-1': makeEnvironmentDetail('env-1', 'Kilo Environment', 'Kilo-Org/kilocode'),
    'env-2': makeEnvironmentDetail('env-2', 'Other Environment', 'Kilo-Org/cloud'),
  };
  mockRepoChoices = [
    {
      platform: 'github',
      label: 'Kilo-Org/new-repo',
      repository: { platform: 'github', fullName: 'Kilo-Org/new-repo' },
    },
  ];
  nextCreatedId = 'env-created';
  mockDetailErrorId = null;
  mockListHasData = true;
  mockListLoading = false;
  mockListError = false;
  mockListOptions = null;
  mockBuildStatusOptions = {};
  mockBuildStatuses = {};
  mockConfirm.mockReset();
  mockConfirm.mockReturnValue(true);
  mockToastSuccess.mockClear();
  mockToastError.mockClear();
  mockCreate.mockClear();
  mockUpdate.mockClear();
  mockDelete.mockClear();
  mockRefetchList.mockClear();
  mockRefetchDetail.mockClear();
});

type LinkedomModule = {
  parseHTML: (
    html: string,
    options: {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
      location: URL;
    }
  ) => {
    window: typeof globalThis & {
      HTMLElement: typeof HTMLElement;
      HTMLInputElement: typeof HTMLInputElement;
      HTMLButtonElement: typeof HTMLButtonElement;
      Element: typeof Element;
      Node: typeof Node;
      Text: typeof Text;
      Comment: typeof Comment;
      DocumentFragment: typeof DocumentFragment;
      Document: typeof Document;
      SVGElement: typeof SVGElement;
      Event: typeof Event;
      CustomEvent: typeof CustomEvent;
      navigator: Navigator;
    };
    document: Document;
  };
};

const requireFromHere = createRequire(__filename);

function loadLinkedom(): LinkedomModule {
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  return requireFromNext('linkedom') as LinkedomModule;
}

function installLinkedomDom(): { cleanup: () => void; container: HTMLElement } {
  const { parseHTML } = loadLinkedom();
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { setTimeout, clearTimeout, location: new URL('http://localhost/') }
  );
  document.oninput = null;
  Object.assign(window, { confirm: mockConfirm });

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Text: globalThis.Text,
    Comment: globalThis.Comment,
    DocumentFragment: globalThis.DocumentFragment,
    Document: globalThis.Document,
    SVGElement: globalThis.SVGElement,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    navigator: globalThis.navigator,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: (() => ({ animationName: 'none' })) as unknown as typeof getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');

  return {
    container: container as unknown as HTMLElement,
    cleanup: () => {
      Object.assign(globalThis, previous);
    },
  };
}

const bootstrapDom = installLinkedomDom();
const { EnvironmentsSection } = require('./EnvironmentsSection') as {
  EnvironmentsSection: React.ComponentType<{
    organizationId?: string;
    canManage: boolean;
    active?: boolean;
  }>;
};
bootstrapDom.cleanup();

function mount(element: React.ReactElement): {
  container: HTMLElement;
  rerender: (element: React.ReactElement) => void;
  cleanup: () => void;
} {
  const dom = installLinkedomDom();
  const { createRoot } = require('react-dom/client') as { createRoot: typeof createReactRoot };
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(element);
  });

  return {
    container: dom.container,
    rerender: (nextElement: React.ReactElement) => {
      act(() => {
        root.render(nextElement);
      });
    },
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    },
  };
}

function findButton(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(button =>
    button.textContent?.includes(text)
  ) as HTMLButtonElement | undefined;
}

function selectedLabel(container: ParentNode): string | null {
  return container.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label') ?? null;
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('element not found');
  act(() => {
    (element as HTMLElement).click();
  });
}

async function clickAndFlush(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('element not found');
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
}

function clickButton(container: ParentNode, text: string): void {
  const button = findButton(container, text);
  if (!button) throw new Error(`button not found: ${text}`);
  click(button);
}

async function clickButtonAndFlush(container: ParentNode, text: string): Promise<void> {
  const button = findButton(container, text);
  if (!button) throw new Error(`button not found: ${text}`);
  await clickAndFlush(button);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Input value setter not found');
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function activateTab(container: ParentNode, text: string): Promise<void> {
  const button = findButton(container, text);
  if (!button) throw new Error(`tab not found: ${text}`);
  await act(async () => {
    const event = new Event('keydown', { bubbles: true, cancelable: true }) as Event & {
      key: string;
    };
    event.key = 'Enter';
    button.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function renderSection(canManage: boolean): React.ReactElement {
  return React.createElement(EnvironmentsSection, { canManage });
}

describe('EnvironmentsSection inline detail pane', () => {
  test('renders snapshot metadata below the repository without provider or status badges', () => {
    mockBuildStatuses['env-1'] = {
      environmentId: 'env-1',
      supported: true,
      unsupportedReason: null,
      configurationRevision: 1,
      activeBuild: null,
      latestBuild: null,
      published: {
        buildId: 'build-1',
        revision: 1,
        sourceCommit: 'a'.repeat(40),
        sourceBranch: 'main',
        capturedAt: Date.now() - 6 * 24 * 60 * 60_000,
        size: 100,
        setupDurationMs: 60_000,
        stale: 'age',
        expiresAt: Date.now(),
      },
      automaticBackoff: null,
      sessionPreparationBudgetMs: 12 * 60_000,
    };
    const mounted = mount(renderSection(true));
    try {
      const row = mounted.container.querySelector(
        '[aria-label="Edit environment Kilo Environment"]'
      );
      const metadata = Array.from(row?.querySelectorAll('span[title]') ?? []);
      expect(metadata.map(span => span.textContent)).toEqual([
        'Kilo Environment',
        'Kilo-Org/kilocode',
        'Snapshot 6 days ago',
      ]);
      expect(metadata.every(span => span.classList.contains('truncate'))).toBe(true);
      expect(row?.querySelector('[data-slot="badge"]')).toBeNull();
      expect(row?.textContent).not.toMatch(/\b(GH|stale)\b/);
      expect(row?.getAttribute('aria-pressed')).toBe('true');
    } finally {
      mounted.cleanup();
    }
  });

  test('keeps every repository visible without a redundant repository-count badge', () => {
    mockEnvironments = [
      {
        id: 'env-1',
        name: 'Multi-repo environment',
        createdAt,
        updatedAt: createdAt,
        plainVarCount: 0,
        secretCount: 0,
        commandCount: 0,
        configurationRevision: 1,
        sandboxAllocation: null,
        repositories: [
          { platform: 'github', repoFullName: 'Kilo-Org/cloud' },
          {
            platform: 'gitlab',
            repoFullName: 'group/project',
            gitlabCloneUrl: 'https://gitlab.com/group/project.git',
          },
        ],
      },
    ];
    const mounted = mount(renderSection(true));
    try {
      const row = mounted.container.querySelector(
        '[aria-label="Edit environment Multi-repo environment"]'
      );
      expect(row?.textContent).toContain('Kilo-Org/cloud');
      expect(row?.textContent).toContain('group/project');
      expect(row?.textContent).not.toMatch(/\b(GH|GL|repos)\b/);
      expect(row?.querySelector('[data-slot="badge"]')).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  test('selects the first environment and switches the detail pane on selection', () => {
    const mounted = mount(renderSection(true));
    try {
      expect(mounted.container.textContent).not.toContain('New sessions use');
      expect(mockListOptions).toMatchObject({ enabled: true });
      expect(mockBuildStatusOptions['env-1']).toMatchObject({ enabled: true });
      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
      const nameInput = mounted.container.querySelector<HTMLInputElement>('#environment-name');
      expect(nameInput?.value).toBe('Kilo Environment');

      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));

      expect(selectedLabel(mounted.container)).toBe('Edit environment Other Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Other Environment'
      );
      expect(mounted.container.textContent).toContain('Kilo-Org/cloud');
    } finally {
      mounted.cleanup();
    }
  });

  test('falls back to the remaining environment on overview when a successful refetch removes the selection', async () => {
    const mounted = mount(renderSection(true));
    try {
      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));
      expect(selectedLabel(mounted.container)).toBe('Edit environment Other Environment');

      await activateTab(mounted.container, 'Variables');
      expect(mounted.container.querySelector('textarea')).not.toBeNull();

      mockEnvironments = mockEnvironments.filter(environment => environment.id !== 'env-2');
      mounted.rerender(renderSection(true));

      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Kilo Environment'
      );
      expect(mounted.container.querySelector('textarea')).toBeNull();
      expect(mounted.container.textContent).not.toContain('Could not load this environment.');
    } finally {
      mounted.cleanup();
    }
  });

  test('clears dirty state when a successful refetch removes the last environment', () => {
    const mounted = mount(renderSection(true));
    try {
      const input = mounted.container.querySelector<HTMLInputElement>('#environment-name');
      if (!input) throw new Error('environment name input not found');
      setInputValue(input, 'Edited environment');

      mockEnvironments = [];
      mounted.rerender(renderSection(true));
      expect(selectedLabel(mounted.container)).toBeNull();
      expect(mounted.container.textContent).toContain('No environments');

      mockConfirm.mockReturnValue(false);
      clickButton(mounted.container, 'Kilo-Org/new-repo');

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mounted.container.textContent).toContain('New environment');
    } finally {
      mounted.cleanup();
    }
  });

  test('restores the previous selection and overview page when cancelling a create', async () => {
    const mounted = mount(renderSection(true));
    try {
      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));
      expect(selectedLabel(mounted.container)).toBe('Edit environment Other Environment');

      await activateTab(mounted.container, 'Variables');
      expect(mounted.container.querySelector('textarea')).not.toBeNull();

      clickButton(mounted.container, 'Kilo-Org/new-repo');
      expect(mounted.container.textContent).toContain('New environment');
      await activateTab(mounted.container, 'Variables');
      expect(mounted.container.querySelector('textarea')).not.toBeNull();

      clickButton(mounted.container, 'Cancel');

      expect(selectedLabel(mounted.container)).toBe('Edit environment Other Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Other Environment'
      );
      expect(mounted.container.querySelector('textarea')).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  test('does not reconcile selection before a pending deletion selects its neighbour', async () => {
    mockEnvironments.push(makeEnvironmentSummary('env-3', 'Third Environment', 'Kilo-Org/cli'));
    mockDetails['env-3'] = makeEnvironmentDetail('env-3', 'Third Environment', 'Kilo-Org/cli');
    const deletion = Promise.withResolvers<void>();
    mockDelete.mockImplementationOnce(async ({ environmentId }) => {
      mockEnvironments = mockEnvironments.filter(environment => environment.id !== environmentId);
      await deletion.promise;
    });
    const mounted = mount(renderSection(true));
    try {
      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));
      await clickButtonAndFlush(mounted.container, 'Delete environment test');
      mounted.rerender(renderSection(true));
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Other Environment'
      );
      await act(async () => {
        deletion.resolve();
        await deletion.promise;
      });
      expect(selectedLabel(mounted.container)).toBe('Edit environment Third Environment');
    } finally {
      deletion.resolve();
      mounted.cleanup();
    }
  });

  test('shows the list error in the detail pane instead of an empty state', () => {
    mockListHasData = false;
    mockListError = true;
    const mounted = mount(renderSection(true));
    try {
      const messages = Array.from(mounted.container.querySelectorAll('p')).filter(
        paragraph => paragraph.textContent === 'Failed to load environments.'
      );
      expect(messages).toHaveLength(2);
      expect(mounted.container.textContent).not.toContain('No environments');
    } finally {
      mounted.cleanup();
    }
  });

  test('keeps cached rows and an unsaved draft when the list refetch fails', () => {
    const mounted = mount(renderSection(true));
    try {
      const input = mounted.container.querySelector<HTMLInputElement>('#environment-name');
      if (!input) throw new Error('environment name input not found');
      setInputValue(input, 'Edited environment');

      mockListError = true;
      mounted.rerender(renderSection(true));

      expect(mounted.container.textContent).not.toContain('Failed to load environments.');
      expect(findButton(mounted.container, 'Other Environment')).toBeDefined();
      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Edited environment'
      );
    } finally {
      mounted.cleanup();
    }
  });

  test('disables owner and build status queries when inactive', () => {
    const mounted = mount(
      React.createElement(EnvironmentsSection, { canManage: true, active: false })
    );
    try {
      expect(mockListOptions).toMatchObject({ enabled: false });
      expect(mockBuildStatusOptions['env-1']).toMatchObject({ enabled: false });
      expect(mockBuildStatusOptions['env-2']).toMatchObject({ enabled: false });
    } finally {
      mounted.cleanup();
    }
  });

  test('creates an environment inline and selects the created environment', async () => {
    const mounted = mount(renderSection(true));
    try {
      clickButton(mounted.container, 'Kilo-Org/new-repo');
      expect(mounted.container.textContent).toContain('New environment');
      expect(findButton(mounted.container, 'Cancel')).toBeDefined();

      await clickButtonAndFlush(mounted.container, 'Save environment');

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0]).toMatchObject({
        name: 'new-repo',
        repositories: [{ platform: 'github', fullName: 'Kilo-Org/new-repo' }],
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Environment created');
      expect(selectedLabel(mounted.container)).toBe('Edit environment new-repo');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'new-repo'
      );
    } finally {
      mounted.cleanup();
    }
  });

  test('saves the selected environment and keeps it selected', async () => {
    const mounted = mount(renderSection(true));
    try {
      await clickButtonAndFlush(mounted.container, 'Save environment');

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate.mock.calls[0][0]).toMatchObject({
        environmentId: 'env-1',
        name: 'Kilo Environment',
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Environment saved');
      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
    } finally {
      mounted.cleanup();
    }
  });

  test('refreshes saved values and keeps the selected detail tab after saving', async () => {
    const mounted = mount(renderSection(true));
    try {
      const input = mounted.container.querySelector<HTMLInputElement>('#environment-name');
      if (!input) throw new Error('environment name input not found');
      setInputValue(input, 'Renamed environment');

      await activateTab(mounted.container, 'Variables');
      expect(mounted.container.querySelector('textarea')).not.toBeNull();

      await clickButtonAndFlush(mounted.container, 'Save environment');

      expect(mockUpdate.mock.calls[0][0]).toMatchObject({ name: 'Renamed environment' });
      expect(mounted.container.querySelector('textarea')).not.toBeNull();
      expect(mounted.container.textContent).toContain('Renamed environment');
      expect(selectedLabel(mounted.container)).toBe('Edit environment Renamed environment');
    } finally {
      mounted.cleanup();
    }
  });

  test('keeps edits when discard is cancelled and discards them when confirmed', () => {
    const mounted = mount(renderSection(true));
    try {
      const input = mounted.container.querySelector<HTMLInputElement>('#environment-name');
      if (!input) throw new Error('environment name input not found');
      setInputValue(input, 'Edited environment');
      expect(input.value).toBe('Edited environment');

      mockConfirm.mockReturnValue(false);
      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));

      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Edited environment'
      );

      mockConfirm.mockReturnValue(true);
      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));

      expect(mockConfirm).toHaveBeenCalledTimes(2);
      expect(selectedLabel(mounted.container)).toBe('Edit environment Other Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Other Environment'
      );
    } finally {
      mounted.cleanup();
    }
  });

  test('remounts the create form when the same repository is chosen after discarding edits', () => {
    const mounted = mount(renderSection(true));
    try {
      clickButton(mounted.container, 'Kilo-Org/new-repo');
      const input = mounted.container.querySelector<HTMLInputElement>('#environment-name');
      if (!input) throw new Error('environment name input not found');
      setInputValue(input, 'Edited new environment');

      mockConfirm.mockReturnValue(false);
      clickButton(mounted.container, 'Kilo-Org/new-repo');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Edited new environment'
      );

      mockConfirm.mockReturnValue(true);
      clickButton(mounted.container, 'Kilo-Org/new-repo');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        ''
      );
      expect(mounted.container.textContent).toContain('New environment');
    } finally {
      mounted.cleanup();
    }
  });

  test('does not navigate while a save is pending', async () => {
    let resolveUpdate!: () => void;
    mockUpdate.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveUpdate = resolve;
        })
    );
    const mounted = mount(renderSection(true));
    try {
      const saveButton = findButton(mounted.container, 'Save environment');
      if (!saveButton) throw new Error('save button not found');
      await act(async () => {
        saveButton.click();
        await Promise.resolve();
      });

      expect(findButton(mounted.container, 'Save environment')?.disabled).toBe(true);
      expect(findButton(mounted.container, 'Add environment')?.disabled).toBe(true);
      const otherRow = mounted.container.querySelector<HTMLButtonElement>(
        '[aria-label="Edit environment Other Environment"]'
      );
      expect(otherRow?.disabled).toBe(true);
      click(otherRow);
      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');

      clickButton(mounted.container, 'Kilo-Org/new-repo');
      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
      expect(mounted.container.textContent).not.toContain('New environment');

      await act(async () => {
        resolveUpdate();
        await Promise.resolve();
      });

      expect(selectedLabel(mounted.container)).toBe('Edit environment Kilo Environment');
    } finally {
      mounted.cleanup();
    }
  });

  test('shows a retry when the selected environment detail fails to load', () => {
    mockDetailErrorId = 'env-2';
    const mounted = mount(renderSection(true));
    try {
      click(mounted.container.querySelector('[aria-label="Edit environment Other Environment"]'));

      expect(mounted.container.textContent).toContain('Could not load this environment.');
      clickButton(mounted.container, 'Retry');

      expect(mockRefetchDetail).toHaveBeenCalledTimes(1);
    } finally {
      mounted.cleanup();
    }
  });

  test('deletes the selected environment and selects the remaining environment', async () => {
    const mounted = mount(renderSection(true));
    try {
      await clickButtonAndFlush(mounted.container, 'Delete environment test');

      expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'env-1' }));
      expect(selectedLabel(mounted.container)).toBe('Edit environment Other Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Other Environment'
      );
    } finally {
      mounted.cleanup();
    }
  });

  test('renders a read-only pane for members and still allows selecting environments', () => {
    const mounted = mount(renderSection(false));
    try {
      expect(findButton(mounted.container, 'Add environment')).toBeUndefined();
      expect(findButton(mounted.container, 'Save environment')).toBeUndefined();
      expect(mounted.container.textContent).toContain(
        'View only. Organization owners and admins can edit this environment.'
      );
      expect(
        mounted.container
          .querySelector<HTMLInputElement>('#environment-name')
          ?.hasAttribute('readOnly')
      ).toBe(true);

      click(mounted.container.querySelector('[aria-label="View environment Other Environment"]'));
      expect(selectedLabel(mounted.container)).toBe('View environment Other Environment');
      expect(mounted.container.querySelector<HTMLInputElement>('#environment-name')?.value).toBe(
        'Other Environment'
      );
    } finally {
      mounted.cleanup();
    }
  });
});

afterEach(() => {
  jest.clearAllMocks();
});
