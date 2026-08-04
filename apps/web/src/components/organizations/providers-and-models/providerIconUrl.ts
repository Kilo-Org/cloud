export function normalizeProviderIconUrl(rawUrl: string): string {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl;
  return rawUrl.startsWith('/')
    ? `https://openrouter.ai${rawUrl}`
    : `https://openrouter.ai/${rawUrl}`;
}
