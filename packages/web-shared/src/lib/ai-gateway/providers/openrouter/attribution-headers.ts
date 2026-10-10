/**
 * Identification headers required by OpenRouter (and honored by some other
 * upstreams like Vercel AI Gateway). See:
 * https://openrouter.ai/docs/api-reference/overview#headers
 *
 * Important: these values must match what the Kilo Code extension sends so
 * the extension and the cloud proxy are attributed as the same app.
 */
export const ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://kilocode.ai',
  'X-Title': 'Kilo Code',
} as const;
