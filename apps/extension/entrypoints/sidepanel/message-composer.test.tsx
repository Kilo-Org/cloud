/* eslint-disable capitalized-comments, id-length, init-declarations, jest/no-hooks, jest/no-untyped-mock-factory, jest/no-conditional-expect, jest/no-conditional-in-test, max-lines, no-unused-expressions, sort-keys, vitest/prefer-import-in-mock, vitest/prefer-called-times -- test fixture constraints */
/* eslint-disable import/first */
// @vitest-environment jsdom

import { createElement } from 'react';
import { Provider, createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { queuedMessageAtomFamily } from './agent-chat-atoms';
import { MessageComposer } from './message-composer';

const renderComposer = (
  store: ReturnType<typeof createStore>,
  props: {
    readonly isRunning: boolean;
    readonly onSubmit?: () => void;
  }
) =>
  render(
    createElement(
      Provider,
      { store },
      createElement(MessageComposer, {
        activeConversationId: 'conversation-1',
        canSend: true,
        isRunning: props.isRunning,
        onStop: vi.fn(),
        onSubmit: props.onSubmit ?? vi.fn(),
      })
    )
  );

describe('message composer queue', () => {
  it('shows Stop and the queueing placeholder while a run is active', () => {
    const store = createStore();
    const { getByLabelText, getByRole } = renderComposer(store, { isRunning: true });

    expect(getByRole('button', { name: 'Stop' })).toBeDefined();
    const textarea = getByLabelText('Message agent');
    if (textarea instanceof HTMLTextAreaElement) {
      expect(textarea.placeholder).toBe('Queue a message for the next turn...');
    }
  });

  it('calls onSubmit when Enter is pressed during a run', () => {
    const store = createStore();
    const onSubmit = vi.fn();
    const { getByLabelText } = renderComposer(store, { isRunning: true, onSubmit });

    const textarea = getByLabelText('Message agent');
    fireEvent.change(textarea, { target: { value: 'queued text' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('renders and cancels a queued message', () => {
    const store = createStore();
    store.set(queuedMessageAtomFamily('conversation-1'), 'queued text');
    const { getByRole, getByText } = renderComposer(store, { isRunning: true });

    expect(getByText('Queued: queued text')).toBeDefined();
    const cancelButton = getByRole('button', { name: 'Cancel queued message' });
    if (cancelButton instanceof HTMLButtonElement) {
      cancelButton.click();
    }

    expect(store.get(queuedMessageAtomFamily('conversation-1'))).toBeUndefined();
  });

  it('disables Send message when the draft is empty and no run is active', () => {
    const store = createStore();
    const { getByRole } = renderComposer(store, { isRunning: false });

    const sendButton = getByRole('button', { name: 'Send message' });
    if (sendButton instanceof HTMLButtonElement) {
      expect(sendButton.disabled).toBe(true);
    }
  });
});
