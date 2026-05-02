import { KiloChatApiError } from '@kilocode/kilo-chat';

type ConversationRouteDetailState = {
  data: { title: string | null } | null | undefined;
  isError: boolean;
};

type RenderableConversationRouteDetailState = ConversationRouteDetailState & {
  data: { title: string | null };
  isError: false;
};

export function getConversationRouteErrorMessage(error: unknown): string {
  const status = error instanceof KiloChatApiError ? error.status : undefined;
  if (status === 400 || status === 403 || status === 404) {
    return 'Conversation not found';
  }
  return 'Failed to load conversation';
}

export function shouldRenderConversationScreen(
  detail: ConversationRouteDetailState
): detail is RenderableConversationRouteDetailState {
  return !detail.isError && detail.data !== null && detail.data !== undefined;
}
