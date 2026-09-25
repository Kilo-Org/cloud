import * as React from 'react';
import { ChatGptUsageLinkView } from '@/components/chatgpt/ChatGptUsageLinkView';
import { getOpenAiChatGptConnection } from '@/lib/ai-gateway/openai-chatgpt/store';

/**
 * The usage-page link, which renders only for a live connection. It reads the
 * connection on the server, so the action is never shown to a person whose
 * requests do not use the plan.
 */
export async function ChatGptUsageLink({ kiloUserId }: { kiloUserId: string }) {
  const connection = await getOpenAiChatGptConnection({
    kiloUserId,
    organizationId: null,
  });
  if (connection?.status !== 'connected') return null;

  return <ChatGptUsageLinkView />;
}
