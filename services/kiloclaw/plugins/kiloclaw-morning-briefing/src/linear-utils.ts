export type LinearIssueSummary = {
  id: string;
  title: string;
  status: string;
  url: string;
  updatedAt?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeLinearIssues(payload: unknown): LinearIssueSummary[] {
  const root = asObject(payload);
  const issues = Array.isArray(root.issues) ? root.issues : [];
  return issues
    .map(raw => asObject(raw))
    .map(issue => ({
      id: typeof issue.id === 'string' ? issue.id : '',
      title: typeof issue.title === 'string' ? issue.title : '(untitled)',
      status: typeof issue.status === 'string' ? issue.status : 'Unknown',
      url: typeof issue.url === 'string' ? issue.url : '',
      updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : undefined,
    }))
    .filter(issue => issue.id.length > 0);
}

export function summarizeLinearCallFailure(stdout: string, stderr: string): string {
  const parsed = tryParseJson(stdout);
  if (parsed) {
    const issue = asObject(parsed.issue);
    const kind = typeof issue.kind === 'string' ? issue.kind : null;
    const statusCode = typeof issue.statusCode === 'number' ? issue.statusCode : null;
    if (kind === 'auth' || statusCode === 401) {
      return 'Linear authentication failed (check LINEAR_API_KEY and redeploy)';
    }
    if (kind === 'offline') {
      return 'Linear MCP server is unavailable or timed out';
    }
    if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  }

  const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').trim();
  if (!combined) {
    return 'Linear query failed';
  }
  return combined.length > 220 ? `${combined.slice(0, 217)}...` : combined;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return asObject(parsed);
  } catch {
    return null;
  }
}
