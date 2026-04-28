export type CommandCapableRuntime = {
  runtime: {
    system: {
      runCommandWithTimeout: (
        argv: string[],
        options: { timeoutMs: number; cwd?: string }
      ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    };
  };
};

export class CommandExecutionError extends Error {
  readonly argv: string[];
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: { argv: string[]; code: number | null; stdout: string; stderr: string }) {
    const detail = params.stderr.trim() || params.stdout.trim() || 'Command failed';
    super(`${params.argv.join(' ')} failed: ${detail}`);
    this.name = 'CommandExecutionError';
    this.argv = params.argv;
    this.code = params.code;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

export function isTimeoutExecutionError(error: unknown): boolean {
  if (!(error instanceof CommandExecutionError)) {
    return false;
  }

  if (error.code === null) {
    return true;
  }

  const text = `${error.stderr}\n${error.stdout}\n${error.message}`;
  return (
    text.includes('operation was aborted due to timeout') ||
    text.includes('timed out') ||
    text.includes('ETIMEDOUT') ||
    text.includes('AbortError')
  );
}

export async function runCommand(
  api: CommandCapableRuntime,
  argv: string[],
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string }> {
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new CommandExecutionError({
      argv,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
