import {
  WORKTREE_RUNTIME_HEADER,
  WORKTREE_RUNTIME_VERSION,
} from '../../../src/shared/control-plane-runtime-contract.js';
import { SELF } from 'cloudflare:test';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_TURN_COVERAGE_HEADER,
  CONTROL_PLANE_TURN_COVERAGE_VERSION,
  controlPlaneWrapperFrameSchema,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';

export type FakeWrapperConnectInput = {
  sandboxId: string;
  credential: string;
  path?: string;
  runtimeContract?: 'legacy' | 'worktree';
  turnCoverage?: boolean;
};

export type FakeWrapperHelloInput = {
  wrapperId: string;
  allocationId: string;
  protocolVersion?: number;
  redactsNamedSecrets?: boolean;
};

export type FakeNativeEvent = {
  type: string;
  properties: Record<string, unknown>;
  timestamp?: string;
};

/**
 * A synthetic peer for the control-plane wrapper socket. It speaks the V2 frame
 * protocol directly so integration tests can drive the Sandbox DO without a
 * container or the real wrapper.
 */
export class FakeWrapper {
  private readonly messages: ControlPlaneWrapperFrame[] = [];
  private readonly frameWaiters: Array<(frame: ControlPlaneWrapperFrame | null) => void> = [];
  private readonly closeWaiters: Array<(code: number) => void> = [];
  private readonly listeners = new Set<(frame: ControlPlaneWrapperFrame) => void>();
  private readonly unparsed: string[] = [];
  private closeCode: number | null = null;
  private received = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let frame: ControlPlaneWrapperFrame;
      try {
        frame = controlPlaneWrapperFrameSchema.parse(JSON.parse(text));
      } catch {
        // A frame the Worker produced outside the protocol would otherwise
        // vanish. Keep it so a test can assert the Worker never did that.
        this.unparsed.push(text);
        return;
      }
      this.received += 1;
      for (const listener of this.listeners) listener(frame);
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter(frame);
      else this.messages.push(frame);
    });
    socket.addEventListener('close', event => {
      this.closeCode = event.code;
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter(null);
      for (const resolve of this.closeWaiters.splice(0)) resolve(event.code);
    });
    socket.addEventListener('error', () => undefined);
  }

  static async connect(input: FakeWrapperConnectInput): Promise<FakeWrapper> {
    const path = input.path ?? `/sandbox-control-v2/${encodeURIComponent(input.sandboxId)}`;
    const response = await SELF.fetch(`http://worker.test${path}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${input.credential}`,
        ...(input.runtimeContract === 'legacy'
          ? {}
          : { [WORKTREE_RUNTIME_HEADER]: WORKTREE_RUNTIME_VERSION }),
        ...(input.turnCoverage
          ? { [CONTROL_PLANE_TURN_COVERAGE_HEADER]: CONTROL_PLANE_TURN_COVERAGE_VERSION }
          : {}),
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected sandbox control v2 upgrade: ${response.status}`);
    }
    response.webSocket.accept();
    return new FakeWrapper(response.webSocket);
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** How many frames this wrapper has received, consumed or queued. */
  receivedFrames(): number {
    return this.received;
  }

  /** Raw frames the Worker sent that did not match the protocol schema. */
  unparsedFrames(): readonly string[] {
    return [...this.unparsed];
  }

  /** Observe every parsed inbound frame without consuming the queue. */
  onFrame(listener: (frame: ControlPlaneWrapperFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Pushes one native event batch for a session, as the real wrapper does. */
  sendSessionEvents(sessionId: string, events: readonly FakeNativeEvent[]): void {
    this.send({ type: 'session.events', sessionId, events });
  }

  sendRaw(data: string): void {
    this.socket.send(data);
  }

  /** The next frame, or null when the socket closes or the wait times out. */
  next(timeoutMs = 2_000): Promise<ControlPlaneWrapperFrame | null> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closeCode !== null) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter = (frame: ControlPlaneWrapperFrame | null) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        const index = this.frameWaiters.indexOf(waiter);
        if (index >= 0) this.frameWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.frameWaiters.push(waiter);
    });
  }

  /**
   * The next frame whose type is not in `skipped`. Frames the control plane may
   * send in the background, such as the worktree snapshot capture started when a
   * wrapper attaches, can land before the frame a test is waiting for.
   */
  async nextSkipping(
    skipped: readonly ControlPlaneWrapperFrame['type'][],
    timeoutMs = 2_000
  ): Promise<ControlPlaneWrapperFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.next(Math.max(0, deadline - Date.now()));
      if (frame === null || !skipped.includes(frame.type)) return frame;
    }
  }

  async hello(input: FakeWrapperHelloInput): Promise<ControlPlaneWrapperFrame | null> {
    this.send({
      type: 'hello',
      wrapperId: input.wrapperId,
      allocationId: input.allocationId,
      protocolVersion: input.protocolVersion ?? CONTROL_PLANE_PROTOCOL_VERSION,
      ...(input.redactsNamedSecrets ? { redactsNamedSecrets: true } : {}),
    });
    return this.next();
  }

  heartbeat(active: boolean, degraded = false): void {
    this.send({ type: 'heartbeat', active, degraded });
  }

  waitForClose(timeoutMs = 2_000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(-1), timeoutMs);
      this.closeWaiters.push(code => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}
