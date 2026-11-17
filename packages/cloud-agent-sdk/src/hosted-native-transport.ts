import { createConnection, type Connection } from './cloud-agent-connection';
import type { CloudAgentTransportConfig } from './cloud-agent-transport';
import { createCloudAgentWrites } from './cloud-agent-writes';
import { createHostedNativeConversation } from './hosted-native-conversation';
import type { NativeSyncClient, NativeSessionConnection } from './native-sync';
import { normalize, isChatEvent } from './normalizer';
import type { TransportFactory } from './transport';
import { HOSTED_CLOUD_EVENT_TYPES } from './schemas';

type HostedNativeTransportConfig = Pick<
  CloudAgentTransportConfig,
  | 'sessionId'
  | 'kiloSessionId'
  | 'api'
  | 'getTicket'
  | 'websocketBaseUrl'
  | 'onError'
  | 'lifecycleHooks'
  | 'websocketHeaders'
> & {
  nativeSyncClient: NativeSyncClient;
  onReaderError?: ((message: string | undefined) => void) | undefined;
  organizationId?: string | undefined;
};

export function createHostedNativeTransport(config: HostedNativeTransportConfig): TransportFactory {
  return sink => {
    let cloud: Connection | undefined;
    let native: NativeSessionConnection | undefined;
    let generation = 0;
    let cloudCursor = 0;
    let nativeReady = false;
    let cloudReady = false;
    let replaying = false;
    const conversation = createHostedNativeConversation(sink, config.kiloSessionId);
    const finish = () => {
      if (!replaying || !nativeReady || !cloudReady) return;
      replaying = false;
      sink.onReplayComplete?.();
    };
    const close = () => {
      cloud?.destroy();
      cloud = undefined;
      native?.close();
      native = undefined;
    };
    const fail = (message: string) => {
      native?.close();
      native = undefined;
      if (replaying) {
        replaying = false;
        sink.onReplayCanceled?.();
      }
      config.onError?.(message);
    };
    const startNative = (current: number) => {
      native = config.nativeSyncClient.connectSession(
        config.kiloSessionId,
        state => {
          if (current !== generation) return;
          const projected = conversation.updateNative(state);
          if (state.failure?.status === 401 || state.failure?.status === 403)
            config.onError?.(state.error ?? 'Native session access denied');
          else if (!state.recovering && !(state.failure?.status === 404 && !state.snapshot)) {
            const error =
              state.error ?? (!projected.session && state.snapshot ? projected.error : undefined);
            if (error) {
              if (config.onReaderError) config.onReaderError(error);
              else config.onError?.(error);
            } else if (
              state.connection === 'connected' &&
              state.snapshot &&
              projected.session &&
              projected.incompleteMessageIDs.length === 0
            ) {
              config.onReaderError?.(undefined);
            }
          }
          nativeReady = state.snapshot !== undefined;
          finish();
        },
        config.organizationId
      );
    };
    const checkBootstrapFailure = (
      status: { type: string; message?: string | undefined } | undefined
    ) => {
      if (nativeReady || status?.type !== 'error' || status.message === 'preparation_cancelled')
        return;
      fail('The hosted runtime could not start. Send a new message to retry.');
    };
    return {
      ...createCloudAgentWrites(config.api, config.sessionId, async mutation => {
        const current = generation;
        const result = await mutation();
        if (current === generation) {
          cloud?.recoverAfterSuccessfulMutation();
        }
        return result;
      }),
      connect() {
        close();
        const current = ++generation;
        nativeReady = false;
        cloudReady = false;
        replaying = true;
        sink.onReplayStarted?.();
        startNative(current);
        void Promise.resolve()
          .then(() => config.getTicket(config.sessionId))
          .then(ticket => {
            if (current !== generation) return;
            cloud = createConnection({
              ticket,
              websocketUrl: () => {
                const url = new URL('/stream', config.websocketBaseUrl);
                url.searchParams.set('cloudAgentSessionId', config.sessionId);
                url.searchParams.set('eventTypes', HOSTED_CLOUD_EVENT_TYPES.join(','));
                url.searchParams.set('afterCursor', String(cloudCursor));
                url.searchParams.set('bootstrap', 'true');
                return url.href;
              },
              lifecycleHooks: config.lifecycleHooks,
              websocketHeaders: config.websocketHeaders,
              onRefreshTicket: async () => config.getTicket(config.sessionId),
              onConnected() {},
              onDisconnected() {},
              onError: error => {
                if (current === generation) config.onError?.(error.message);
              },
              onEvent(raw) {
                if (current !== generation) return;
                if (raw.cursor !== undefined) cloudCursor = Math.max(cloudCursor, raw.cursor);
                if (
                  !HOSTED_CLOUD_EVENT_TYPES.includes(raw.streamEventType) &&
                  raw.streamEventType !== 'bootstrap.complete'
                )
                  return;
                const event = normalize(raw);
                if (!event || isChatEvent(event)) return;
                if (event.type === 'cloud.interactions') {
                  conversation.updateCloud(event);
                  return;
                }
                if (event.type === 'connected') {
                  sink.onServiceEvent(event);
                  conversation.updateCloud(event);
                  checkBootstrapFailure(event.cloudStatus);
                  cloudReady = event.bootstrapPending !== true;
                } else if (event.type === 'bootstrap.complete') cloudReady = true;
                else {
                  sink.onServiceEvent(event);
                  conversation.updateCloud(event);
                  if (event.type === 'cloud.status') {
                    checkBootstrapFailure(event.cloudStatus);
                    if (!native && event.cloudStatus.type !== 'error') startNative(current);
                  }
                }
                finish();
              },
            });
            cloud.connect();
          })
          .catch(() => {
            if (current === generation) fail('The Cloud service connection is unavailable');
          });
      },
      disconnect() {
        ++generation;
        close();
        if (replaying) sink.onReplayCanceled?.();
        replaying = false;
      },
      destroy() {
        ++generation;
        close();
        if (replaying) sink.onReplayCanceled?.();
        replaying = false;
      },
    };
  };
}
