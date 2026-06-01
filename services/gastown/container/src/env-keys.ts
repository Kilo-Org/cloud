// Env keys managed by the control plane that custom env_vars must never override.
// If a custom key collides with a reserved key, the infra value wins.
export const RESERVED_ENV_KEYS = new Set([
  'KILOCODE_TOKEN',
  'GIT_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_INSTANCE_URL',
  'GITHUB_CLI_PAT',
  'GH_TOKEN',
  'GASTOWN_GIT_AUTHOR_NAME',
  'GASTOWN_GIT_AUTHOR_EMAIL',
  'GASTOWN_DISABLE_AI_COAUTHOR',
  'GASTOWN_ORGANIZATION_ID',
  'GASTOWN_CONTAINER_TOKEN',
  'GASTOWN_SESSION_TOKEN',
  'GASTOWN_API_URL',
  // Runtime routing vars read by pending-nudge routes and plugin clients —
  // must never be overwritten by user-supplied env_vars.
  'GASTOWN_TOWN_ID',
  'GASTOWN_RIG_ID',
]);

export const CONFIG_SYNC_ENV_KEYS = new Set([
  'KILOCODE_TOKEN',
  'GIT_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_INSTANCE_URL',
  'GITHUB_CLI_PAT',
  'GASTOWN_GIT_AUTHOR_NAME',
  'GASTOWN_GIT_AUTHOR_EMAIL',
  'GASTOWN_DISABLE_AI_COAUTHOR',
  'GASTOWN_ORGANIZATION_ID',
  'GASTOWN_API_URL',
]);
