export type LinearIssueSummary = {
  id: string;
  title: string;
  status: string;
  url: string;
  updatedAt?: string;
  /**
   * Priority captured from the Linear `list_issues` response. The MCP
   * server returns priority as `{value, name}` where value is 0–4 (0=None,
   * 1=Urgent, 2=High, 3=Medium, 4=Low). We keep both so renderers can
   * filter on value and display the human name.
   */
  priority?: { value: number; name: string };
  /** Label names attached to the issue. Empty array when none are set. */
  labels: string[];
  /** Due date in YYYY-MM-DD form, if any. */
  dueDate?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePriority(raw: unknown): { value: number; name: string } | undefined {
  const obj = asObject(raw);
  const value = typeof obj.value === 'number' ? obj.value : null;
  const name = typeof obj.name === 'string' ? obj.name : null;
  if (value === null || name === null) return undefined;
  return { value, name };
}

function normalizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
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
      priority: normalizePriority(issue.priority),
      labels: normalizeLabels(issue.labels),
      // dueDate is contracted as YYYY-MM-DD in `LinearIssueSummary`. Enforce
      // the shape on ingest so malformed values from the API can't leak into
      // the rendered brief (e.g. "due not-a-date").
      dueDate:
        typeof issue.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate)
          ? issue.dueDate
          : undefined,
    }))
    .filter(issue => issue.id.length > 0);
}

/**
 * Priority value semantics from the Linear MCP `list_issues` schema:
 * 1 Urgent, 2 High, 3 Medium are "high signal" and are always badged.
 * 4 Low and 0 None are quieter and are only badged when there are no
 * high-signal items in the same brief, so the user never sees a bare
 * list with zero priority cues.
 */
const HIGH_SIGNAL_PRIORITY_VALUES = new Set([1, 2, 3]);

export function hasHighSignalPriority(issues: readonly LinearIssueSummary[]): boolean {
  return issues.some(
    issue => issue.priority !== undefined && HIGH_SIGNAL_PRIORITY_VALUES.has(issue.priority.value)
  );
}

/**
 * Decides whether a given issue's priority should appear in its rendered
 * line, given the priority distribution of the whole brief.
 *
 * - Urgent / High / Medium: always shown.
 * - Low / None: only shown when no Urgent / High / Medium exists in the brief.
 * - Missing priority: never shown (nothing to display).
 */
export function shouldShowPriorityBadge(
  issue: LinearIssueSummary,
  briefHasHighSignal: boolean
): boolean {
  if (issue.priority === undefined) return false;
  if (HIGH_SIGNAL_PRIORITY_VALUES.has(issue.priority.value)) return true;
  return !briefHasHighSignal;
}

/**
 * Render a single Linear issue as a markdown bullet for the brief.
 * Output shape:
 *
 *   - [<id>](<url>) [<badges>] <title> - <status> (due <dueDate>, updated <updatedAt>)
 *
 * The bracket combines priority name + label names. Omitted if both are
 * absent. Due date and updated suffix are space-joined inside the parens
 * and individually omitted when missing. When all four suffix bits are
 * absent, the parens drop entirely.
 */
export function formatLinearIssueLine(
  issue: LinearIssueSummary,
  briefHasHighSignal: boolean
): string {
  const badgeParts: string[] = [];
  // Bind priority into a local so the narrowing flows through `priority.name`
  // below without a non-null assertion. shouldShowPriorityBadge already
  // returns false when priority is undefined, but the local + explicit
  // check keep the formatter readable on its own.
  const priority = issue.priority;
  if (priority !== undefined && shouldShowPriorityBadge(issue, briefHasHighSignal)) {
    badgeParts.push(priority.name);
  }
  badgeParts.push(...issue.labels);
  const badge = badgeParts.length > 0 ? ` [${badgeParts.join(', ')}]` : '';

  const suffixParts: string[] = [];
  if (issue.dueDate) suffixParts.push(`due ${issue.dueDate}`);
  if (issue.updatedAt) {
    // Linear's API returns full ISO timestamps (e.g. 2026-05-14T23:13:00.450Z).
    // The brief reads more naturally as a date; slice the first 10 chars.
    // Already-YYYY-MM-DD inputs pass through unchanged.
    suffixParts.push(`updated ${issue.updatedAt.slice(0, 10)}`);
  }
  const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : '';

  return `- [${issue.id}](${issue.url})${badge} ${issue.title} - ${issue.status}${suffix}`;
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
