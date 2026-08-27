/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as use-list-directories.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useLaunchFolder } from './use-launch-folder';

function Harness({
  connectionId,
  onRender,
}: {
  connectionId: string | undefined;
  onRender: (api: readonly [string, (next: string) => void]) => void;
}) {
  const api = useLaunchFolder(connectionId);
  onRender(api);
  return null;
}

function mount(connectionId: string | undefined): {
  latest: () => readonly [string, (next: string) => void];
  rerender: (next: string | undefined) => void;
  unmount: () => void;
} {
  let current: readonly [string, (next: string) => void] | undefined = undefined;
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(Harness, {
        connectionId,
        onRender: api => {
          current = api;
        },
      })
    );
  });
  return {
    latest: () => {
      if (!current) {
        throw new Error('hook has not rendered yet');
      }
      return current;
    },
    rerender: next => {
      act(() => {
        renderer?.update(
          createElement(Harness, {
            connectionId: next,
            onRender: api => {
              current = api;
            },
          })
        );
      });
    },
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

describe('useLaunchFolder', () => {
  it('starts at the launch directory (empty path)', () => {
    const { latest, unmount } = mount('conn-1');
    expect(latest()[0]).toBe('');
    unmount();
  });

  it('keeps a confirmed folder while the connection is unchanged', () => {
    const { latest, unmount } = mount('conn-1');
    act(() => {
      latest()[1]('src/app');
    });
    expect(latest()[0]).toBe('src/app');
    unmount();
  });

  it('resets to the launch directory when the connection changes', () => {
    const { latest, rerender, unmount } = mount('conn-1');
    act(() => {
      latest()[1]('src/app');
    });
    expect(latest()[0]).toBe('src/app');

    rerender('conn-2');
    expect(latest()[0]).toBe('');
    unmount();
  });
});
