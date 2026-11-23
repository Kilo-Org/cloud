import React, { act, createElement, type ComponentProps } from 'react';
import type * as ReactDOMClient from 'react-dom/client';
import { createRequire } from 'node:module';
import type { ProfileVar } from '@/hooks/useCloudAgentProfiles';
import { ProfileNetworkSecrets } from './ProfileNetworkSecrets';

type LinkedomModule = {
  parseHTML: (html: string) => { window: Window & typeof globalThis; document: Document };
};

function networkVar(key: string): ProfileVar {
  return {
    key,
    value: '',
    isSecret: true,
    delivery: 'network',
    allowedHosts: ['example.com'],
    createdAt: '',
    updatedAt: '',
  };
}

function setupEditor() {
  const requireFromNext = createRequire(require.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body></body></html>'
  );
  document.oninput = null;
  const globals = { React, window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const previousGlobals = Object.fromEntries(
    Object.keys(globals).map(key => [key, Reflect.get(globalThis, key)])
  );
  Object.assign(globalThis, globals);
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = jest.requireActual<typeof ReactDOMClient>('react-dom/client');
  const root = createRoot(container);
  const deleteVar = jest.fn(async () => ({ success: true }));
  const setVar = jest.fn(async () => ({ success: true }));
  const mutations: ComponentProps<typeof ProfileNetworkSecrets>['mutations'] = {
    deleteVar: { mutateAsync: deleteVar },
    setVar: { mutateAsync: setVar },
  };

  const render = (vars: ProfileVar[]) =>
    act(() =>
      root.render(
        createElement(ProfileNetworkSecrets, {
          profileId: 'test-profile',
          vars,
          mutations,
          readOnly: false,
        })
      )
    );
  const click = (label: string, within: ParentNode = container) =>
    act(async () => {
      const button = Array.from(within.querySelectorAll('button')).find(
        element => element.textContent === label
      );
      if (!button) throw new Error(`Missing button: ${label}`);
      button.click();
    });

  const fill = (placeholder: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    if (!input) throw new Error(`Missing input: ${placeholder}`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Missing input value setter');
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };

  const cleanup = () => {
    act(() => root.unmount());
    Object.assign(globalThis, previousGlobals);
  };

  return { container, render, click, fill, setVar, deleteVar, cleanup };
}

it('replaces the value and allowed domains with one mutation when editing a network secret', async () => {
  const { render, click, fill, setVar, cleanup } = setupEditor();
  try {
    render([networkVar('ORIGINAL_TOKEN')]);
    await click('Edit');
    fill('Enter new hidden value', 'synthetic-replacement');
    fill('sentry.io, us.sentry.io', 'example.com, example.org');
    await click('Save');

    expect(setVar.mock.calls).toEqual([
      [
        {
          profileId: 'test-profile',
          organizationId: undefined,
          key: 'ORIGINAL_TOKEN',
          value: 'synthetic-replacement',
          isSecret: true,
          networkSecret: { allowedHosts: ['example.com', 'example.org'], locations: ['header'] },
        },
      ],
    ]);
  } finally {
    cleanup();
  }
});

it('only deletes the selected network secret when the profile refetches during confirmation', async () => {
  const { container, render, click, deleteVar, cleanup } = setupEditor();
  try {
    const original = networkVar('ORIGINAL_TOKEN');
    render([original]);
    await click('Delete');
    expect(deleteVar).not.toHaveBeenCalled();
    render([networkVar('NEW_TOKEN'), original]);
    const row = Array.from(container.querySelectorAll('code')).find(
      code => code.textContent === original.key
    )?.parentElement?.parentElement;
    if (!row) throw new Error('Missing original secret row');
    await click('Confirm', row);

    expect(deleteVar.mock.calls).toEqual([
      [{ profileId: 'test-profile', organizationId: undefined, key: 'ORIGINAL_TOKEN' }],
    ]);
  } finally {
    cleanup();
  }
});
