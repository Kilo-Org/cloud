/**
 * Custom Sandbox subclass with lifecycle hooks.
 *
 * Hooks into container stop events so PreviewDO can track when the container
 * goes to sleep, avoiding expensive getSandboxState() calls that would wake it.
 */

import { Sandbox } from '@cloudflare/sandbox';
import type { Env } from './types';
import { logger } from './utils/logger';

// StopParams from @cloudflare/containers -- not re-exported by @cloudflare/sandbox
// but the runtime passes this object to onStop regardless of the declared signature.
type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

export class AppBuilderSandbox extends Sandbox<Env> {
  private get sandboxId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  override onStart(): void {
    super.onStart();
    logger.info('[lifecycle] Container started', { sandboxId: this.sandboxId });
  }

  /**
   * Sandbox declares onStop() with no params, but the Container base class
   * (and the runtime) pass StopParams. We accept no params to match the
   * parent signature, then read the actual params via `arguments`.
   */
  override async onStop(): Promise<void> {
    await super.onStop();
    // eslint-disable-next-line prefer-rest-params
    const params = arguments[0] as StopParams | undefined;
    const appId = this.sandboxId;
    logger.info('[lifecycle] Container stopped', {
      sandboxId: appId,
      exitCode: params?.exitCode,
      reason: params?.reason,
    });

    // Notify the PreviewDO that the container stopped.
    // The sandbox name IS the appId (getSandbox(env.SANDBOX, appId)).
    try {
      const previewStub = this.env.PREVIEW.get(this.env.PREVIEW.idFromName(appId));
      await previewStub.handleContainerStopped();
    } catch (err) {
      logger.error('[lifecycle] Failed to notify PreviewDO on stop', {
        sandboxId: appId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  override onError(error: unknown): void {
    super.onError(error);
    logger.error('[lifecycle] Container error', {
      sandboxId: this.sandboxId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
