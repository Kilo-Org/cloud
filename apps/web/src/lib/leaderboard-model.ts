// Snowflake projection for the model a leaderboard row is attributed to.
// OpenRouter router ids (openrouter/auto, ...) and ~...-latest aliases are
// attributed to the model that served the request; everything else to the
// model the client requested.
export const LEADERBOARD_MODEL_SQL = `case
        when mu.requested_model like 'openrouter/%' or mu.requested_model like '~%-latest'
          then coalesce(mu.model, mu.requested_model)
        else coalesce(mu.requested_model, mu.model)
      end`;

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
