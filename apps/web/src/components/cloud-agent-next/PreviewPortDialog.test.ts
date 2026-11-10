import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';
import type { PreviewPortDialog as PreviewPortDialogComponent } from './PreviewPortDialog';

type PreviewResult = {
  services: Array<{ port: number; name: string; description?: string }>;
  status: 'running' | 'not_running' | 'not_ready' | 'unsupported';
};

type CreatePreviewInput = ({ cloudAgentSessionId: string } | { worktreeId: string }) & {
  port: number;
  path?: string;
  organizationId?: string;
};

const sessionId = 'workspace_00000000-0000-4000-8000-000000000001' as const;
const worktreeId = 'worktree_00000000-0000-4000-8000-000000000001' as const;
const sessionTarget = { cloudAgentSessionId: sessionId } satisfies PreviewTarget;
const worktreeTarget = { worktreeId } satisfies PreviewTarget;

const mockPersonalList = jest.fn<() => Promise<PreviewResult>>();
const mockOrganizationList = jest.fn<() => Promise<PreviewResult>>();
const mockCreatePersonal =
  jest.fn<(input: CreatePreviewInput) => Promise<{ url: string; expiresAt: number }>>();
const mockCreateOrganization =
  jest.fn<(input: CreatePreviewInput) => Promise<{ url: string; expiresAt: number }>>();
const mockToastError = jest.fn<(message: string) => void>();

function listOptions(
  kind: 'personal' | 'organization',
  input: unknown,
  queryFn: () => Promise<PreviewResult>
) {
  if (input === skipToken) {
    return { queryKey: ['preview-services', kind, 'skip'], queryFn: skipToken };
  }
  return { queryKey: ['preview-services', kind, input], queryFn };
}

const mockTrpc = {
  cloudAgentNext: {
    listPreviewServices: {
      queryOptions: jest.fn((input: unknown) => listOptions('personal', input, mockPersonalList)),
    },
    createPreview: {
      mutationOptions: jest.fn(() => ({
        mutationKey: ['create-preview', 'personal'],
        mutationFn: mockCreatePersonal,
      })),
    },
  },
  organizations: {
    cloudAgentNext: {
      listPreviewServices: {
        queryOptions: jest.fn((input: unknown) =>
          listOptions('organization', input, mockOrganizationList)
        ),
      },
      createPreview: {
        mutationOptions: jest.fn(() => ({
          mutationKey: ['create-preview', 'organization'],
          mutationFn: mockCreateOrganization,
        })),
      },
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: (message: string) => mockToastError(message) },
}));

jest.mock('@/components/ui/dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const DialogContext = react.createContext<{ open: boolean }>({ open: false });

  const block =
    (tag: string) =>
    ({ children, className }: { children?: ReactNode; className?: string }) =>
      react.createElement(tag, { className }, children);

  const Dialog = ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: ReactNode;
  }) => react.createElement(DialogContext.Provider, { value: { open } }, children);

  const DialogContent = ({ children }: { children?: ReactNode }) => {
    const context = react.useContext(DialogContext);
    if (!context.open) return null;
    return react.createElement('div', { 'data-testid': 'dialog-content' }, children);
  };

  return {
    Dialog,
    DialogContent,
    DialogDescription: block('p'),
    DialogHeader: block('div'),
    DialogTitle: block('h2'),
  };
});

let PreviewPortDialog: typeof PreviewPortDialogComponent;

beforeAll(async () => {
  ({ PreviewPortDialog } = await import('./PreviewPortDialog'));
});

type TestWindow = Window & typeof globalThis;

