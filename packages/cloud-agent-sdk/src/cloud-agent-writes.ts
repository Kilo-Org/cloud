import type {
  CloudAgentApi,
  CloudAgentSendPayload,
  Transport,
  TransportSendPayload,
} from './transport';
import type { CloudAgentSessionId } from './types';

function cloudPayload(payload: TransportSendPayload): CloudAgentSendPayload {
  if (payload.type === 'command') {
    if (payload.model && payload.model.providerID !== 'kilo')
      throw new Error('Cloud Agent only supports Kilo models');
    return {
      type: 'command',
      command: payload.command,
      arguments: payload.arguments,
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(payload.model ? { model: payload.model.modelID } : {}),
      ...(payload.variant ? { variant: payload.variant } : {}),
    };
  }
  if (!payload.mode) throw new Error('Cloud Agent mode is required');
  if (!payload.model) throw new Error('Cloud Agent model is required');
  if (payload.model.providerID !== 'kilo') throw new Error('Cloud Agent only supports Kilo models');
  return {
    type: 'prompt',
    prompt: payload.prompt,
    mode: payload.mode,
    model: payload.model.modelID,
    ...(payload.variant ? { variant: payload.variant } : {}),
  };
}

export function createCloudAgentWrites(
  api: CloudAgentApi,
  sessionId: CloudAgentSessionId,
  run: <T>(mutation: () => Promise<T>) => Promise<T>
): Pick<
  Transport,
  'send' | 'interrupt' | 'dropQueuedMessage' | 'answer' | 'reject' | 'respondToPermission'
> {
  return {
    send(input) {
      if (!input.messageId) throw new Error('Cloud Agent sends require a client message id');
      const messageId = input.messageId;
      return run(() =>
        api.send({
          sessionId,
          messageId,
          payload: cloudPayload(input.payload),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        })
      );
    },
    interrupt: () => run(() => api.interrupt({ sessionId })),
    async dropQueuedMessage(messageId) {
      const cancel = api.cancelQueuedMessage;
      if (!cancel) throw new Error('Cloud Agent cancel queued message is not configured');
      return run(() => cancel({ sessionId, messageId }));
    },
    answer: payload => run(() => api.answer({ sessionId, ...payload })),
    reject: payload => run(() => api.reject({ sessionId, ...payload })),
    respondToPermission: payload => run(() => api.respondToPermission({ sessionId, ...payload })),
  };
}
