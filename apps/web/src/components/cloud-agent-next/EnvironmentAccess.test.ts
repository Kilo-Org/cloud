/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- @swc/jest does not hoist `jest.mock` above imports, so mocked modules are required after the mocks register. */
import { act } from 'react';
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { EnvironmentResponse, EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

Object.assign(globalThis, { React });

let mockCanManage = false;
let mockEnvironment: EnvironmentResponse;
let mockEnvironments: EnvironmentSummary[];

jest.mock('@/components/ui/dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  type DialogContextValue = { open: boolean; onOpenChange?: (open: boolean) => void };
  const DialogContext = react.createContext<DialogContextValue>({ open: false });

  const block =
    (tag: string) =>
    ({ children, className }: { children?: ReactNode; className?: string }) =>
      react.createElement(tag, { className }, children);

  const Dialog = ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: ReactNode;
  }) => react.createElement(DialogContext.Provider, { value: { open, onOpenChange } }, children);

  const DialogContent = ({ children }: { children?: ReactNode }) => {
    const context = react.useContext(DialogContext);
    return context.open
      ? react.createElement('div', { 'data-testid': 'dialog-content' }, children)
      : null;
  };

  const DialogClose = ({ children }: { children: ReactElement<{ onClick?: () => void }> }) => {
    const context = react.useContext(DialogContext);
    return react.cloneElement(children, { onClick: () => context.onOpenChange?.(false) });
  };

  return {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription: block('p'),
    DialogFooter: block('div'),
    DialogHeader: block('div'),
    DialogTitle: block('h2'),
  };
});

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/hooks/useCloudAgentEnvironments', () => ({
  useCloudAgentEnvironment: () => ({
    data: mockEnvironment,
    isLoading: false,
    isError: false,
  }),
  useCloudAgentEnvironmentMutations: () => ({
    createEnvironment: { isPending: false, mutateAsync: async () => undefined },
    updateEnvironment: { isPending: false, mutateAsync: async () => undefined },
    deleteEnvironment: { isPending: false, mutateAsync: async () => undefined },
  }),
  useCloudAgentEnvironmentsForOwner: () => ({
    data: mockEnvironments,
    isLoading: false,
    isError: false,
  }),
  useEnvironmentBuildStatus: () => ({ data: undefined }),
}));

jest.mock('@/hooks/useEnvironmentProfiles', () => ({
  useEnvironmentProfiles: () => ({
    profiles: [],
    isLoading: false,
    isError: false,
    retry: async () => undefined,
  }),
}));

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useCloudAgentSettingsCanManage: () => ({ data: { canManage: mockCanManage } }),
}));

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

jest.mock('./EnvironmentSandboxField', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    EnvironmentSandboxField: ({ disabled }: { disabled: boolean }) =>
      react.createElement('div', {
        'data-testid': 'sandbox-field',
        'data-disabled': String(disabled),
      }),
  };
});

jest.mock('./EnvironmentBuildPanel', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    EnvironmentBuildPanel: () => react.createElement('div', { 'data-testid': 'build-panel' }),
    useEnvironmentBuildControl: () => ({
      isPending: false,
      start: () => undefined,
      cancel: () => undefined,
    }),
  };
});

jest.mock('./EnvironmentDeleteDialog', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    EnvironmentDeleteDialog: () =>
      react.createElement('div', { 'data-testid': 'delete-environment' }),
  };
});

const { RepositoryEnvironmentChip } = require('./RepositoryEnvironmentChip') as {
  RepositoryEnvironmentChip: React.ComponentType<{
    repository: { platform: 'github'; fullName: string };
    repositoryLabel: string;
    environment: EnvironmentSummary;
  }>;
};
const { EnvironmentsSection } = require('./settings/EnvironmentsSection') as {
  EnvironmentsSection: React.ComponentType<{ canManage: boolean }>;
};

const environment: EnvironmentSummary = {
  id: 'env-1',
  name: 'Kilo Environment',
  platform: 'github',
  repoFullName: 'Kilo-Org/kilocode',
  gitlabCloneUrl: null,
  bitbucketWorkspaceUuid: null,
  bitbucketRepositoryUuid: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  plainVarCount: 1,
  secretCount: 1,
  commandCount: 1,
  configurationRevision: 1,
  sandboxAllocation: null,
};

const environmentDetail: EnvironmentResponse = {
  id: environment.id,
  name: environment.name,
  platform: environment.platform,
  repoFullName: environment.repoFullName,
  gitlabCloneUrl: environment.gitlabCloneUrl,
  bitbucketWorkspaceUuid: environment.bitbucketWorkspaceUuid,
  bitbucketRepositoryUuid: environment.bitbucketRepositoryUuid,
  createdAt: environment.createdAt,
  updatedAt: environment.updatedAt,
  plainVars: [
    {
      key: 'NODE_ENV',
      value: 'production',
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
    },
  ],
  commands: ['pnpm install'],
  configurationRevision: environment.configurationRevision,
  sandboxAllocation: environment.sandboxAllocation,
  secretKeys: ['API_KEY'],
};

