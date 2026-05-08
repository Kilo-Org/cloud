/**
 * V1 Messages Module
 *
 * Legacy V1 App Builder sessions are read-only. The only mutations the client
 * performs are for the optimistic user message that is immediately swapped out
 * when the backend upgrades the session to cloud-agent-next.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import type { Images } from '@/lib/images-schema';
import type { V1SessionStore } from './store';

export function addUserMessage(store: V1SessionStore, content: string, images?: Images): void {
  const userMessage: CloudMessage = {
    ts: Date.now(),
    type: 'user',
    text: content,
    partial: false,
    images,
  };
  store.setState({ messages: [...store.getState().messages, userMessage] });
}

/**
 * Removes the last user message from the store.
 * Used when the backend upgrades a legacy v1 session to cloud-agent-next — the
 * optimistic user message is moved to the new session so the old one stays clean.
 */
export function removeLastUserMessage(store: V1SessionStore): void {
  const messages = store.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'user') {
      const newMessages = [...messages];
      newMessages.splice(i, 1);
      store.setState({ messages: newMessages });
      return;
    }
  }
}

export function addErrorMessage(store: V1SessionStore, error: string): void {
  const errorMessage: CloudMessage = {
    ts: Date.now(),
    type: 'system',
    say: 'error',
    text: error,
    partial: false,
  };
  store.setState({ messages: [...store.getState().messages, errorMessage] });
}
