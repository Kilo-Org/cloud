import type { WrapperSentryContext, WrapperSentryReporter } from './sentry.js';

export function createLegacyCrashHandler(deps: {
  sentry: WrapperSentryReporter;
  getContext(): Pick<WrapperSentryContext, 'sessionId' | 'wrapperRunId'>;
  isShuttingDown(): boolean;
  log(message: string): void;
  finalizeLogs(): Promise<void>;
  exit(code: number): void;
}): (operation: 'uncaught_exception' | 'unhandled_rejection', error: unknown) => void {
  let crashing = false;
  return (operation, error) => {
    if (deps.isShuttingDown() || crashing) return;
    crashing = true;
    deps.log(operation === 'uncaught_exception' ? 'uncaught exception' : 'unhandled rejection');
    deps.sentry.capture(error, { ...deps.getContext(), operation, exitCode: 1 });
    const flushing = deps.sentry.flush();
    void Promise.allSettled([flushing, Promise.resolve().then(() => deps.finalizeLogs())]).then(
      () => deps.exit(1)
    );
  };
}
