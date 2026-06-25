'use client';

import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';
import { askUsageMessageRenderPolicy } from './rendering/ask-usage-message-policy';

export function AskUsageChat() {
  return (
    <CloudChatPage
      chrome="focused"
      title="Ask Usage"
      placeholder="Ask a usage question..."
      composer={{
        attachments: false,
        slashCommands: false,
        modePicker: false,
      }}
      messageRenderPolicy={askUsageMessageRenderPolicy}
    />
  );
}
