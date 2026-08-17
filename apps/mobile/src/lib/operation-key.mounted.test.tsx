/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
// Mounted tests for `useHoistedOperationKey` (P1-A-08c): one stable key per
// unchanged intent fingerprint, rotated when the fingerprint changes or when
// `rotateKey()` ends the intent.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';

import { useHoistedOperationKey } from './operation-key';

vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `uuid-${n}`;
    },
  };
});

type LedgerApi = ReturnType<typeof useHoistedOperationKey>;

function KeyHarness({ onRender }: { onRender: (api: LedgerApi) => void }) {
  onRender(useHoistedOperationKey());
  return null;
}

function mountHarness(): { renderer: TestRenderer.ReactTestRenderer; api: LedgerApi } {
  // Refs, not `let`: TypeScript cannot narrow a binding assigned inside the
  // `act` callback, so a plain local would read as always-undefined.
  const held: { renderer?: TestRenderer.ReactTestRenderer; api?: LedgerApi } = {};
  act(() => {
    held.renderer = TestRenderer.create(
      createElement(KeyHarness, {
        onRender: value => {
          held.api = value;
        },
      })
    );
  });
  const { renderer, api } = held;
  if (!renderer || !api) {
    throw new Error('key harness did not render');
  }
  return { renderer, api };
}

test('keeps one key per intent fingerprint and rotates when the fingerprint changes', () => {
  const { renderer, api } = mountHarness();

  // Retries of the same intent (same body) reuse the key.
  const original = api.getKey('fp-body-nit');
  expect(api.getKey('fp-body-nit')).toBe(original);

  // The user edits the body before retrying: a fresh intent needs a fresh key,
  // which must then stay stable for its own retries.
  const edited = api.getKey('fp-body-nit-v2');
  expect(edited).not.toBe(original);
  expect(api.getKey('fp-body-nit-v2')).toBe(edited);

  renderer.unmount();
});

test('regenerates the key on rotate so the next submit is a fresh intent', () => {
  const { renderer, api } = mountHarness();

  const first = api.getKey('fp-comment-v1');
  api.rotateKey();
  const second = api.getKey('fp-comment-v1');

  expect(second).not.toBe(first);
  expect(api.getKey('fp-comment-v1')).toBe(second);

  renderer.unmount();
});

test('each mount holds its own key, never a module-level shared one', () => {
  const firstMount = mountHarness();
  const secondMount = mountHarness();

  expect(secondMount.api.getKey('fp-x')).not.toBe(firstMount.api.getKey('fp-x'));

  firstMount.renderer.unmount();
  secondMount.renderer.unmount();
});
