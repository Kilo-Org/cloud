import type { ControlPlaneSandboxPeer } from '../../../src/control-plane/session/session-do.js';
import type { ControlRuntimeCredentialProxyFence } from '../../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxStatusSnapshot } from '../../../src/shared/sandbox-status.js';
import type {
  ControlPlaneAnswerPayload,
  ControlPlaneDeliverPayload,
  ControlPlaneDeliverResult,
  ControlPlanePrepareInput,
  ControlPlaneRouteView,
} from '../../../src/shared/control-plane-protocol.js';

/**
 * A synthetic Sandbox DO peer for the Session DO tests. The real end-to-end
 * path uses the `SANDBOX_CONTROL` binding; state tests inject this to control
 * `prepare`/`deliver` results deterministically.
 */
export class FakeSandboxPeer implements ControlPlaneSandboxPeer {
  readonly fetchCalls: Request[] = [];
  async fetch(request: Request): Promise<Response> {
    this.fetchCalls.push(request);
    return new Response('status-stream');
  }
  /** The route attempt every view/notification from this peer belongs to. */
  attemptId = crypto.randomUUID();
  prepareView: ControlPlaneRouteView = { state: 'preparing', attemptId: this.attemptId };
  deliverResult: ControlPlaneDeliverResult = 'sent';
  /** When set, `prepare` rejects (a transport failure, not a route view). */
  prepareError: Error | null = null;
  deliverDelayMs = 0;
  deliverError: Error | null = null;
  statusError: Error | null = null;
  readonly statusCalls: string[] = [];
  /** Optional fence returned by `getRuntimeCredentialProxyFence` (H4 tests). */
  runtimeCredentialProxyFence: ControlRuntimeCredentialProxyFence | null = null;
  /** The snapshot returned by `getStatusSnapshot` (B10 badge tests). */
  statusSnapshot: SandboxStatusSnapshot = {
    status: 'sleeping',
    provider: 'Cloudflare',
    observedAt: 1,
    detailCode: 'sandbox_stopped',
    inactivityTimeoutMs: 600_000,
    estimatedSleepAt: null,
  };
  /** Optional queues; each call shifts one, then falls back to the scalar. */
  prepareViews: ControlPlaneRouteView[] = [];
  deliverResults: ControlPlaneDeliverResult[] = [];
  readonly prepareCalls: ControlPlanePrepareInput[] = [];
  readonly deliverCalls: ControlPlaneDeliverPayload[] = [];
  readonly abortCalls: string[] = [];
  readonly answerCalls: ControlPlaneAnswerPayload[] = [];

  /** A view/update carrying this peer's attempt id, for direct `onRoute` calls. */
  view(state: 'preparing' | 'ready' | 'reconnecting'): ControlPlaneRouteView {
    return { state, attemptId: this.attemptId };
  }

  async prepare(input: ControlPlanePrepareInput): Promise<ControlPlaneRouteView> {
    this.prepareCalls.push(input);
    if (this.prepareError !== null) throw this.prepareError;
    return injectAttempt(this.prepareViews.shift() ?? this.prepareView, this.attemptId);
  }

  async deliver(payload: ControlPlaneDeliverPayload): Promise<ControlPlaneDeliverResult> {
    this.deliverCalls.push(payload);
    if (this.deliverError !== null) throw this.deliverError;
    if (this.deliverDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.deliverDelayMs));
    }
    return this.deliverResults.shift() ?? this.deliverResult;
  }

  async abort(payload: { sessionId: string }): Promise<'sent'> {
    this.abortCalls.push(payload.sessionId);
    return 'sent';
  }

  async answer(payload: ControlPlaneAnswerPayload): Promise<'sent'> {
    this.answerCalls.push(payload);
    return 'sent';
  }

  async release(): Promise<void> {}

  async status(payload: { sessionId: string }) {
    this.statusCalls.push(payload.sessionId);
    if (this.statusError !== null) throw this.statusError;
    return { sessionId: payload.sessionId, view: injectAttempt(this.prepareView, this.attemptId) };
  }

  async getRuntimeCredentialProxyFence(): Promise<ControlRuntimeCredentialProxyFence | null> {
    return this.runtimeCredentialProxyFence;
  }

  async getStatusSnapshot(): Promise<SandboxStatusSnapshot> {
    return this.statusSnapshot;
  }
}

function injectAttempt(view: ControlPlaneRouteView, attemptId: string): ControlPlaneRouteView {
  return view.state === 'unknown' ? view : { ...view, attemptId };
}
