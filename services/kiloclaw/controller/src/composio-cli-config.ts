import { execFileSync as nodeExecFileSync } from 'node:child_process';

type EnvLike = Record<string, string | undefined>;

type ExecFileSync = (
  cmd: string,
  args: string[],
  opts: { stdio: 'ignore'; env: NodeJS.ProcessEnv }
) => void;

export type ComposioCliLoginDeps = {
  execFileSync: ExecFileSync;
};

const defaultDeps: ComposioCliLoginDeps = {
  execFileSync: (cmd, args, opts) => {
    nodeExecFileSync(cmd, args, opts);
  },
};

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loginComposioCli(
  env: EnvLike = process.env,
  deps: ComposioCliLoginDeps = defaultDeps
): boolean {
  const userApiKey = cleanEnvValue(env.COMPOSIO_USER_API_KEY);
  const org = cleanEnvValue(env.COMPOSIO_ORG);

  if (!userApiKey || !org) return false;

  deps.execFileSync('composio', ['login', '--user-api-key', userApiKey, '--org', org], {
    stdio: 'ignore',
    env: env as NodeJS.ProcessEnv,
  });
  console.log('[composio] CLI login completed');
  return true;
}

export function clearComposioCliEnv(env: EnvLike = process.env): void {
  delete env.COMPOSIO_USER_API_KEY;
  delete env.COMPOSIO_ORG;
}
