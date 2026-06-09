import { DurableObject } from 'cloudflare:workers';
import type { SessionStatus } from '../shared/protocol.js';
import type { Env } from '../types.js';
import type { PublicCloudAgentExtensionEvent } from './cloud-agent-extension-events.js';
import type { KiloFacadeGlobalEvents } from './contracts.js';
import { facadeError } from './http-contract.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';
import { handleKiloFacadeRequest } from './request-dispatcher.js';
import {
  handleGlobalFeedUpgrade,
  type GlobalFeedSource,
} from './handlers/global-feed-upgrade/handler.js';
import {
  interpretGlobalFeedMessage,
  type KiloEventPayload,
  type KiloGlobalEventEnvelope,
} from './handlers/global-feed-upgrade/message.js';
import { publicSessionStatusesFromAttachments } from './handlers/session-status/tracking.js';
import { FacadeMetadataFeed } from './metadata-feed.js';
import { FacadeMetadataProjector } from './metadata-projector.js';

export const KILO_FACADE_USER_ID_HEADER = 'x-kilo-facade-user-id';
export const KILO_FACADE_AUTH_TOKEN_HEADER = 'x-kilo-facade-auth-token';
export const KILO_FACADE_GLOBAL_FEED_PATH = '/internal/kilo/global-feed';

const HEARTBEAT_INTERVAL_MS = 10_000;
const METADATA_RECONCILIATION_RETRY_DELAY_MS = 100;
const MAX_PUBLIC_GLOBAL_EVENT_QUEUE_SIZE = 64;
const SLOW_SUBSCRIBER_ERROR = 'Global event subscriber fell behind';
const PUBLIC_VIRTUAL_SERVER_DIRECTORY = '/cloud-agent';
const encoder = new TextEncoder();

type PublicSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  scope: { kind: 'global' } | { kind: 'session'; kiloSessionId: string };
};

function createPublicEventPayload(type: 'server.connected'): KiloEventPayload {
  return { id: `evt_${crypto.randomUUID()}`, type, properties: {} };
}