beforeEach(() => {
  mockCanManage = false;
  mockEnvironment = environmentDetail;
  mockEnvironments = [environment];
});

type LinkedomModule = {
  parseHTML: (html: string) => {
    window: typeof globalThis & {
      HTMLElement: typeof HTMLElement;
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
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
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
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
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

function mount(element: React.ReactElement): {
  container: HTMLElement;
  cleanup: () => void;
} {
  const dom = installLinkedomDom();
  let root!: Root;
  act(() => {
    root = createRoot(dom.container);
    root.render(element);
  });

  return {
    container: dom.container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    },
  };
}

function dialogContent(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="dialog-content"]');
}

function findButton(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(button =>
    button.textContent?.includes(text)
  ) as HTMLButtonElement | undefined;
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('element not found');
  act(() => {
    (element as HTMLElement).click();
  });
}

function clickButton(container: ParentNode, text: string): void {
  const button = findButton(container, text);
  if (!button) throw new Error(`button not found: ${text}`);
  click(button);
}

function chipElement(): React.ReactElement {
  return React.createElement(RepositoryEnvironmentChip, {
    repository: { platform: 'github', fullName: environment.repoFullName },
    repositoryLabel: environment.repoFullName,
    environment,
  });
}

describe('environment access for members and managers', () => {
  test('a member opens a read-only dialog, navigates its editors, and closes it', () => {
    mockCanManage = false;
    const mounted = mount(chipElement());
    try {
      const trigger = mounted.container.querySelector('[aria-label="View environment"]');
      expect(trigger).not.toBeNull();
      expect(dialogContent(mounted.container)).toBeNull();

      click(trigger);
      let content = dialogContent(mounted.container);
      expect(content).not.toBeNull();
      expect(content?.textContent).toContain(
        'View only. Organization owners and admins can edit this environment.'
      );
      expect(
        content?.querySelector('[data-testid="sandbox-field"]')?.getAttribute('data-disabled')
      ).toBe('true');
      expect(findButton(content!, 'Save environment')).toBeUndefined();
      expect(content?.querySelector('[data-testid="delete-environment"]')).toBeNull();
      expect(findButton(content!, 'Close')).toBeDefined();

      clickButton(content!, 'Setup script');
      content = dialogContent(mounted.container);
      const scripts = content?.querySelector('textarea');
      expect(scripts).not.toBeNull();
      expect(scripts?.hasAttribute('readOnly')).toBe(true);
      expect(content?.textContent).not.toContain('Choose file');
      expect(content?.textContent).toContain('Runs before the agent starts.');

      click(content?.querySelector('[aria-label="Back to environment"]'));
      clickButton(content!, 'Environment variables');
      content = dialogContent(mounted.container);
      const variables = content?.querySelector('textarea');
      expect(variables).not.toBeNull();
      expect(variables?.hasAttribute('readOnly')).toBe(true);
      expect(content?.textContent).toContain(
        'Secret values are hidden. Only their names are shown.'
      );

      clickButton(content!, 'Close');
      expect(dialogContent(mounted.container)).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });

  test('a manager still gets editable controls and save/delete actions', () => {
    mockCanManage = true;
    const mounted = mount(chipElement());
    try {
      const trigger = mounted.container.querySelector('[aria-label="Edit environment"]');
      expect(trigger).not.toBeNull();

      click(trigger);
      const content = dialogContent(mounted.container);
      expect(content).not.toBeNull();
      expect(content?.textContent).not.toContain('View only');
      expect(
        content?.querySelector('[data-testid="sandbox-field"]')?.getAttribute('data-disabled')
      ).toBe('false');
      expect(findButton(content!, 'Save environment')).toBeDefined();
      expect(findButton(content!, 'Cancel')).toBeDefined();
      expect(content?.querySelector('[data-testid="delete-environment"]')).not.toBeNull();

      clickButton(content!, 'Setup script');
      const scripts = dialogContent(mounted.container)?.querySelector('textarea');
      expect(scripts?.hasAttribute('readOnly')).toBe(false);
      expect(dialogContent(mounted.container)?.textContent).toContain('Choose file');
    } finally {
      mounted.cleanup();
    }
  });

  test('a member opens an environment from the settings list', () => {
    mockCanManage = false;
    const mounted = mount(React.createElement(EnvironmentsSection, { canManage: false }));
    try {
      expect(findButton(mounted.container, 'Add environment')).toBeUndefined();
      const nameButton = mounted.container.querySelector(
        '[aria-label="View environment Kilo Environment"]'
      );
      expect(nameButton).not.toBeNull();
      expect(dialogContent(mounted.container)).toBeNull();

      click(nameButton);
      const content = dialogContent(mounted.container);
      expect(content).not.toBeNull();
      expect(content?.textContent).toContain(
        'View only. Organization owners and admins can edit this environment.'
      );
      expect(content?.textContent).toContain(environment.repoFullName);
      expect(content?.querySelector('[data-testid="delete-environment"]')).toBeNull();

      clickButton(content!, 'Close');
      expect(dialogContent(mounted.container)).toBeNull();
    } finally {
      mounted.cleanup();
    }
  });
});

afterEach(() => {
  jest.clearAllMocks();
});
