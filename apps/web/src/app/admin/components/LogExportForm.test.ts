import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { LogExportForm as LogExportFormComponent } from './LogExportForm';

const mockToastError = jest.fn();
jest.mock('sonner', () => ({ toast: { error: mockToastError } }));

describe('LogExportForm', () => {
  let root: Root;
  let container: HTMLElement;
  let cleanup: () => void;
  let LogExportForm: typeof LogExportFormComponent;
  const location = { href: '' };
  const downloadPath = '/admin/api/api-request-log/download';
  const idDescription = 'Enter one log ID or multiple IDs separated by commas.';

  beforeEach(async () => {
    jest.clearAllMocks();
    location.href = '';
    const requireFromNext = createRequire(require.resolve('next/package.json'));
    const { window, document } = (
      requireFromNext('linkedom') as {
        parseHTML: (html: string) => { window: typeof globalThis; document: Document };
      }
    ).parseHTML('<html><body><div id="root"></div></body></html>');
    document.oninput = null;
    const globals = {
      React,
      window,
      document,
      location,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, globals);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    const { createRoot } = await import('react-dom/client');
    ({ LogExportForm } = await import('./LogExportForm'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  function renderForm(props: Partial<React.ComponentProps<typeof LogExportFormComponent>> = {}) {
    act(() =>
      root.render(
        createElement(LogExportForm, {
          title: 'Download API Request Log',
          downloadPath,
          idLabel: 'Log IDs',
          idPlaceholder: 'e.g. 123, 456',
          idDescription,
          ...props,
        })
      )
    );
  }

  function idInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Log ID input missing');
    return input;
  }

  function setId(value: string) {
    const input = idInput();
    input.type = 'text';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Input value setter missing');
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function download() {
    const button = container.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('Download button missing');
    await act(async () => button.click());
  }

  it('connects comma-separated ID guidance to a text input', () => {
    renderForm();
    const input = idInput();
    const helpId = input.getAttribute('aria-describedby');

    expect(container.querySelector('label')?.getAttribute('for')).toBe(input.id);
    expect(input.getAttribute('inputmode')).toBeNull();
    expect(helpId).not.toBeNull();
    expect(document.getElementById(helpId ?? '')?.textContent).toBe(idDescription);
  });

  it.each(['123', '123, 456,789', '9223372036854775807, 9007199254740993'])(
    'submits %s unchanged in the existing id query parameter',
    async id => {
      renderForm();
      setId(` ${id} `);

      await download();

      const url = new URL(location.href, 'http://localhost');
      expect(url.pathname).toBe(downloadPath);
      expect(url.searchParams.get('id')).toBe(id);
    }
  );

  it('omits the ID filter for a blank input', async () => {
    renderForm();
    setId(' ');

    await download();

    expect(new URL(location.href, 'http://localhost').searchParams.has('id')).toBe(false);
  });

  it('runs the access preflight before navigating to a multi-ID export', async () => {
    const preflight = jest.fn(async () => {
      expect(location.href).toBe('');
    });
    renderForm({ preflight });
    setId('123,456');

    await download();

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(new URL(location.href, 'http://localhost').searchParams.get('id')).toBe('123,456');
  });

  it('does not navigate when the access preflight fails', async () => {
    renderForm({
      preflight: async () => {
        throw new Error('Access denied');
      },
    });
    setId('123,456');

    await download();

    expect(location.href).toBe('');
    expect(mockToastError).toHaveBeenCalledWith(
      'Could not verify access before download. Try again.'
    );
  });

  it('preserves the shared provider-metadata form without numeric ID guidance', async () => {
    const providerDownloadPath = '/admin/api/provider-metadata/download';
    renderForm({
      downloadPath: providerDownloadPath,
      idLabel: 'Usage ID',
      idPlaceholder: 'Enter usage UUID',
      idDescription: undefined,
    });
    const id = '00000000-0000-4000-8000-000000000001';
    setId(id);

    await download();

    const url = new URL(location.href, 'http://localhost');
    expect(url.pathname).toBe(providerDownloadPath);
    expect(url.searchParams.get('id')).toBe(id);
    expect(container.querySelector('label')?.textContent).toBe('Usage ID');
    expect(idInput().getAttribute('aria-describedby')).toBeNull();
  });
});
