type Resolver = (verified: boolean) => void;

/**
 * Keeps at most one step-up dialog request pending. A second request
 * deterministically settles the first as cancelled instead of leaving its
 * promise unresolved when the resolver ref is overwritten.
 */
export class StepUpRequestQueue {
  private pending: Resolver | null = null;

  begin(): Promise<boolean> {
    this.supersedePending();
    return new Promise(resolve => {
      this.pending = resolve;
    });
  }

  settle(verified: boolean): void {
    const resolve = this.pending;
    this.pending = null;
    resolve?.(verified);
  }

  private supersedePending(): void {
    const resolve = this.pending;
    this.pending = null;
    resolve?.(false);
  }
}
