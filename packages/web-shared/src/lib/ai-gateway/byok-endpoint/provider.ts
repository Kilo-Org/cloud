import type {
  ByokEndpointDefinition,
  ByokEndpointModel,
  ByokEndpointProviderId,
} from '@kilocode/db/schema-types';
import {
  buildDirectProvider,
  type DirectUpstreamAuth,
} from '@kilocode/web-shared/lib/ai-gateway/providers/build-direct-provider';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  getByokEndpointModelApiKinds,
  getByokEndpointModelResponseTransform,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';

const ANTHROPIC_VERSION = '2023-06-01';

/** The request fields `applyTrackingIds` sets; `prompt_cache_key` stays because it only aids caching. */
function removeTrackingIds(body: Record<string, unknown>) {
  delete body.user;
  delete body.safety_identifier;
  delete body.session_id;
  const metadata = body.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return;
  const { user_id: _userId, ...rest } = metadata as Record<string, unknown>;
  if (Object.keys(rest).length === 0) delete body.metadata;
  else body.metadata = rest;
}

/** The upstream for `model` of an organization's endpoint, authenticated with its credentials. */
export function buildByokEndpointProvider(
  providerId: ByokEndpointProviderId,
  definition: ByokEndpointDefinition,
  model: ByokEndpointModel,
  auth: DirectUpstreamAuth
): Provider {
  const provider = buildDirectProvider(
    'byok-endpoint',
    getByokEndpointModelApiKinds(definition, model),
    {
      base_url: definition.base_url,
      internal_id: model.internal_id,
      reasoning_details_transform:
        getByokEndpointModelResponseTransform(definition, model) ?? undefined,
    },
    auth
  );
  return {
    ...provider,
    inferenceProviderId: providerId,
    byokEndpointName: definition.name,
    async transformRequest(context) {
      await provider.transformRequest(context);
      const body = context.request.body as Record<string, unknown>;
      // Only OpenRouter-compatible upstreams accept OpenRouter's routing object, and an
      // organization's upstream has no use for the user and session ids Kilo adds.
      delete body.provider;
      removeTrackingIds(body);
      // Anthropic's own API rejects Messages requests without it; compatible upstreams ignore it.
      if (context.request.kind === 'messages') {
        context.extraHeaders['anthropic-version'] ??= ANTHROPIC_VERSION;
      }
    },
  };
}
