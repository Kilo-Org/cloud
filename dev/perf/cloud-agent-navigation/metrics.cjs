const { z } = require('zod');

const fixtureSchema = z.object({
  initialPath: z.string().startsWith('/'),
  initialReadySelector: z.string().min(1),
  interactions: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/),
        clickSelector: z.string().min(1),
        readySelector: z.string().min(1),
        readyText: z.string().optional(),
        budgetMs: z.number().positive().optional(),
      })
    )
    .min(1),
});

function localOrigin(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Navigation benchmarks require a loopback BASE_URL');
  }
  return url.origin;
}

// Never retain query strings, headers, cookies, tickets, or request/response bodies.
function requestPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  return [...new Set(samples.map(sample => sample.name))].map(name => {
    const matching = samples.filter(sample => sample.name === name);
    const contentMs = median(matching.map(sample => sample.contentMs));
    const budgetMs = matching[0].budgetMs;
    return {
      name,
      samples: matching.length,
      medianContentMs: contentMs,
      medianDecodedBytes: median(
        matching.map(sample =>
          sample.requests.reduce((total, request) => total + request.decodedBytes, 0)
        )
      ),
      budgetMs,
      withinBudget: budgetMs === undefined ? undefined : contentMs <= budgetMs,
    };
  });
}

module.exports = { fixtureSchema, localOrigin, requestPath, median, summarize };
