import {
  type FetchLike,
  type ModelClientService,
  ModelError,
  type ModelFacts,
  type ModelRequest,
  type PromptPart,
  type RetryPolicyService,
} from '@kilocode/harness-sdk';
import { remoteModelClient } from '@kilocode/harness-sdk/plugins/remote-model';
import { Effect, Stream } from 'effect';

import { resolvedTargetSupportsImages } from './backend-capabilities';
import { type StoredChatBackend } from './backend-store';
import { resolveChatTarget } from './backend-target';
import { LocalModelError } from './local-model-error';
import { localModelProvider } from './local-models';

/**
 * What a model that reads no images gets in place of one. A conversation can
 * move from a model that read an image onto one that cannot, and a provider
 * refuses the whole request over one image part. The model is told the image
 * was there, so it does not answer as if nothing had been shared.
 */
export const IMAGE_OMITTED = '[An image was shared here. This model cannot read images.]';

const hasImage = (parts: readonly PromptPart[]) => parts.some(part => part.kind === 'image');

function withoutImages(request: ModelRequest): ModelRequest {
  if (!request.prompt.messages.some(message => hasImage(message.parts))) {
    return request;
  }
  return {
    ...request,
    prompt: {
      ...request.prompt,
      messages: request.prompt.messages.map(message =>
        hasImage(message.parts)
          ? {
              ...message,
              parts: message.parts.map(
                (part): PromptPart =>
                  part.kind === 'image' ? { kind: 'text', text: IMAGE_OMITTED } : part
              ),
            }
          : message
      ),
    },
  };
}

type ChatRoutingDependencies = {
  readonly kilo: ModelClientService;
  readonly retry: RetryPolicyService;
  readonly profiles: () => readonly StoredChatBackend[];
  readonly fetch: FetchLike;
  readonly headers: (backend: StoredChatBackend) => Record<string, string>;
  readonly validateTransport: (baseUrl: string) => void;
};

/** Routing is per request, never a mutable global choice shared by open chats. */
export function routedModelClient({
  kilo,
  retry,
  profiles,
  fetch,
  headers,
  validateTransport,
}: ChatRoutingDependencies): ModelClientService {
  const clients = new Map<string, ModelClientService>();
  let knownProfiles: readonly StoredChatBackend[] | undefined = undefined;
  return {
    stream: request =>
      Stream.unwrap(
        Effect.try({
          try: () => {
            const current = profiles();
            if (current !== knownProfiles) {
              clients.clear();
              knownProfiles = current;
            }
            const target = resolveChatTarget(request.model, current);
            if (target.kind === 'custom') {
              validateTransport(target.backend.baseUrl);
            }
            return target;
          },
          catch: cause => new ModelError({ reason: 'unsupported', cause }),
        }).pipe(
          Effect.map(target => {
            const sent = resolvedTargetSupportsImages(target) ? request : withoutImages(request);
            if (target.kind === 'kilo') {
              return kilo.stream(sent);
            }
            if (target.kind === 'local') {
              // A build without this provider fails explicitly; it never falls back.
              const local = localModelProvider(target.provider);
              return local === undefined
                ? Stream.fail(
                    new ModelError({
                      reason: 'unsupported',
                      cause: new LocalModelError('unavailable'),
                    })
                  )
                : local.client.stream({ ...sent, model: target.modelId });
            }
            const { backend } = target;
            const key = `${backend.id}:${backend.revision}`;
            let client = clients.get(key);
            if (client === undefined) {
              client = remoteModelClient(
                {
                  baseUrl: backend.baseUrl,
                  apiKind: backend.apiKind,
                  completionTokenField: backend.completionTokenField,
                  fetch,
                  headers: () => Effect.succeed(headers(backend)),
                },
                retry
              );
              clients.set(key, client);
            }
            return client.stream({ ...sent, model: target.modelId });
          })
        )
      ),
  };
}

export function targetModelFacts(
  targetId: string,
  profiles: readonly StoredChatBackend[],
  gatewayFacts: ModelFacts
): ModelFacts {
  const target = resolveChatTarget(targetId, profiles);
  if (target.kind === 'kilo') {
    return gatewayFacts;
  }
  if (target.kind === 'local') {
    return localModelProvider(target.provider)?.facts(target.modelId) ?? { apiKinds: [] };
  }
  return {
    apiKinds: [target.backend.apiKind],
    ...(target.model.contextWindow === undefined
      ? {}
      : { contextWindow: target.model.contextWindow }),
    ...(target.model.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: target.model.maxOutputTokens }),
  } satisfies ModelFacts;
}
