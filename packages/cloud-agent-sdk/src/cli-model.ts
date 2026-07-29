export const CLI_MODEL_ID = '__cli-model__';

export function cliModelLabel(
  config: { model: string; providerID?: string | null } | null
): string {
  if (!config?.model) return 'CLI default';
  return `CLI model — ${config.providerID ? `${config.providerID}/` : ''}${config.model}`;
}
