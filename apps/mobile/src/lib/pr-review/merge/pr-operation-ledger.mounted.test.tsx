/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
// Mounted tests for `useHoistedOperationKey` (P1-A-08c): the hook must
// return one stable key per unchanged user intent across retries, rotate the
// key the moment an intent input changes (the caller passes an intent
// fingerprint), and regenerate the key for the next fresh intent on
// `rotateKey()`.

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';

import { useHoistedOperationKey } from './pr-operation-ledger';

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

async function mountHarness(): Promise<{
  renderer: TestRenderer.ReactTestRenderer;
  api: LedgerApi;
}> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  const apiRef: { current: LedgerApi | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(KeyHarness, {
        onRender: value => {
          apiRef.current = value;
        },
      })
    );
  });
  const renderer = rendererRef.current;
  const api = apiRef.current;
  if (!renderer || !api) {
    throw new Error('key harness did not render');
  }
  return { renderer, api };
}

test('returns a stable key across retries of the same intent fingerprint', async () => {
  const { renderer, api } = await mountHarness();

  const first = api.getKey('fp-comment-v1');
  expect(api.getKey('fp-comment-v1')).toBe(first);
  expect(api.getKey('fp-comment-v1')).toBe(first);

  renderer.unmount();
});

test('rotates the key when an intent input changes (changed input after retry)', async () => {
  const { renderer, api } = await mountHarness();

  // First submit: body "nit". Fails retryably; the retry keeps the key.
  const original = api.getKey('fp-body-nit');
  expect(api.getKey('fp-body-nit')).toBe(original);

  // The user edits the comment body before retrying → a FRESH intent, so the
  // key MUST rotate (the old key must never replay the old intent's result).
  const edited = api.getKey('fp-body-nit-v2');
  expect(edited).not.toBe(original);

  // Retry of the edited body keeps the edited key.
  expect(api.getKey('fp-body-nit-v2')).toBe(edited);

  renderer.unmount();
});

test('rotates the key on a different review contents fingerprint and keeps it for that fingerprint', async () => {
  const { renderer, api } = await mountHarness();

  const approve = api.getKey('fp-event-APPROVE');
  expect(api.getKey('fp-event-APPROVE')).toBe(approve);

  // Changing the review event to REQUEST_CHANGES is a new intent.
  const changes = api.getKey('fp-event-REQUEST_CHANGES');
  expect(changes).not.toBe(approve);
  expect(api.getKey('fp-event-REQUEST_CHANGES')).toBe(changes);

  // A different merge message is a new intent too.
  const mergeV1 = api.getKey('fp-message-v1');
  const mergeV2 = api.getKey('fp-message-v2');
  expect(mergeV1).not.toBe(approve);
  expect(mergeV2).not.toBe(mergeV1);

  renderer.unmount();
});

test('regenerates the key on rotate so the next submit is a fresh intent', async () => {
  const { renderer, api } = await mountHarness();

  const first = api.getKey('fp-comment-v1');
  api.rotateKey();
  const second = api.getKey('fp-comment-v1');

  expect(second).not.toBe(first);
  expect(api.getKey('fp-comment-v1')).toBe(second);

  renderer.unmount();
});

test('a fresh mount (new intent) uses a different key than the previous mount', async () => {
  const firstMount = await mountHarness();
  const secondMount = await mountHarness();

  expect(secondMount.api.getKey('fp-x')).not.toBe(firstMount.api.getKey('fp-x'));

  firstMount.renderer.unmount();
  secondMount.renderer.unmount();
});
