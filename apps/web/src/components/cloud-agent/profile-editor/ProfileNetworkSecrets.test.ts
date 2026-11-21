import React, { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { ProfileVar } from '@/hooks/useCloudAgentProfiles';
import { ProfileNetworkSecrets } from './ProfileNetworkSecrets';

type LinkedomModule = {
  parseHTML: (html: string) => { window: Window; document: Document };
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

it('only deletes the selected network secret when the profile refetches during an edit', async () => {
  const requireFromNext = createRequire(require.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body></body></html>'
  );
  const globals = { React, window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const previousGlobals = Object.fromEntries(
    Object.keys(globals).map(key => [key, Reflect.get(globalThis, key)])
  );
  Object.assign(globalThis, globals);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const deleteVar = jest.fn(async () => ({ success: true }));
  const mutations: ComponentProps<typeof ProfileNetworkSecrets>['mutations'] = {
    deleteVar: { mutateAsync: deleteVar },
    setVar: { mutateAsync: jest.fn(async () => ({ success: true })) },
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
  const click = (label: string) =>
    act(async () => {
      const button = Array.from(container.querySelectorAll('button')).find(
        element => element.textContent === label
      );
      if (!button) throw new Error(`Missing button: ${label}`);
      button.click();
    });

  try {
    const original = networkVar('ORIGINAL_TOKEN');
    render([original]);
    await click('Delete');
    render([original, networkVar('NEW_TOKEN')]);
    await click('Save network secrets');

    expect(deleteVar.mock.calls).toEqual([
      [{ profileId: 'test-profile', organizationId: undefined, key: 'ORIGINAL_TOKEN' }],
    ]);
  } finally {
    act(() => root.unmount());
    Object.assign(globalThis, previousGlobals);
  }
});
