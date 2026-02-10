/**
 * Custom Sandbox subclass with lifecycle hooks.
 *
 * Hooks into container start/stop/error events so the KiloClawInstance DO
 * stays accurate even when containers die unexpectedly (crash, OOM, signal).
 */

import { Sandbox } from '@cloudflare/sandbox';
import type { KiloClawEnv } from './types';
import { userIdFromSandboxId } from './auth/sandbox-id';
import { withDORetry } from './util/do-retry';

// StopParams from @cloudflare/containers -- not re-exported by @cloudflare/sandbox
// but the runtime passes this object to onStop regardless of the declared signature.
type StopParams = {
  exitCode: number;
  reason: 'exit' | 'runtime_signal';
};

export class KiloClawSandbox extends Sandbox<KiloClawEnv> {
  /**
   * The sandbox's ID. Available via the DO context after getSandbox() calls
   * setSandboxName(). Falls back to the stringified DO ID.
   */
  private get sandboxId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  override onStart(): void {
    super.onStart();
    console.log('[lifecycle] Container started:', this.sandboxId);
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
    console.log(
      '[lifecycle] Container stopped:',
      this.sandboxId,
      'exitCode:',
      params?.exitCode,
      'reason:',
      params?.reason
    );

    // Notify the KiloClawInstance DO that the container stopped.
    // This catches unexpected deaths (crash, OOM, runtime signal) that
    // bypass the platform API stop() route.
    //
    // sandboxId is base64url-encoded userId -- decode locally, no DB lookup.
    try {
      const userId = userIdFromSandboxId(this.sandboxId);
      const stopParams = params ?? ({ exitCode: -1, reason: 'exit' } as const);
      await withDORetry(
        () => this.env.KILOCLAW_INSTANCE.get(this.env.KILOCLAW_INSTANCE.idFromName(userId)),
        stub => stub.handleContainerStopped(stopParams),
        'handleContainerStopped'
      );
    } catch (err) {
      console.error('[lifecycle] Failed to notify DO on stop:', err);
    }
  }

  override onError(error: unknown): void {
    super.onError(error);
    console.error('[lifecycle] Container error:', this.sandboxId, error);
  }
}
