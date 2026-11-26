// The part of the workerd module the test fixtures use; the package does not depend on the
// generated Workers types.
declare module 'cloudflare:workers' {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
