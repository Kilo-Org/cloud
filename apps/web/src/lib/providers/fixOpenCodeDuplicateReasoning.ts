import { ReasoningDetailType } from '@/lib/ai-gateway/custom-llm/reasoning-details';
import { isAnthropicModel } from '@/lib/providers/anthropic';
import type {
  MessageWithReasoning,
  OpenRouterChatCompletionRequest,
} from '@/lib/providers/openrouter/types';

export function fixOpenCodeDuplicateReasoning(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  sessionId: string | undefined
) {
  // workaround for @openrouter/ai-sdk-provider v1 duplicating reasoning
  // possibly fixed in https://github.com/OpenRouterTeam/ai-sdk-provider/pull/344/
  console.debug(
    `[fixOpenCodeDuplicateReasoning] start, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
  );
  for (const msg of request.messages) {
    const msgWithReasoning = msg as MessageWithReasoning;
    if (!msgWithReasoning.reasoning_details) {
      continue;
    }
    const encryptedDataSet = new Set<string>();
    const textSet = new Set<string>();
    msgWithReasoning.reasoning_details = msgWithReasoning.reasoning_details.filter(rd => {
      if (rd.type === ReasoningDetailType.Encrypted && rd.data) {
        if (!encryptedDataSet.has(rd.data)) {
          encryptedDataSet.add(rd.data);
          return true;
        }
        console.debug(
          `[fixOpenCodeDuplicateReasoning] removing duplicated encrypted reasoning, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
        );
        return false;
      }
      if (rd.type === ReasoningDetailType.Text && rd.text) {
        if (isAnthropicModel(requestedModel) && !rd.signature) {
          console.debug(
            `[fixOpenCodeDuplicateReasoning] removing reasoning text without signature, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
          );
          return false;
        }
        if (!textSet.has(rd.text)) {
          textSet.add(rd.text);
          return true;
        }
        console.debug(
          `[fixOpenCodeDuplicateReasoning] removing duplicated reasoning text, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
        );
        return false;
      }
      return true;
    });
  }
}
