import { type AgentMode, normalizeAgentMode } from '@/components/agents/mode-normalize';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';

export type NewSessionPrefillParams = {
  repo?: string;
  mode?: string;
  model?: string;
  variant?: string;
};

export type NewSessionPrefill = {
  /** Always a valid mode; defaults to 'code'. */
  mode: AgentMode;
  repo?: string;
  model?: string;
  variant?: string;
};

function isValidOwnerRepo(value: string): boolean {
  const segments = value.split('/').filter(Boolean);
  return segments.length === 2;
}

function isGitHubUrl(gitUrl: string): boolean {
  // SCP-style: git@github.com:owner/repo.git (case-insensitive host)
  if (/^git@github\.com:/i.test(gitUrl)) {
    return true;
  }
  // HTTPS-style: https://github.com/owner/repo.git
  try {
    const url = new URL(gitUrl);
    return url.hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

/**
 * Build query-param prefill values from a session's displayed targets.
 * Each field is included only when non-empty; repo is included only when
 * it reduces to exactly two non-empty `/` segments.
 */
export function buildContinuePrefillParams(input: {
  gitUrl: string | null | undefined;
  mode: string;
  model: string;
  variant: string;
}): NewSessionPrefillParams {
  const params: NewSessionPrefillParams = {};

  if (input.gitUrl) {
    const project = formatGitUrlProject(input.gitUrl);
    if (isGitHubUrl(input.gitUrl) && isValidOwnerRepo(project)) {
      params.repo = project;
    }
  }
  if (input.mode) {
    params.mode = input.mode;
  }
  if (input.model) {
    params.model = input.model;
  }
  if (input.variant) {
    params.variant = input.variant;
  }

  return params;
}

/**
 * Append prefill query params to a route path. Mirrors the existing
 * `appendShareId` pattern: `?` when the base has no query string, `&`
 * otherwise, values through `encodeURIComponent`. Returns `base` unchanged
 * when there is nothing to append.
 */
export function appendNewSessionPrefill(base: string, params: NewSessionPrefillParams): string {
  const entries: [string, string][] = [];

  if (params.repo) {
    entries.push(['prefillRepo', params.repo]);
  }
  if (params.mode) {
    entries.push(['prefillMode', params.mode]);
  }
  if (params.model) {
    entries.push(['prefillModel', params.model]);
  }
  if (params.variant) {
    entries.push(['prefillVariant', params.variant]);
  }

  if (entries.length === 0) {
    return base;
  }

  const separator = base.includes('?') ? '&' : '?';
  const query = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${base}${separator}${query}`;
}

function getFirstParam(record: Record<string, string | string[] | undefined>, key: string): string {
  const val = record[key];
  if (Array.isArray(val)) {
    return val[0] ?? '';
  }
  return val ?? '';
}

/**
 * Read prefill values from route search params. Each param can be
 * `string | string[]` — take the first element of an array. Mode is
 * always normalized to a valid `AgentMode`. Empty strings are treated
 * as absent.
 */
export function readNewSessionPrefill(
  raw: Record<string, string | string[] | undefined>
): NewSessionPrefill {
  const rawMode = getFirstParam(raw, 'prefillMode');
  const rawRepo = getFirstParam(raw, 'prefillRepo');
  const rawModel = getFirstParam(raw, 'prefillModel');
  const rawVariant = getFirstParam(raw, 'prefillVariant');

  return {
    mode: normalizeAgentMode(rawMode || undefined),
    ...(rawRepo ? { repo: rawRepo } : {}),
    ...(rawModel ? { model: rawModel } : {}),
    ...(rawVariant ? { variant: rawVariant } : {}),
  };
}

/**
 * Resolve a prefill model against the loaded catalog.
 * Returns `null` when `prefill.model` is absent or no entry matches
 * (this also covers the still-loading case where models is empty).
 * Otherwise returns `{ model: option.id, variant }` with the requested
 * variant when supported, else the model's first variant.
 */
export function resolvePrefillModel(
  models: { id: string; variants: string[] }[],
  prefill: NewSessionPrefill
): { model: string; variant: string } | null {
  if (!prefill.model) {
    return null;
  }

  const option = models.find(m => m.id === prefill.model);
  if (!option) {
    return null;
  }

  const variant =
    prefill.variant && option.variants.includes(prefill.variant)
      ? prefill.variant
      : (option.variants[0] ?? '');

  return { model: option.id, variant };
}

/**
 * Resolve a prefill repository against the loaded repository list.
 * Match is **case-insensitive**; returns the **matched entry's
 * `fullName`** (GitHub's canonical casing). Returns `null` when
 * `prefill.repo` is absent or nothing matches.
 */
export function resolvePrefillRepo(
  repositories: { fullName: string }[],
  prefill: NewSessionPrefill
): string | null {
  if (!prefill.repo) {
    return null;
  }

  const lower = prefill.repo.toLowerCase();
  const match = repositories.find(r => r.fullName.toLowerCase() === lower);
  return match?.fullName ?? null;
}

/**
 * Describe what could not be carried over, if anything.
 *
 * `settled` means "the list finished loading, without error, and is
 * **non-empty**". An account with no GitHub integration leaves
 * `repos.settled === false` forever (empty list ≠ settled).
 *
 * Per-field gating: a field that was **not** requested never blocks
 * and never contributes, whatever its `settled` value is.
 */
export function describePrefillFallback(input: {
  prefill: NewSessionPrefill;
  repos: { settled: boolean; matched: boolean };
  models: { settled: boolean; matched: boolean };
}): string | null {
  const { prefill, repos, models } = input;

  const repoRequested = Boolean(prefill.repo);
  const modelRequested = Boolean(prefill.model);

  // Wait only on the fields that were actually requested.
  if (repoRequested && !repos.settled) {
    return null;
  }
  if (modelRequested && !models.settled) {
    return null;
  }

  const repoDropped = repoRequested && !repos.matched;
  const modelDropped = modelRequested && !models.matched;

  if (repoDropped && modelDropped) {
    return "The original session's repository and model are no longer available. Pick them below.";
  }
  if (repoDropped) {
    return `${prefill.repo} is no longer available. Pick a repository below.`;
  }
  if (modelDropped) {
    return `${prefill.model} is no longer available. Using your default model.`;
  }
  return null;
}
