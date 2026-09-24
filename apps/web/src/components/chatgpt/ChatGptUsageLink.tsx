import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { OpenAILogo } from '@/components/auth/OpenAILogo';
import { Button } from '@/components/ui/button';
import { getOpenAiChatGptConnection } from '@/lib/ai-gateway/openai-chatgpt/store';
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';

/**
 * The usage link from the "Sign in with ChatGPT" partner guidelines: a "Manage
 * usage" action that opens the person's ChatGPT usage settings, where the plan
 * allowance and its reset time live.
 */
export const USAGE_LINK_SUMMARY = 'View and manage your ChatGPT usage';
const MANAGE_USAGE_LABEL = 'Manage usage';

/**
 * The link without the connection read, so both surfaces that already know the
 * connection is live can render it: the usage page through `ChatGptUsageLink`
 * below, and the BYOK card in its connected state.
 */
export function ChatGptUsageLinkView() {
  return (
    <div className="border-border flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <OpenAILogo className="size-5" />
        <span className="type-body text-foreground">{USAGE_LINK_SUMMARY}</span>
      </div>
      <Button asChild size="sm">
        <a href={CHATGPT_USAGE_SETTINGS_URL} target="_blank" rel="noreferrer noopener">
          {MANAGE_USAGE_LABEL}
          <ExternalLink aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}

/**
 * It renders only for a live connection. It reads the connection on the server
 * so the action is never shown to a person whose requests do not use the plan.
 */
export async function ChatGptUsageLink({ kiloUserId }: { kiloUserId: string }) {
  const connection = await getOpenAiChatGptConnection({
    kiloUserId,
    organizationId: null,
  });
  if (connection?.status !== 'connected') return null;

  return <ChatGptUsageLinkView />;
}
