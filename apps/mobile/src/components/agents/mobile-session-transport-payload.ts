import { type TransportSendPayload } from 'cloud-agent-sdk';

import { normalizeAgentMode } from '@/components/agents/mode-options';
import { type SendMessagePayload } from '@/lib/cloud-agent-next/types';

/**
 * Normalize a transport send payload into the wire `SendMessagePayload`.
 *
 * Kept in its own module (rather than alongside `buildRemoteAttachmentParts`)
 * because it depends on `mode-options`, which transitively pulls in React
 * Native / Expo modules. Isolating it keeps the attachment helper importable
 * from the Node-based unit test environment.
 */
export function normalizeTransportPayload(payload: TransportSendPayload): SendMessagePayload {
  if (payload.type === 'prompt') {
    if (!payload.model) {
      throw new Error('Model is required');
    }
    if (payload.model.providerID !== 'kilo') {
      throw new Error('Cloud Agent only supports Kilo models');
    }

    return {
      type: 'prompt',
      prompt: payload.prompt,
      mode: normalizeAgentMode(payload.mode),
      model: payload.model.modelID,
      variant: payload.variant,
    };
  }

  return {
    type: 'command',
    command: payload.command,
    arguments: payload.arguments,
  };
}
