import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { RuntimeAuthorizationSchema } from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
  containedKiloSessionIdSchema,
  type CloudAgentChildSessionLineage,
} from '@kilocode/session-ingest-contracts';

export type IngestItem = { type: string; data: unknown };

const childSessionInfoSchema = z.object({
  id: containedKiloSessionIdSchema,
  parentID: containedKiloSessionIdSchema,
  directory: z.string().min(1),
});

export function childSessionLineage(
  info: unknown,
  directory: string
): CloudAgentChildSessionLineage | undefined {
  const parsed = childSessionInfoSchema.safeParse(info);
  if (
    !parsed.success ||
    parsed.data.id === parsed.data.parentID ||
    parsed.data.directory !== directory
  )
    return undefined;
  return { sessionId: parsed.data.id, parentSessionId: parsed.data.parentID };
}

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
  if (type === 'session.status' && isRecord(properties.status)) {
    const sessionId = properties.sessionID;
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      (typeof properties.sessionId === 'string' && properties.sessionId !== sessionId)
    ) {
      return [];
    }
    const status = properties.status.type;
    if (status === 'busy' || status === 'idle' || status === 'retry' || status === 'offline') {
      return [
        { type: 'session_status', data: { status: status === 'offline' ? 'retry' : status } },
      ];
    }
  }
  return [];
}

export async function publishControlPlaneSessionIngest(params: {
  fetchIngest: (request: Request) => Promise<Response>;
  token: string;
  rootKiloSessionId: string;
  eventKiloSessionId?: string;
  cloudAgentSessionId: string;
  directory?: string;
  internalSecret?: string;
  items: IngestItem[];
  // Supplied only by the owning DO, never from event payloads or JWT claims.
  runtimeContext?: {
    secret: string;
    userId: string;
    organizationId?: string;
    authorization: unknown;
    isCurrent: () => boolean;
  };
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

  let lineage: CloudAgentChildSessionLineage | undefined;
  if (isChild && params.directory) {
    for (const item of params.items) {
      if (
        item.type !== 'session' ||
        !isRecord(item.data) ||
        (!('parentID' in item.data) && !('directory' in item.data))
      )
        continue;
      const candidate = childSessionLineage(item.data, params.directory);
      if (!candidate || candidate.sessionId !== eventKiloSessionId) return;
      if (lineage && lineage.parentSessionId !== candidate.parentSessionId) return;
      lineage = candidate;
    }
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
    if (lineage) headers.set(cloudAgentSessionScopeHeaders.trustedLineage, '1');
  }

  if (params.runtimeContext) {
    try {
      const context = params.runtimeContext;
      const { claims } = await verifyKiloTokenForPolicy(params.token, context.secret, {
        audience: 'session-ingest',
        mode: 'allow-legacy',
      });
      if (claims.kiloUserId !== context.userId || claims.organizationId !== context.organizationId)
        return;
      if (claims.runtimeAuthorization) {
        const authorization = RuntimeAuthorizationSchema.parse(context.authorization);
        const reference = claims.runtimeAuthorization;
        if (
          authorization.state !== 'active' ||
          authorization.resourceKind !== 'cloud-agent-next' ||
          authorization.resourceId !== params.cloudAgentSessionId ||
          authorization.userId !== context.userId ||
          authorization.organizationId !== context.organizationId ||
          reference.id !== authorization.id ||
          reference.resourceKind !== authorization.resourceKind ||
          reference.resourceId !== authorization.resourceId ||
          Date.parse(authorization.issuedAt) > Date.now() ||
          Date.parse(authorization.delegationExpiresAt) <= Date.now() ||
          claims.exp * 1000 > Date.parse(authorization.delegationExpiresAt)
        )
          return;
        headers.set(
          RUNTIME_PROXY_ATTESTATION_HEADER,
          await issueRuntimeProxyAttestation({
            secret: context.secret,
            audience: 'session-ingest',
            userId: authorization.userId,
            authorizationId: authorization.id,
            resourceId: authorization.resourceId,
            bearer: params.token,
          })
        );
      } else if (context.authorization !== undefined && context.authorization !== null) {
        return;
      }
      if (!context.isCurrent()) return;
    } catch {
      logger.warn('Control-plane session ingest authorization failed');
      return;
    }
  }

  const body = JSON.stringify({ data: params.items });
  const ingestHeaders = new Headers(headers);
  ingestHeaders.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  const ingestUrl = isChild
    ? `https://session-ingest/internal/cloud-agent/v1/session/${encodeURIComponent(eventKiloSessionId)}/ingest?v=2`
    : `https://session-ingest/api/session/${encodeURIComponent(params.rootKiloSessionId)}/ingest?v=2`;
  try {
    if (isChild) {
      const createResponse = await params.fetchIngest(
        new Request('https://session-ingest/internal/cloud-agent/v1/session', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            sessionId: eventKiloSessionId,
            ...(lineage ? { parentSessionId: lineage.parentSessionId } : {}),
          }),
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

    if (params.runtimeContext && !params.runtimeContext.isCurrent()) return;
    const response = await params.fetchIngest(
      new Request(ingestUrl, {
        method: 'POST',
        headers: ingestHeaders,
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