export function encodeSseData(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function encodeSseComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export { handleKiloFacadeRequest, publicCloudAgentDirectory };
export {
  isSyntheticGlobalEvent,
  rewriteGlobalEventDirectory,
} from './handlers/global-feed-upgrade/message.js';
export type { KiloFacadeGlobalEvents, KiloFacadeRequestDeps } from './contracts.js';

export class UserKiloFacade extends DurableObject<Env> implements KiloFacadeGlobalEvents {
  private subscribers = new Map<string, PublicSubscriber>();
  private subscriberUserId?: string;
  private readonly metadataFeed: FacadeMetadataFeed;
  private readonly metadataProjector: FacadeMetadataProjector;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.metadataProjector = new FacadeMetadataProjector(
      env,
      (event, kiloSessionId) => this.broadcastGlobalEvent(event, kiloSessionId),
      generation => this.metadataFeed.isCurrent(generation)
    );
    this.metadataFeed = new FacadeMetadataFeed(env, {
      onMessage: (message, generation) => {
        this.metadataProjector.notify(message, generation);
      },
      onConnected: generation => {
        void this.reconcileMetadata(generation);
      },
      onStopped: () => {
        this.metadataProjector.stop();
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === KILO_FACADE_GLOBAL_FEED_PATH) {
      return handleGlobalFeedUpgrade({
        request,
        ctx: this.ctx,
        validateProducer: source => this.validateGlobalFeedProducer(source),
      });
    }

    const userId = request.headers.get(KILO_FACADE_USER_ID_HEADER);
    if (!userId) return facadeError(401, 'UNAUTHENTICATED', 'Missing authenticated user context');
    const authToken = request.headers.get(KILO_FACADE_AUTH_TOKEN_HEADER) ?? undefined;
    return handleKiloFacadeRequest({
      request,
      env: this.env,
      userId,
      authToken,
      deps: { globalEvents: this },
    });
  }

  getPublicSessionStatuses(kiloSessionId?: string): Record<string, SessionStatus> {
    const attachments: unknown[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      attachments.push(attachment);
    }
    return publicSessionStatusesFromAttachments(attachments, kiloSessionId);
  }

  openPublicGlobalEventStream(userId: string): Response {
    return this.openPublicEventStream(userId, { kind: 'global' });
  }

  openPublicSessionEventStream(userId: string, kiloSessionId: string): Response {
    return this.openPublicEventStream(userId, { kind: 'session', kiloSessionId });
  }

  async publishCloudAgentExtensionEvent(input: {
    kiloUserId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    organizationId?: string;
    event: PublicCloudAgentExtensionEvent;
  }): Promise<void> {
    if (input.organizationId) {
      const sessionIngest = this.env.SESSION_INGEST;
      if (!sessionIngest) return;
      const resolved = await sessionIngest.resolveCloudAgentRootSessionForKiloSession({
        kiloUserId: input.kiloUserId,
        kiloSessionId: input.kiloSessionId,
      });
      if (resolved?.cloudAgentSessionId !== input.cloudAgentSessionId) return;
    }
    this.broadcastGlobalEvent(
      { directory: publicCloudAgentDirectory(input.kiloSessionId), payload: input.event },
      input.kiloSessionId
    );
  }

  private openPublicEventStream(userId: string, scope: PublicSubscriber['scope']): Response {
    if (this.subscriberUserId && this.subscriberUserId !== userId) {
      return facadeError(
        403,
        'KILO_FACADE_IDENTITY_MISMATCH',
        'Authenticated user context does not match the active facade stream'
      );
    }
    const subscriberId = crypto.randomUUID();
    const publicConnectionEvent = () =>
      scope.kind === 'global'
        ? {
            directory: PUBLIC_VIRTUAL_SERVER_DIRECTORY,
            payload: createPublicEventPayload('server.connected'),
          }
        : createPublicEventPayload('server.connected');
    const stream = new ReadableStream<Uint8Array>(
      {
        start: controller => {
          const subscriber: PublicSubscriber = {
            controller,
            scope,
            heartbeat: setInterval(() => {
              this.sendCommentToSubscriber(subscriberId, 'heartbeat');
            }, HEARTBEAT_INTERVAL_MS),
          };
          this.subscribers.set(subscriberId, subscriber);
          this.subscriberUserId ??= userId;
          const demand = this.metadataFeed.addDemand(userId);
          if (demand.started) this.metadataProjector.start(demand.generation, userId);
          this.sendToSubscriber(subscriberId, publicConnectionEvent());
        },
        cancel: () => {
          this.removeSubscriber(subscriberId);
        },
      },
      { highWaterMark: MAX_PUBLIC_GLOBAL_EVENT_QUEUE_SIZE, size: () => 1 }
    );
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.handleGlobalFeedMessage(ws, message);
  }

  private validateGlobalFeedProducer(source: GlobalFeedSource) {
    const sessionDoId = this.env.CLOUD_AGENT_SESSION.idFromName(
      `${source.userId}:${source.cloudAgentSessionId}`
    );
    return this.env.CLOUD_AGENT_SESSION.get(sessionDoId).validateKiloGlobalFeedProducer({
      kiloSessionId: source.kiloSessionId,
      wrapperRunId: source.wrapperRunId,
      wrapperGeneration: source.wrapperGeneration,
      wrapperConnectionId: source.wrapperConnectionId,
    });
  }

  private handleGlobalFeedMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const source = ws.deserializeAttachment() as GlobalFeedSource | null;
    const result = interpretGlobalFeedMessage(source, message);
    switch (result.kind) {
      case 'send-error':
        ws.send(JSON.stringify({ error: result.error }));
        return;
      case 'close':
        ws.close(result.code, result.reason);
        return;
      case 'drop':
        return;
      case 'broadcast':
        if (result.nextSource) ws.serializeAttachment(result.nextSource);
        if (this.metadataProjector.recordWrapperEvent(result.event, result.kiloSessionId)) {
          this.broadcastGlobalEvent(result.event, result.kiloSessionId);
        }
    }
  }

  webSocketClose(): void {
    // A producer disconnect is not an idle transition; a reconnect sends an authoritative status.
  }

  private sendFrameToSubscriber(subscriberId: string, frame: Uint8Array): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) return;
    if (subscriber.controller.desiredSize !== null && subscriber.controller.desiredSize <= 0) {
      this.removeSubscriber(subscriberId);
      subscriber.controller.error(new Error(SLOW_SUBSCRIBER_ERROR));
      return;
    }
    try {
      subscriber.controller.enqueue(frame);
    } catch {
      this.removeSubscriber(subscriberId);
    }
  }

  private sendToSubscriber(subscriberId: string, event: unknown): void {
    this.sendFrameToSubscriber(subscriberId, encodeSseData(event));
  }

  private sendCommentToSubscriber(subscriberId: string, comment: string): void {
    this.sendFrameToSubscriber(subscriberId, encodeSseComment(comment));
  }

  private broadcastGlobalEvent(event: KiloGlobalEventEnvelope, kiloSessionId: string): void {
    for (const [subscriberId, subscriber] of this.subscribers.entries()) {
      if (subscriber.scope.kind === 'global') {
        this.sendToSubscriber(subscriberId, event);
      } else if (subscriber.scope.kiloSessionId === kiloSessionId && event.payload) {
        this.sendToSubscriber(subscriberId, event.payload);
      }
    }
  }

  private removeSubscriber(subscriberId: string): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) return;
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(subscriberId);
    this.metadataFeed.removeDemand();
    if (this.subscribers.size === 0) this.subscriberUserId = undefined;
  }

  private async reconcileMetadata(generation: number): Promise<void> {
    const scopedIds = [...this.subscribers.values()].flatMap(subscriber =>
      subscriber.scope.kind === 'session' ? [subscriber.scope.kiloSessionId] : []
    );
    if (!this.hasGlobalSubscriber()) {
      this.metadataProjector.reconcile(scopedIds, generation);
      return;
    }

    const roots = await this.listGlobalReconciliationRoots(generation);
    if (!this.metadataFeed.isCurrent(generation)) return;
    if (!roots || !this.hasGlobalSubscriber()) {
      this.metadataProjector.reconcile(scopedIds, generation);
      return;
    }
    this.metadataProjector.reconcile(
      [...scopedIds, ...roots.map(root => root.kiloSessionId)],
      generation
    );
  }

  private async listGlobalReconciliationRoots(generation: number) {
    try {
      return await this.env.SESSION_INGEST.listCloudAgentRootSessions({
        kiloUserId: this.currentSubscriberUserId(),
        limit: 100,
      });
    } catch {
      if (!this.metadataFeed.isCurrent(generation) || !this.hasGlobalSubscriber()) return null;
      await new Promise(resolve => setTimeout(resolve, METADATA_RECONCILIATION_RETRY_DELAY_MS));
      if (!this.metadataFeed.isCurrent(generation) || !this.hasGlobalSubscriber()) return null;
      try {
        return await this.env.SESSION_INGEST.listCloudAgentRootSessions({
          kiloUserId: this.currentSubscriberUserId(),
          limit: 100,
        });
      } catch {
        return null;
      }
    }
  }

  private hasGlobalSubscriber(): boolean {
    return [...this.subscribers.values()].some(subscriber => subscriber.scope.kind === 'global');
  }

  private currentSubscriberUserId(): string {
    return this.metadataFeed.userIdForCurrentDemand();
  }
}
