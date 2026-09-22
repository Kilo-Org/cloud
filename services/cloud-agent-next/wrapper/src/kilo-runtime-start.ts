export type KiloRuntimeStartDecisionInput = {
  forceRestart: boolean;
  hasClient: boolean;
  runtimeWorkspacePath: string | undefined;
  workspacePath: string;
};

export function decideKiloRuntimeStart(input: KiloRuntimeStartDecisionInput): 'reuse' | 'start' {
  if (input.forceRestart) return 'start';
  if (!input.hasClient) return 'start';
  if (input.runtimeWorkspacePath !== input.workspacePath) return 'start';
  return 'reuse';
}
