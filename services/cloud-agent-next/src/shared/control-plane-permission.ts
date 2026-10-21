export const CONTROL_PLANE_SANDBOX_PERMISSION = {
  external_directory: 'allow',
  read: { '*': 'allow', '*.env': 'allow', '*.env.*': 'allow' },
  edit: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'allow',
  task: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  codesearch: 'allow',
  lsp: 'allow',
  skill: 'allow',
  todowrite: 'allow',
  todoread: 'allow',
  doom_loop: 'allow',
  suggest: 'deny',
  schedule_wakeup: 'deny',
  cancel_wakeup: 'deny',
  cron_create: 'deny',
  cron_list: 'deny',
  cron_delete: 'deny',
} as const;

/**
 * Only interactive Cloud Agent clients have a person who can answer a question
 * or a CLI-enforced human approval. Every other origin runs unattended.
 */
export function isInteractiveSessionOrigin(createdOnPlatform: string | undefined): boolean {
  return createdOnPlatform === 'cloud-agent-web' || createdOnPlatform === 'desktop';
}
