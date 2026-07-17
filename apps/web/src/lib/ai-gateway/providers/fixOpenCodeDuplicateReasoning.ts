import { ReasoningDetailType } from '@/lib/ai-gateway/custom-llm/reasoning-details';
import { isClaudeModel } from '@/lib/ai-gateway/providers/anthropic.constants';
import type {
  MessageWithReasoning,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';

export function fixOpenCodeDuplicateReasoning(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  sessionId: string | undefined
) {
  // workaround for @openrouter/ai-sdk-provider v1 duplicating reasoning
  // possibly fixed in https://github.com/OpenRouterTeam/ai-sdk-provider/pull/344/
  let requestMutated = false;
  for (const msg of request.messages) {
    const msgWithReasoning = msg as MessageWithReasoning;
    if (!msgWithReasoning.reasoning_details) {
      continue;
    }
    const encryptedDataSet = new Set<string>();
    const textSet = new Set<string>();
    const signatureSet = new Set<string>();
    msgWithReasoning.reasoning_details = msgWithReasoning.reasoning_details.filter(rd => {
      if (rd.type === ReasoningDetailType.Encrypted && rd.data) {
        if (!encryptedDataSet.has(rd.data)) {
          encryptedDataSet.add(rd.data);
          return true;
        }
        requestMutated = true;
        return false;
      }
      if (rd.type === ReasoningDetailType.Text) {
        if (isClaudeModel(requestedModel) && !rd.signature) {
          requestMutated = true;
          return false;
        }
        if (rd.signature) {
          if (signatureSet.has(rd.signature)) {
            requestMutated = true;
            return false;
          }
          signatureSet.add(rd.signature);
        }
        if (rd.text) {
          if (textSet.has(rd.text)) {
            requestMutated = true;
            return false;
          }
          textSet.add(rd.text);
        }
        return true;
      }
      return true;
    });
  }
  if (requestMutated) {
    console.debug(
      `[fixOpenCodeDuplicateReasoning] removed duplicate or invalid reasoning, model: ${requestedModel}, session: ${sessionId || 'unknown'}`
    );
  }
}
