import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditProfileDialog as EditProfileDialogComponent } from './EditProfileDialog';

let EditProfileDialog!: typeof EditProfileDialogComponent;

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({ user: { updateProfile: { mutationOptions: () => ({}) } } }),
}));
jest.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: () => undefined, isPending: false, error: null }),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { role: 'dialog' }, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => createElement('h2', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
}));

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

function installDom(): { container: HTMLElement; cleanup: () => void } {
  const requireFromHere = createRequire(__filename);
  const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Event: globalThis.Event,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

describe('EditProfileDialog validation', () => {
  beforeAll(() => {
    const actual = jest.requireActual<{ EditProfileDialog: typeof EditProfileDialogComponent }>(
      './EditProfileDialog'
    );
    EditProfileDialog = actual.EditProfileDialog;
  });

  let root: Root | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    cleanup?.();
    cleanup = undefined;
  });

  function mountDialog(dom: { container: HTMLElement }) {
    act(() => {
      root = createRoot(dom.container);
      root.render(
        createElement(EditProfileDialog, {
          open: true,
          onOpenChange: () => undefined,
          linkedinUrl: 'not-a-url',
          githubUrl: 'not-a-url',
          githubLinkedViaOAuth: false,
        })
      );
    });
  }

  function pressSave(dom: { container: HTMLElement }) {
    const save = Array.from(dom.container.querySelectorAll('button')).find(
      button => button.textContent === 'Save'
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
        createElement(EditProfileDialog, {
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
      expect(dom.container.querySelector(`#${field}-error`)).toBeNull();
    }
  });
});
