import { logger } from '../logger.js';
import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
} from '@kilocode/session-ingest-contracts';

export type IngestItem = { type: string; data: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function ingestKiloSessionId(
  _type: string,
  properties: Record<string, unknown>
): string | undefined {
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  if (typeof properties.sessionId === 'string') return properties.sessionId;
  if (isRecord(properties.info)) {
    if (typeof properties.info.sessionID === 'string') return properties.info.sessionID;
    if (typeof properties.info.id === 'string') return properties.info.id;
  }
  if (isRecord(properties.part) && typeof properties.part.sessionID === 'string') {
    return properties.part.sessionID;
  }
  return undefined;
}

export function controlEventToIngestItems(
  type: string,
  properties: Record<string, unknown>
): IngestItem[] {
  if (type === 'message.updated' && isRecord(properties.info)) {
    return [{ type: 'message', data: properties.info }];
  }
  if (type === 'message.part.updated' && isRecord(properties.part)) {
    return [{ type: 'part', data: properties.part }];
  }
  if ((type === 'session.updated' || type === 'session.created') && isRecord(properties.info)) {
    return [{ type: 'session', data: properties.info }];
  }
  return [];
}

export async function publishControlPlaneSessionIngest(params: {
  fetchIngest: (request: Request) => Promise<Response>;
  token: string;
  rootKiloSessionId: string;
  eventKiloSessionId?: string;
  cloudAgentSessionId: string;
  internalSecret?: string;
  items: IngestItem[];
}): Promise<void> {
  if (params.items.length === 0) return;
  const eventKiloSessionId = params.eventKiloSessionId ?? params.rootKiloSessionId;
  const isChild = eventKiloSessionId !== params.rootKiloSessionId;
  if (isChild && !params.internalSecret) {
    logger
      .withFields({
        rootKiloSessionId: params.rootKiloSessionId,
        eventKiloSessionId,
      })
      .warn('Control-plane child session ingest skipped; internal secret unavailable');
    return;
  }

  const headers = new Headers({
    Authorization: `Bearer ${params.token}`,
    'Content-Type': 'application/json',
  });
  if (isChild) {
    headers.set('X-Internal-Secret', params.internalSecret ?? '');
    headers.set(cloudAgentSessionScopeHeaders.cloudAgentSessionId, params.cloudAgentSessionId);
    headers.set(cloudAgentSessionScopeHeaders.rootKiloSessionId, params.rootKiloSessionId);
    headers.set(
      cloudAgentSessionScopeHeaders.protocolVersion,
      cloudAgentSessionScopeProtocolVersion
    );
  }

  const body = JSON.stringify({ data: params.items });
  const ingestUrl = isChild
    ? `https://session-ingest/internal/cloud-agent/v1/session/${encodeURIComponent(eventKiloSessionId)}/ingest?v=2`
    : `https://session-ingest/api/session/${encodeURIComponent(params.rootKiloSessionId)}/ingest?v=2`;
  try {
    if (isChild) {
      const createResponse = await params.fetchIngest(
        new Request('https://session-ingest/internal/cloud-agent/v1/session', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sessionId: eventKiloSessionId }),
        })
      );
      if (!createResponse.ok) {
        logger
          .withFields({
            rootKiloSessionId: params.rootKiloSessionId,
            eventKiloSessionId,
            status: createResponse.status,
          })
          .warn('Control-plane child session creation failed');
        return;
      }
    }

    const response = await params.fetchIngest(
      new Request(ingestUrl, {
        method: 'POST',
        headers,
        body,
      })
    );
    if (!response.ok) {
      logger
        .withFields({
          rootKiloSessionId: params.rootKiloSessionId,
          eventKiloSessionId,
          status: response.status,
          itemTypes: params.items.map(item => item.type),
        })
        .warn('Control-plane session ingest publish failed');
    }
  } catch {
    logger
      .withFields({
        rootKiloSessionId: params.rootKiloSessionId,
        eventKiloSessionId,
        itemTypes: params.items.map(item => item.type),
      })
      .warn('Control-plane session ingest publish failed');
  }
}
