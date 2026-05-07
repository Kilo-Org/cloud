// Typing indicator wiring for the SDK's channel reply pipeline. Thin adapter
// around the KiloChatClient typing endpoints with console-warn error hooks.

import type { KiloChatClient } from '../client.js';

export function buildTypingParams(params: { client: KiloChatClient; conversationId: string }): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError: (err: unknown) => void;
} {
  return {
    start: () => params.client.sendTyping({ conversationId: params.conversationId }),
    stop: () => params.client.sendTypingStop({ conversationId: params.conversationId }),
    onStartError: err => console.warn('[kilo-chat] typing start failed:', err),
    onStopError: err => console.warn('[kilo-chat] typing stop failed:', err),
  };
}
