export type WebResultSummary = {
  title: string;
  url: string;
  summary: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stripUntrustedWrappers(text: string): string {
  return text
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, ' ')
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, ' ')
    .replace(/Source:\s*Web Search/gi, ' ')
    .replace(/\[\.\.\.\]/g, ' ')
    .replace(/---/g, ' ');
}

function normalizeText(text: string): string {
  return stripUntrustedWrappers(text).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3).trimEnd()}...`;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'result';
  }
}

export function normalizeWebResults(payload: unknown): WebResultSummary[] {
  const root = asObject(payload);
  const results = Array.isArray(root.results) ? root.results : [];
  return results
    .map(raw => asObject(raw))
    .map(item => {
      const url = typeof item.url === 'string' ? item.url : '';
      const rawTitle = typeof item.title === 'string' ? item.title : '';
      const rawSummary =
        typeof item.summary === 'string'
          ? item.summary
          : typeof item.description === 'string'
            ? item.description
            : '';
      const normalizedTitle = normalizeText(rawTitle);
      const normalizedSummary = normalizeText(rawSummary);
      const title = truncate(normalizedTitle || hostnameFromUrl(url) || '(untitled)', 140);
      const summary = truncate(normalizedSummary, 280);
      return {
        title,
        url,
        summary,
      };
    })
    .filter(item => item.url.length > 0);
}
