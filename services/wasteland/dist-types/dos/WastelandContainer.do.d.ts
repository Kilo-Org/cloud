import { Container } from '@cloudflare/containers';
/**
 * WastelandContainerDO — a Cloudflare Container per wasteland.
 *
 * Runs the `wl` CLI and a lightweight control server for protocol
 * operations (browse, claim, post, sync) against DoltHub.
 *
 * This DO is intentionally thin. It manages container lifecycle and proxies
 * ALL requests directly to the container via the base Container class's fetch().
 *
 * On boot, the control server reads WL_UPSTREAM, DOLTHUB_TOKEN, and
 * DOLTHUB_ORG from its environment (injected via envVars) and runs
 * `wl join` automatically — no callback to the worker required.
 */
export declare class WastelandContainerDO extends Container<Env> {
    defaultPort: number;
    sleepAfter: string;
    envVars: Record<string, string>;
    constructor(ctx: DurableObjectState<Env>, env: Env);
    /**
     * Store an env var that will be injected into the container OS environment.
     * Takes effect on the next container boot (or immediately if the container
     * hasn't started yet). Call this from the WastelandDO when storing credentials.
     */
    setEnvVar(key: string, value: string): Promise<void>;
    deleteEnvVar(key: string): Promise<void>;
    onStart(): void;
    onStop({ exitCode, reason }: {
        exitCode: number;
        reason: string;
    }): void;
    onError(error: unknown): void;
}
export declare function getWastelandContainerStub(env: Env, wastelandId: string): DurableObjectStub<WastelandContainerDO>;
