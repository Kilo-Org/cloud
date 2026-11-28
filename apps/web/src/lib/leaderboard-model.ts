import { isLatestAliasId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { resolveOpenRouterModelAlias } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

// SQL projection for the model a leaderboard row is attributed to.
// OpenRouter router ids (openrouter/auto, ...) are attributed to the model that
// served the request; everything else to the model the client requested.
export const LEADERBOARD_MODEL_SQL = `case
        when mu.requested_model like 'openrouter/%' then coalesce(mu.model, mu.requested_model)
        else coalesce(mu.requested_model, mu.model)
      end`;

// The served model for latest alias rows, used when the gateway cannot resolve the alias.
export const LEADERBOARD_SERVED_MODEL_SQL = `case when mu.requested_model like '~%' then mu.model end`;

export function normalizeLeaderboardModel(model: string): string {
  const withoutTrailingSlashes = model.trim().replace(/\/+$/, '');
  const slashIndex = withoutTrailingSlashes.lastIndexOf('/');
  const withoutProvider = withoutTrailingSlashes.startsWith('openrouter/')
    ? withoutTrailingSlashes
    : withoutTrailingSlashes.slice(slashIndex + 1);
  const colonIndex = withoutProvider.indexOf(':');

  if (colonIndex < 0 || withoutProvider.slice(colonIndex) === ':free') {
    return withoutProvider;
  }

  return withoutProvider.slice(0, colonIndex);
}

/**
 * Latest aliases resolve to the target the gateway currently routes them to,
 * rather than the served model id, which providers report inconsistently. An
 * alias the gateway cannot resolve falls back to the served model.
 */
export async function resolveLeaderboardModel(
  model: string,
  servedModel: string | undefined
): Promise<string> {
  const trimmed = model.trim();
  const resolved = await resolveOpenRouterModelAlias(trimmed);
  const fallback = servedModel?.trim();
  return normalizeLeaderboardModel(
    isLatestAliasId(resolved) && resolved === trimmed && fallback ? fallback : resolved
  );
}
