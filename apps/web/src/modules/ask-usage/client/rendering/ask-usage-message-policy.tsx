'use client';

import type { MessageRenderPolicy } from '@/components/cloud-agent-next/message-render-policy';
import { AskUsageDatasetToolCard } from './AskUsageDatasetToolCard';
import { isAskUsageDatasetQueryTool } from './dataset-tool-view';
import { stripLeakedToolMarkup } from './strip-leaked-tool-markup';

export const askUsageMessageRenderPolicy = {
  transformAssistantText: stripLeakedToolMarkup,
  renderToolPart(part) {
    if (!isAskUsageDatasetQueryTool(part)) return { handled: false };
    return {
      handled: true,
      node: <AskUsageDatasetToolCard toolPart={part} />,
    };
  },
} satisfies MessageRenderPolicy;
