import * as React from 'react';
import { ChatGptUsageLinkView } from '@/components/chatgpt/ChatGptUsageLinkView';
import { CredentialKmsError } from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import { getOpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';

/**
 * The usage-page link, which renders only for a live connection. It reads the
 * connection on the server, so the action is never shown to a person whose
 * requests do not use the plan.
 */
export async function ChatGptUsageLink({ kiloUserId }: { kiloUserId: string }) {
  // A payload the KMS service cannot open hides the link instead of failing the page.
  const connection = await getOpenAiChatGptConnection({
    kiloUserId,
    organizationId: null,
  }).catch((error: unknown) => {
    if (error instanceof CredentialKmsError) return null;
    throw error;
  });
  if (connection?.status !== 'connected') return null;

  return <ChatGptUsageLinkView />;
}
