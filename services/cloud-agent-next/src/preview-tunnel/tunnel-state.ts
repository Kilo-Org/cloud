import {
  encodePreviewTunnelFrame,
  type PreviewTunnelFrame,
} from '../shared/preview-tunnel-protocol.js';

/** Late frames for this many recently ended streams are dropped, not a violation. */
export const PREVIEW_TUNNEL_RECENT_IDS = 1024;

/** A bounded set that forgets its oldest id first. */
export class RecentIds {
  private readonly ids = new Set<number>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.ids.size;
  }

  has(id: number): boolean {
    return this.ids.has(id);
  }

  add(id: number): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    if (this.ids.size <= this.limit) return;
    const oldest = this.ids.values().next();
    if (oldest.done !== true) this.ids.delete(oldest.value);
  }
}

export type AckOutcome = 'acked' | 'failed' | 'timeout';

/** The wrapper acknowledges each open with its first frame for the stream. */
export class AckWait {
  private state: 'pending' | 'acked' | 'failed' = 'pending';
  private wake: (() => void) | null = null;

  ack(): void {
    this.settle('acked');
  }

  fail(): void {
    this.settle('failed');
  }

  async wait(ms: number): Promise<AckOutcome> {
    if (this.state === 'pending') {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.state === 'pending' ? 'timeout' : this.state;
  }

  private settle(state: 'acked' | 'failed'): void {
    if (this.state !== 'pending') return;
    this.state = state;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/** The tunnel as one stream sees it. */
export type TunnelPort = {
  /** False when the tunnel socket is gone. */
  send(frame: PreviewTunnelFrame): boolean;
  /** The stream ended; late frames for its id are dropped. */
  finish(id: number): void;
  /** The stream became a browser socket; its id stays open. */
  forget(id: number): void;
};

export type TunnelStream = {
  readonly id: number;
  readonly ack: AckWait;
  /** Handles one frame from the wrapper; returns a violation reason, or null. */
  onFrame(frame: PreviewTunnelFrame): string | null;
  /** The tunnel closed under the stream. */
  fail(): void;
};

/** One connected tunnel socket and the streams that the Durable Object opened on it. */
export class TunnelState implements TunnelPort {
  readonly streams = new Map<number, TunnelStream>();
  readonly recent = new RecentIds(PREVIEW_TUNNEL_RECENT_IDS);
  /** Valid frames from the wrapper; a count that grows shows a live tunnel. */
  framesReceived = 0;

  constructor(
    readonly socket: WebSocket,
    readonly seq: number
  ) {}

  send(frame: PreviewTunnelFrame): boolean {
    try {
      this.socket.send(encodePreviewTunnelFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  finish(id: number): void {
    this.streams.delete(id);
    this.recent.add(id);
  }

  forget(id: number): void {
    this.streams.delete(id);
  }
}
