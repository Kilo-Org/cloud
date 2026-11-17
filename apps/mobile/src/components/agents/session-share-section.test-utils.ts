import { act, TestRenderer } from '@/test/renderer';
import { createElement } from 'react';
import { vi } from 'vitest';

import {
  holder,
  type ShareCreated,
  type ShareQueryState,
  type ShareRefetchResult,
} from './session-share-section.test-helpers';
import { SessionShareSection } from './session-share-section';

export type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

export type Deferred<T> = PromiseWithResolvers<T>;

const DEFAULT_CREATED: ShareCreated = { share_token: 'tok_1', public_id: 'share_1' };

export function renderSection(visible = true): Renderer {
  const ref: { current: Renderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionShareSection, { sessionId: 'ses-123', visible })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

export function rerenderSection(renderer: Renderer, visible = true, sessionId = 'ses-123'): void {
  act(() => {
    renderer.update(createElement(SessionShareSection, { sessionId, visible }));
  });
}

export function unmountSection(renderer: Renderer): void {
  act(() => {
    renderer.unmount();
  });
}

export function findByTestID(root: Instance, testID: string): Instance[] {
  return root.findAll(node => node.props.testID === testID);
}

export function findOne(renderer: Renderer, testID: string): Instance {
  const [node] = findByTestID(renderer.root, testID);
  if (!node) {
    throw new Error(`missing ${testID}`);
  }
  return node;
}

export function textContent(root: Instance): string[] {
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    )
    .filter(child => child.length > 0);
}

/** Replaces the session read the section sees, from its next render on. */
export function setReadState(state: Partial<ShareQueryState>): void {
  holder.queryState = { ...holder.queryState, ...state };
}

/** Starts the create the way its button does, so `onMutate` captures its owner. */
export function pressAction(button: Instance): void {
  act(() => {
    (button.props.onPress as () => void)();
  });
}

/** Takes the owner a create would capture if it started at this moment. */
export function beginShare(): void {
  const onMutate = holder.shareOnMutate;
  if (onMutate === null) {
    throw new Error('the share mutation was not registered');
  }
  holder.shareContext = onMutate();
}

async function flushOnce(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await flushOnce();
  await flushOnce();
  await flushOnce();
  await flushOnce();
}

export async function pressAndSettle(button: Instance): Promise<void> {
  pressAction(button);
  await settle();
}

/** A press-time read that stays in flight until the test releases it. */
export function deferIdentityRead(): Deferred<ShareRefetchResult> {
  const read = Promise.withResolvers<ShareRefetchResult>();
  setReadState({
    refetch: options => {
      holder.refetchCalls.push(options);
      return read.promise;
    },
  });
  return read;
}

export async function resolveIdentityRead(
  read: Deferred<ShareRefetchResult>,
  result: ShareRefetchResult
): Promise<void> {
  read.resolve(result);
  await settle();
}

export async function rejectIdentityRead(read: Deferred<ShareRefetchResult>): Promise<void> {
  read.reject(new Error('read failed'));
  await settle();
}

/** Completes the create the test started with `pressAction` on Create or Replace. */
export async function finishShare(created: ShareCreated = DEFAULT_CREATED): Promise<void> {
  const success = holder.shareSuccess;
  if (success === null) {
    throw new Error('the share mutation was not registered');
  }
  await act(async () => {
    await success(created, holder.lastShareInput, holder.shareContext);
    await vi.dynamicImportSettled();
    await Promise.resolve();
  });
}

/** Renders the sheet with a live link, then makes the create it presses publish. */
export async function renderCreatedLink(
  created: ShareCreated = DEFAULT_CREATED
): Promise<Renderer> {
  setReadState({ data: { public_id: 'share_1' }, isPending: false, dataUpdatedAt: 1 });
  const renderer = renderSection();
  pressAction(findOne(renderer, 'session-share-rotate'));
  await finishShare(created);
  return renderer;
}

export function failShare(error: unknown): void {
  const failure = holder.shareError;
  if (failure === null) {
    throw new Error('the share mutation was not registered');
  }
  act(() => {
    failure(error, holder.lastShareInput, holder.shareContext);
  });
}

/** Confirms the revoke the section asked about, as the native sheet would. */
export function confirmRevoke(): void {
  const config = holder.confirm;
  if (config === null) {
    throw new Error('the section asked for no confirmation');
  }
  act(() => {
    config.onConfirm();
  });
}
