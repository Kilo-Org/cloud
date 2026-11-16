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
  getByokEndpointModelBaseUrl,
  getByokEndpointModelResponseTransform,
  hasByokEndpointModelPlaceholder,
} from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';

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
      base_url: getByokEndpointModelBaseUrl(definition, model),
      // A `{model}` URL names the model, so the body carries none.
      internal_id: hasByokEndpointModelPlaceholder(definition.base_url)
        ? undefined
        : model.internal_id,
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
      if (!definition.forward_provider_routing) delete body.provider;
      if (!definition.forward_tracking_ids) removeTrackingIds(body);
    },
  };
}
