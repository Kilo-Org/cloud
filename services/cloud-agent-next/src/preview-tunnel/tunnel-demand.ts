/**
 * The Sandbox DO's answer to a tunnel demand: it sent `preview.tunnel` to the
 * bound wrapper, no wrapper is bound, or the bound wrapper has no tunnel.
 */
export type PreviewTunnelDemandResult = 'requested' | 'not_ready' | 'outdated';

export type TunnelWait<T> =
  | { ok: true; tunnel: T }
  | { ok: false; reason: 'not_ready' | 'outdated' | 'unavailable' };

type PendingWait<T> = {
  promise: Promise<TunnelWait<T>>;
  settle: (outcome: TunnelWait<T>) => void;
};

/**
 * One shared wait for a tunnel. The first request asks the Sandbox DO once;
 * the requests that arrive during the wait share it. A tunnel connect ends the
 * wait, and so does the bound.
 */
export class TunnelDemand<T> {
  private pending: PendingWait<T> | null = null;

  constructor(
    private readonly deps: {
      request: () => Promise<PreviewTunnelDemandResult>;
      waitMs: () => number;
    }
  ) {}

  get waiting(): boolean {
    return this.pending !== null;
  }

  wait(): Promise<TunnelWait<T>> {
    if (this.pending !== null) return this.pending.promise;
    let resolve!: (outcome: TunnelWait<T>) => void;
    const promise = new Promise<TunnelWait<T>>(done => {
      resolve = done;
    });
    const settle = (outcome: TunnelWait<T>) => {
      if (this.pending?.promise !== promise) return;
      clearTimeout(timer);
      this.pending = null;
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ ok: false, reason: 'unavailable' }),
      this.deps.waitMs()
    );
    this.pending = { promise, settle };
    Promise.resolve()
      .then(() => this.deps.request())
      .then(
        result => {
          if (result !== 'requested') settle({ ok: false, reason: result });
        },
        () => settle({ ok: false, reason: 'unavailable' })
      );
    return promise;
  }

  /** A tunnel connected: every waiting request uses it. */
  connected(tunnel: T): void {
    this.pending?.settle({ ok: true, tunnel });
  }
}
