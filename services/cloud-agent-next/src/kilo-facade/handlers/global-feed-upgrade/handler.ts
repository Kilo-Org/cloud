import type { SessionStatus } from '../../../shared/protocol.js';
import { hasDuplicateQueryParameters } from '../../../shared/http-query.js';
import { facadeError } from '../../http-contract.js';

export type GlobalFeedSource = {
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
  sessionStatus?: SessionStatus;
};

type ProducerValidation = { success: true } | { success: false; status: number; message: string };

function parseGlobalFeedSource(request: Request): GlobalFeedSource | Response {
  const url = new URL(request.url);
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return facadeError(400, 'INVALID_GLOBAL_FEED_SOURCE', 'Invalid global feed source');
  }
  const userId = url.searchParams.get('userId');
  const cloudAgentSessionId = url.searchParams.get('cloudAgentSessionId');
  const kiloSessionId = url.searchParams.get('kiloSessionId');
  const wrapperRunId = url.searchParams.get('wrapperRunId');
  const wrapperGenerationParam = url.searchParams.get('wrapperGeneration');
  const wrapperConnectionId = url.searchParams.get('wrapperConnectionId');
  const wrapperGeneration = wrapperGenerationParam ? Number(wrapperGenerationParam) : NaN;
  if (
    !userId ||
    !cloudAgentSessionId ||
    !kiloSessionId ||
    !wrapperRunId ||
    !Number.isInteger(wrapperGeneration) ||
    wrapperGeneration < 0 ||
    !wrapperConnectionId
  ) {
    return facadeError(400, 'INVALID_GLOBAL_FEED_SOURCE', 'Invalid global feed source');
  }
  return {
    userId,
    cloudAgentSessionId,
    kiloSessionId,
    wrapperRunId,
    wrapperGeneration,
    wrapperConnectionId,
  };
}

function producerTag(source: Pick<GlobalFeedSource, 'cloudAgentSessionId'>): string {
  return `kilo-global:${source.cloudAgentSessionId}`;
}

function isSameProducer(left: GlobalFeedSource, right: GlobalFeedSource): boolean {
  return (
    left.wrapperRunId === right.wrapperRunId &&
    left.wrapperGeneration === right.wrapperGeneration &&
    left.wrapperConnectionId === right.wrapperConnectionId
  );
}

function mayReplaceProducer(existing: GlobalFeedSource, candidate: GlobalFeedSource): boolean {
  if (candidate.wrapperGeneration > existing.wrapperGeneration) return true;
  if (candidate.wrapperGeneration < existing.wrapperGeneration) return false;
  return isSameProducer(existing, candidate);
}

export async function handleGlobalFeedUpgrade(params: {
  request: Request;
  ctx: DurableObjectState;
  validateProducer: (source: GlobalFeedSource) => Promise<ProducerValidation>;
}): Promise<Response> {
  if (params.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return facadeError(426, 'WEBSOCKET_REQUIRED', 'Expected WebSocket upgrade');
  }
  const source = parseGlobalFeedSource(params.request);
  if (source instanceof Response) return source;
  const validation = await params.validateProducer(source);
  if (!validation.success) return new Response(validation.message, { status: validation.status });

  const tag = producerTag(source);
  const existingSockets = params.ctx.getWebSockets(tag);
  for (const existing of existingSockets) {
    const existingSource = existing.deserializeAttachment() as GlobalFeedSource | null;
    if (existingSource && !mayReplaceProducer(existingSource, source)) {
      return new Response('A newer global feed producer is already connected', { status: 409 });
    }
  }
  for (const existing of existingSockets) {
    try {
      existing.close(1000, 'Replaced by newer global feed');
    } catch {
      // Ignore already-closed producer sockets.
    }
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  params.ctx.acceptWebSocket(server, [tag]);
  server.serializeAttachment(source);
  return new Response(null, { status: 101, webSocket: client });
}
