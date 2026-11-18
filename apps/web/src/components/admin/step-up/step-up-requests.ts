type Resolver = (verified: boolean) => void;

/**
 * One pending verification promise for every caller. Concurrent refused
 * operations share the same dialog and all retry once it settles, instead of
 * cancelling each other and surfacing raw FORBIDDEN errors.
 */
export class StepUpRequestQueue {
  private pending: Promise<boolean> | null = null;
  private resolvePending: Resolver | null = null;

  hasPending(): boolean {
    return this.pending !== null;
  }

  begin(): Promise<boolean> {
    if (this.pending) return this.pending;
    this.pending = new Promise(resolve => {
      this.resolvePending = resolve;
    });
    return this.pending;
  }

  settle(verified: boolean): void {
    const resolve = this.resolvePending;
    this.resolvePending = null;
    this.pending = null;
    resolve?.(verified);
  }
}
