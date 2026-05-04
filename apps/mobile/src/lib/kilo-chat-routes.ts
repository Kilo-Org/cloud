import { type Href } from 'expo-router';

const KILOCLAW_TAB_CHAT_ROOT = '/(app)/(tabs)/(1_kiloclaw)/chat';

export function chatSandboxRoute(sandboxId: string): string {
  return `${KILOCLAW_TAB_CHAT_ROOT}/${sandboxId}`;
}

export function chatConversationRoute(sandboxId: string, conversationId: string): string {
  return `${KILOCLAW_TAB_CHAT_ROOT}/${sandboxId}/${conversationId}`;
}

export function chatSandboxPath(sandboxId: string): Href {
  return chatSandboxRoute(sandboxId) as Href;
}

export function chatConversationPath(sandboxId: string, conversationId: string): Href {
  return chatConversationRoute(sandboxId, conversationId) as Href;
}

export function chatRenameConversationPath(sandboxId: string, params: URLSearchParams): Href {
  const renameParams = new URLSearchParams(params);
  renameParams.set('sandboxId', sandboxId);
  return `/(app)/(tabs)/(1_kiloclaw)/rename-conversation?${renameParams.toString()}` as Href;
}

export function chatInstancePickerPath(currentId: string): Href {
  return `${KILOCLAW_TAB_CHAT_ROOT}/instance-picker?currentId=${currentId}` as Href;
}