function installDom(): { container: HTMLElement; window: TestWindow; cleanup: () => void } {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { parseHTML } = requireFromNext('linkedom') as {
    parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const replacements = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, globals[name]);
    globals[name] = value;
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');
  return {
    container,
    window: window as unknown as TestWindow,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

type Popup = {
  opener: null;
  location: { href: string };
  close: jest.Mock;
};

describe('PreviewPortDialog', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let queryClient: QueryClient;
  let popup: Popup;
  let mockWindowOpen: jest.Mock;
  let onOpenChange: jest.Mock<(open: boolean) => void>;

  function Harness({
    open,
    target,
    organizationId,
  }: {
    open: boolean;
    target: PreviewTarget;
    organizationId?: string;
  }) {
    return createElement(PreviewPortDialog, {
      open,
      onOpenChange,
      target,
      organizationId,
    });
  }

  function render(open: boolean, organizationId?: string, target: PreviewTarget = sessionTarget) {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { open, target, organizationId })
        )
      )
    );
  }

  async function settle() {
    for (let index = 0; index < 6; index++) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    }
  }

  function text(): string {
    return dom.container.textContent ?? '';
  }

  function buttonByText(label: string): HTMLElement {
    const button = Array.from(dom.container.querySelectorAll('button')).find(
      candidate => candidate.textContent?.trim() === label
    );
    if (!button) throw new Error(`Button not rendered: ${label}`);
    return button as HTMLElement;
  }

  function buttonByLabel(label: string): HTMLElement {
    const button = Array.from(dom.container.querySelectorAll('button')).find(
      candidate => candidate.getAttribute('aria-label') === label
    );
    if (!button) throw new Error(`Button not rendered: ${label}`);
    return button as HTMLElement;
  }

  function portInput(): HTMLInputElement {
    const input = dom.container.querySelector('input');
    if (!input) throw new Error('Port input not rendered');
    return input as HTMLInputElement;
  }

  function setInputValue(input: HTMLElement, value: string) {
    act(() => {
      const key = Object.getOwnPropertyNames(input).find(name => name.startsWith('__reactProps'));
      const props = key
        ? (
            input as unknown as Record<
              string,
              { onChange?: (event: { target: { value: string } }) => void }
            >
          )[key]
        : undefined;
      if (!props?.onChange) throw new Error('Port input change handler missing');
      props.onChange({ target: { value } });
    });
  }

  function submitPortForm() {
    const form = dom.container.querySelector('form');
    if (!form) throw new Error('Port form not rendered');
    act(() => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
  }

  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  }

  function running(services: PreviewResult['services']): PreviewResult {
    return { status: 'running', services };
  }

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retryDelay: 0 } },
    });
    popup = { opener: null, location: { href: '' }, close: jest.fn() };
    mockWindowOpen = jest.fn(() => popup);
    dom.window.open = mockWindowOpen as unknown as typeof dom.window.open;
    onOpenChange = jest.fn<(open: boolean) => void>();
    mockPersonalList.mockReset().mockResolvedValue(running([]));
    mockOrganizationList.mockReset().mockResolvedValue(running([]));
    mockCreatePersonal
      .mockReset()
      .mockResolvedValue({ url: 'https://preview.test/personal', expiresAt: 1 });
    mockCreateOrganization
      .mockReset()
      .mockResolvedValue({ url: 'https://preview.test/organization', expiresAt: 1 });
    mockToastError.mockClear();
    mockTrpc.cloudAgentNext.listPreviewServices.queryOptions.mockClear();
    mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions.mockClear();
    mockTrpc.cloudAgentNext.createPreview.mutationOptions.mockClear();
    mockTrpc.organizations.cloudAgentNext.createPreview.mutationOptions.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    dom.cleanup();
  });

  it('shows a loading state until discovery resolves', async () => {
    let resolve!: (result: PreviewResult) => void;
    mockPersonalList.mockReturnValue(
      new Promise<PreviewResult>(r => {
        resolve = r;
      })
    );

    render(true);

    expect(text()).toContain('Looking for running services...');
    expect(dom.container.querySelector('[role="status"]')).not.toBeNull();

    resolve(running([{ name: 'Vite', port: 5173 }]));
    await settle();

    expect(text()).not.toContain('Looking for running services...');
    expect(text()).toContain('Vite');
  });

  it('lists discovered names, descriptions and ports', async () => {
    mockPersonalList.mockResolvedValue(
      running([
        { name: 'Vite', description: 'Frontend dev server', port: 5173 },
        { name: 'API', port: 3000 },
      ])
    );

    render(true);
    await settle();

    expect(text()).toContain('Vite');
    expect(text()).toContain('Frontend dev server');
    expect(text()).toContain('localhost:5173');
    expect(text()).toContain('API');
    expect(text()).toContain('localhost:3000');
    expect(buttonByLabel('Open Vite on port 5173')).toBeDefined();
    expect(buttonByLabel('Open API on port 3000')).toBeDefined();
  });

  it('opens the exact service port and session, then closes on success', async () => {
    mockPersonalList.mockResolvedValue(running([{ name: 'Vite', port: 5173 }]));

    render(true);
    await settle();
    click(buttonByLabel('Open Vite on port 5173'));
    await settle();

    expect(mockWindowOpen).toHaveBeenCalledWith('about:blank', '_blank');
    expect(mockCreatePersonal.mock.calls[0]?.[0]).toEqual({
      cloudAgentSessionId: sessionId,
      port: 5173,
      path: undefined,
    });
    expect(mockCreateOrganization).not.toHaveBeenCalled();
    expect(popup.location.href).toBe('https://preview.test/personal');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and reports a failed preview creation', async () => {
    mockPersonalList.mockResolvedValue(running([{ name: 'Vite', port: 5173 }]));
    mockCreatePersonal.mockRejectedValue(new Error('Ticket failed'));

    render(true);
    await settle();
    click(buttonByLabel('Open Vite on port 5173'));
    await settle();

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('');
    expect(mockToastError).toHaveBeenCalledWith('Ticket failed');
  });

  it('keeps the dialog open when the browser blocks the popup', async () => {
    mockPersonalList.mockResolvedValue(running([{ name: 'Vite', port: 5173 }]));
    mockWindowOpen.mockReturnValue(null);

    render(true);
    await settle();
    click(buttonByLabel('Open Vite on port 5173'));
    await settle();

    expect(mockCreatePersonal).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      'Popup blocked. Allow popups for this site to open a preview.'
    );
  });

  it('rediscovers services when Refresh is clicked', async () => {
    mockPersonalList
      .mockResolvedValueOnce(running([{ name: 'Vite', port: 5173 }]))
      .mockResolvedValueOnce(running([{ name: 'API', port: 3000 }]));

    render(true);
    await settle();
    expect(text()).toContain('Vite');

    click(buttonByText('Refresh'));
    await settle();

    expect(mockPersonalList).toHaveBeenCalledTimes(2);
    expect(text()).toContain('API');
    expect(text()).not.toContain('Vite');
  });

  it.each([
    ['running', 'No listening services found. Ask the agent to start a web server, then refresh.'],
    ['not_running', 'This sandbox is stopped. Send the agent a message to start it again.'],
    ['not_ready', 'The sandbox is not ready yet. Refresh once it is connected.'],
    ['unsupported', 'Service discovery is not available for this sandbox.'],
  ] as const)('shows the %s empty message', async (status, message) => {
    mockPersonalList.mockResolvedValue({ status, services: [] });

    render(true);
    await settle();

    expect(text()).toContain(message);
  });

  it.each(['not_running', 'unsupported'] as const)(
    'disables the manual fallback without a spinner when discovery is %s',
    async status => {
      mockPersonalList.mockResolvedValue({ status, services: [] });

      render(true);
      await settle();

      expect(portInput().disabled).toBe(true);
      expect((buttonByText('Open port') as HTMLButtonElement).disabled).toBe(true);
      expect(buttonByText('Open port').querySelector('.animate-spin')).toBeNull();
      setInputValue(portInput(), '5173');
      submitPortForm();
      await settle();
      expect(mockCreatePersonal).not.toHaveBeenCalled();
    }
  );

  it.each(['not_running', 'unsupported'] as const)(
    'allows manual preview after a failed refresh of a %s result',
    async status => {
      mockPersonalList.mockResolvedValue({ status, services: [] });
      render(true);
      await settle();
      expect(portInput().disabled).toBe(true);

      mockPersonalList.mockRejectedValue(new Error('Scan failed'));
      click(buttonByText('Refresh'));
      await settle();

      expect(dom.container.querySelector('[role="alert"]')).not.toBeNull();
      expect(portInput().disabled).toBe(false);
      expect((buttonByText('Open port') as HTMLButtonElement).disabled).toBe(false);
      setInputValue(portInput(), '5173');
      submitPortForm();
      await settle();

      expect(mockCreatePersonal.mock.calls[0]?.[0]).toEqual({
        cloudAgentSessionId: sessionId,
        port: 5173,
        path: undefined,
      });
    }
  );

  it('shows the manual spinner only while opening a preview', async () => {
    let resolve!: (result: { url: string; expiresAt: number }) => void;
    mockCreatePersonal.mockReturnValue(new Promise(r => (resolve = r)));
    render(true);
    await settle();
    setInputValue(portInput(), '5173');
    submitPortForm();
    await settle();

    expect(portInput().disabled).toBe(true);
    expect(buttonByText('Open port').querySelector('.animate-spin')).not.toBeNull();

    resolve({ url: 'https://preview.test/personal', expiresAt: 1 });
    await settle();

    expect(buttonByText('Open port').querySelector('.animate-spin')).toBeNull();
  });

  it('shows a discovery failure instead of an empty result', async () => {
    mockPersonalList.mockRejectedValue(new Error('Scan failed'));

    render(true);
    await settle();

    expect(text()).toContain(
      'Could not discover services. Try refreshing, or enter a port manually.'
    );
    expect(dom.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('does not discover services while the dialog is closed', async () => {
    render(false);
    await settle();

    expect(mockPersonalList).not.toHaveBeenCalled();
    expect(text()).not.toContain('Listening services');

    render(true);
    await settle();

    expect(mockPersonalList).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Listening services');
  });

  it.each(['', 'abc', '80', '70000'])(
    'rejects the invalid manual port %p and keeps the dialog open',
    async value => {
      render(true);
      await settle();

      const input = portInput();
      setInputValue(input, value);
      submitPortForm();
      await settle();

      expect(text()).toContain('Enter a port between 1024 and 65535.');
      expect(mockCreatePersonal).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    }
  );

  it('opens a valid manual port and closes on success', async () => {
    render(true);
    await settle();

    const input = portInput();
    setInputValue(input, '5173');
    submitPortForm();
    await settle();

    expect(mockCreatePersonal.mock.calls[0]?.[0]).toEqual({
      cloudAgentSessionId: sessionId,
      port: 5173,
      path: undefined,
    });
    expect(popup.location.href).toBe('https://preview.test/personal');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses the organization discovery and create endpoints when scoped', async () => {
    mockOrganizationList.mockResolvedValue(running([{ name: 'Vite', port: 5173 }]));

    render(true, 'organization-1');
    await settle();

    expect(mockOrganizationList).toHaveBeenCalledTimes(1);
    expect(mockPersonalList).not.toHaveBeenCalled();
    expect(
      mockTrpc.organizations.cloudAgentNext.listPreviewServices.queryOptions
    ).toHaveBeenCalledWith({ cloudAgentSessionId: sessionId, organizationId: 'organization-1' });
    expect(mockTrpc.cloudAgentNext.listPreviewServices.queryOptions).toHaveBeenCalledWith(
      skipToken
    );

    click(buttonByLabel('Open Vite on port 5173'));
    await settle();

    expect(mockCreateOrganization.mock.calls[0]?.[0]).toEqual({
      cloudAgentSessionId: sessionId,
      port: 5173,
      path: undefined,
      organizationId: 'organization-1',
    });
    expect(mockCreatePersonal).not.toHaveBeenCalled();
    expect(popup.location.href).toBe('https://preview.test/organization');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('discovers and opens a worktree target', async () => {
    mockPersonalList.mockResolvedValue(running([{ name: 'Vite', port: 5173 }]));

    render(true, undefined, worktreeTarget);
    await settle();

    expect(mockTrpc.cloudAgentNext.listPreviewServices.queryOptions).toHaveBeenCalledWith(
      worktreeTarget
    );
    expect(buttonByLabel('Open Vite on port 5173')).toBeDefined();

    click(buttonByLabel('Open Vite on port 5173'));
    await settle();

    expect(mockCreatePersonal.mock.calls[0]?.[0]).toEqual({
      worktreeId,
      port: 5173,
      path: undefined,
    });
    expect(mockCreateOrganization).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
