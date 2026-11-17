/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- @swc/jest does not hoist `jest.mock` above imports, so the mocked module and the component that imports it are required after the mock registers. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({ user: { updateProfile: { mutationOptions: () => ({}) } } }),
}));
const mockMutate = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: mockMutate, isPending: false, error: null }),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { role: 'dialog' }, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

type EditProfileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkedinUrl: string | null;
  githubUrl: string | null;
  githubLinkedViaOAuth: boolean;
};

const { EditProfileDialog } = require('./EditProfileDialog') as {
  EditProfileDialog: (props: EditProfileDialogProps) => React.ReactNode;
};

const SAVE_LABEL = 'Save';

type LinkedomParseHtml = (html: string) => {
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

function installDom(): { container: HTMLElement; cleanup: () => void } {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { parseHTML } = requireFromNext('linkedom') as { parseHTML: LinkedomParseHtml };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const previous = {
    React: (globalThis as { React?: unknown }).React,
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
    React,
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
  if (!container) throw new Error('React root missing');
  return {
    container: container as unknown as HTMLElement,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

describe('EditProfileDialog validation', () => {
  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    mockMutate.mockClear();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function mountDialog(
    dom: { container: HTMLElement },
    options: {
      githubLinkedViaOAuth?: boolean;
      linkedinUrl?: string;
      githubUrl?: string;
    } = {}
  ) {
    const {
      githubLinkedViaOAuth = false,
      linkedinUrl = 'not-a-url',
      githubUrl = 'not-a-url',
    } = options;
    act(() => {
      root = createRoot(dom.container);
      root.render(
        React.createElement(EditProfileDialog, {
          open: true,
          onOpenChange: () => undefined,
          linkedinUrl,
          githubUrl,
          githubLinkedViaOAuth,
        })
      );
    });
  }

  function pressSave(dom: { container: HTMLElement }) {
    const save = Array.from(dom.container.querySelectorAll('button')).find(
      button => button.textContent === SAVE_LABEL
    );
    if (!save) throw new Error('Save button missing');
    act(() => {
      save.dispatchEvent(new Event('click', { bubbles: true }));
    });
  }

  it('links both invalid URL fields to their errors after Save', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    mountDialog(dom);

    for (const field of ['linkedin-url', 'github-url']) {
      const input = dom.container.querySelector(`#${field}`);
      expect(input?.getAttribute('aria-invalid')).toBe('false');
      expect(input?.hasAttribute('aria-describedby')).toBe(false);
      expect(dom.container.querySelector(`#${field}-error`)?.textContent).toBe('');
    }

    pressSave(dom);

    for (const field of ['linkedin-url', 'github-url']) {
      const input = dom.container.querySelector(`#${field}`);
      const errorId = `${field}-error`;
      expect(input?.getAttribute('aria-invalid')).toBe('true');
      expect(input?.getAttribute('aria-describedby')).toBe(errorId);
      const error = dom.container.querySelector(`#${errorId}`);
      expect(error?.getAttribute('role')).toBe('alert');
      expect(error?.textContent).toContain('http://');
    }
  });

  it('keeps the error region mounted and alerting across repeated Save', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    mountDialog(dom);

    pressSave(dom);
    const alertRegion = dom.container.querySelector('#linkedin-url-error');
    expect(alertRegion?.getAttribute('role')).toBe('alert');
    expect(alertRegion?.textContent).toContain('http://');

    pressSave(dom);
    const repeatedRegion = dom.container.querySelector('#linkedin-url-error');
    expect(repeatedRegion).toBe(alertRegion);
    expect(repeatedRegion?.getAttribute('role')).toBe('alert');
    expect(repeatedRegion?.textContent).toContain('http://');
  });

  it('resolves every label to an existing element', () => {
    for (const githubLinkedViaOAuth of [false, true]) {
      const dom = installDom();
      cleanup = dom.cleanup;
      mountDialog(dom, { githubLinkedViaOAuth });

      const labels = Array.from(dom.container.querySelectorAll('label[for]'));
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        const target = label.getAttribute('for');
        expect(target).not.toBeNull();
        expect(dom.container.querySelector(`#${target}`)).not.toBeNull();
      }
      if (githubLinkedViaOAuth) {
        expect(dom.container.querySelector('label[for="github-url"]')).toBeNull();
      }

      act(() => root?.unmount());
      root = undefined;
      cleanup?.();
      cleanup = undefined;
    }
  });

  it('sends one exact payload with both URLs when GitHub is not OAuth-linked', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    mountDialog(dom, {
      linkedinUrl: 'https://linkedin.com/in/example',
      githubUrl: 'https://github.com/example',
    });

    pressSave(dom);

    expect(mockMutate.mock.calls).toStrictEqual([
      [
        {
          linkedin_url: 'https://linkedin.com/in/example',
          github_url: 'https://github.com/example',
        },
      ],
    ]);
  });

  it('leaves github_url untouched for an OAuth-linked GitHub account', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    mountDialog(dom, {
      githubLinkedViaOAuth: true,
      linkedinUrl: 'https://linkedin.com/in/example',
      githubUrl: 'https://github.com/example',
    });

    pressSave(dom);

    expect(mockMutate.mock.calls).toStrictEqual([
      [
        {
          linkedin_url: 'https://linkedin.com/in/example',
          github_url: undefined,
        },
      ],
    ]);
  });

  it('drops the error association when the form resets', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    mountDialog(dom);
    pressSave(dom);

    const input = dom.container.querySelector('#linkedin-url');
    if (!input) throw new Error('LinkedIn input missing');
    expect(input.getAttribute('aria-describedby')).toBe('linkedin-url-error');

    act(() => {
      root?.render(
        React.createElement(EditProfileDialog, {
          open: true,
          onOpenChange: () => undefined,
          linkedinUrl: 'https://linkedin.com/in/example',
          githubUrl: 'https://github.com/example',
          githubLinkedViaOAuth: false,
        })
      );
    });

    for (const field of ['linkedin-url', 'github-url']) {
      const currentInput = dom.container.querySelector(`#${field}`);
      expect(currentInput?.getAttribute('aria-invalid')).toBe('false');
      expect(currentInput?.hasAttribute('aria-describedby')).toBe(false);
      const error = dom.container.querySelector(`#${field}-error`);
      expect(error?.textContent).toBe('');
      expect(error?.getAttribute('role')).toBeNull();
    }
  });

  it('does not render or describe a GitHub URL field when GitHub is OAuth-linked', () => {
    const dom = installDom();
    cleanup = dom.cleanup;
    mountDialog(dom, { githubLinkedViaOAuth: true });

    expect(dom.container.querySelector('#github-url')).toBeNull();
    expect(dom.container.querySelector('#github-url-error')).toBeNull();

    pressSave(dom);

    expect(dom.container.querySelector('#linkedin-url')?.getAttribute('aria-describedby')).toBe(
      'linkedin-url-error'
    );
    expect(dom.container.querySelector('#github-url-error')).toBeNull();
    expect(dom.container.querySelectorAll('#github-url-error')).toHaveLength(0);

    const ids = Array.from(dom.container.querySelectorAll('[id]')).map(element => element.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});
