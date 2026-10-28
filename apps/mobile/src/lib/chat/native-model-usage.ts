import { type NativeAvailability, type NativeModelBridge } from './native-model-client';
import { type NativeRequest } from './native-request';

export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export async function inputTokensOf(
  bridge: NativeModelBridge,
  availability: NativeAvailability,
  request: NativeRequest
): Promise<number> {
  if (bridge.countTokens !== undefined && availability.tokenCounting !== false) {
    try {
      return await bridge.countTokens(request);
    } catch {
      // Token accounting must not fail a completed answer.
    }
  }
  let characters = request.system.length;
  for (const message of request.messages) {
    if (message.role === 'toolCalls') {
      for (const call of message.calls) {
        characters += call.name.length + call.arguments.length;
      }
    } else {
      characters += message.text.length;
    }
  }
  return Math.ceil(characters / 3);
}
