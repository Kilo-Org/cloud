import { describe, expect, it } from 'vitest';
import { CloudAgentRunFailureClassifications } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { CONTROL_PLANE_FAILURE_REASON_VALUES } from '../shared/control-plane-protocol.js';
import {
  classifyControlPlaneFailure,
  classifyControlPlaneRunFailure,
  type ControlPlaneDispatchState,
} from './control-plane-failure.js';

const validPairs = new Set(
  CloudAgentRunFailureClassifications.map(
    classification => `${classification.failureStage}:${classification.failureCode}`
  )
);

type Status = 'failed' | 'interrupted';

const cases: ReadonlyArray<
  readonly [string | undefined, ControlPlaneDispatchState, Status, string, string]
> = [
  // failed: coordinator reasons keep their bounded mapping.
  ['missing_metadata', 'pre_dispatch', 'failed', 'pre_dispatch', 'session_metadata_missing'],
  ['missing_metadata', 'accepted', 'failed', 'pre_dispatch', 'session_metadata_missing'],
  ['preparation_timeout', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['attach_exhausted', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['prompt_exhausted', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['prompt_exhausted', 'pre_dispatch', 'failed', 'pre_dispatch', 'invalid_delivery_request'],
  ['environment_failed', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['environment_failed', 'pre_dispatch', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  ['launch_failed', 'pre_dispatch', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  ['provider_unknown', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['provider_unknown', 'pre_dispatch', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  ['runtime_unhealthy', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['runtime_unhealthy', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  [
    'health_unhealthy_absent',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  ['health_unhealthy_absent', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  [
    'health_unhealthy_unresponsive',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  [
    'health_unhealthy_unresponsive',
    'pre_dispatch',
    'failed',
    'pre_dispatch',
    'wrapper_start_failed',
  ],
  [
    'environment_stopped',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  ['environment_stopped', 'pre_dispatch', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  [
    'credential_containment_unavailable',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  [
    'credential_containment_unavailable',
    'pre_dispatch',
    'failed',
    'pre_dispatch',
    'sandbox_connect_failed',
  ],
  ['kilo_unhealthy', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['kilo_unhealthy', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['control_replaced', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['control_replaced', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  [
    'control_disconnected',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  ['control_disconnected', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['idle', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['idle', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['heartbeat_expired', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_ping_timeout'],
  ['heartbeat_expired', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['accepted_overdue', 'pre_dispatch', 'failed', 'post_dispatch_no_activity', 'wrapper_no_output'],
  ['invalid_model', 'pre_dispatch', 'failed', 'pre_dispatch', 'model_missing'],
  // failed: a cancellation reason or arbitrary text is never an interruption stage.
  ['queued_message_cancelled', 'pre_dispatch', 'failed', 'unknown', 'unclassified'],
  ['interruption_unconfirmed', 'accepted', 'failed', 'unknown', 'unclassified'],
  [undefined, 'pre_dispatch', 'failed', 'unknown', 'unclassified'],
  ['some_wrapper_reason', 'accepted', 'failed', 'unknown', 'unclassified'],
  ['some wrapper text', 'accepted', 'failed', 'unknown', 'unclassified'],
  // interrupted: the lifecycle status decides, regardless of the reason text.
  ['queued_message_cancelled', 'pre_dispatch', 'interrupted', 'interruption', 'user_interrupt'],
  ['interruption_unconfirmed', 'accepted', 'interrupted', 'interruption', 'user_interrupt'],
  [undefined, 'pre_dispatch', 'interrupted', 'interruption', 'system_interrupt'],
  ['missing_metadata', 'pre_dispatch', 'interrupted', 'interruption', 'system_interrupt'],
  ['preparation_timeout', 'accepted', 'interrupted', 'interruption', 'system_interrupt'],
  ['some_wrapper_reason', 'accepted', 'interrupted', 'interruption', 'system_interrupt'],
  // The new plane's Stop/cancel reason maps to a user interruption.
  ['interrupted', 'pre_dispatch', 'interrupted', 'interruption', 'user_interrupt'],
  // The spec §10 reasons for the new plane (the mapping's one owner).
  ['workspace_setup_failed', 'pre_dispatch', 'failed', 'pre_dispatch', 'workspace_setup_failed'],
  ['workspace_setup_failed', 'accepted', 'failed', 'pre_dispatch', 'workspace_setup_failed'],
  ['billing_blocked', 'pre_dispatch', 'failed', 'pre_dispatch', 'payment_required'],
  ['billing_blocked', 'accepted', 'failed', 'pre_dispatch', 'payment_required'],
  ['container_limit_reached', 'pre_dispatch', 'failed', 'pre_dispatch', 'container_limit_reached'],
  ['container_limit_reached', 'accepted', 'failed', 'pre_dispatch', 'container_limit_reached'],
  ['invalid_configuration', 'pre_dispatch', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  ['invalid_configuration', 'accepted', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  [
    'billing_unavailable',
    'pre_dispatch',
    'failed',
    'pre_dispatch',
    'admission_billing_unavailable',
  ],
  ['billing_unavailable', 'accepted', 'failed', 'pre_dispatch', 'admission_billing_unavailable'],
  ['agent_unavailable', 'pre_dispatch', 'failed', 'pre_dispatch', 'kilo_server_failed'],
  ['agent_unavailable', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['connection_lost', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  [
    'connection_lost',
    'pre_dispatch',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  ['sandbox_lost', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['agent_restarted', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  [
    'sandbox_out_of_memory',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_disconnected',
  ],
  ['agent_unresponsive', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['no_progress', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_no_output'],
  ['no_outcome', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_no_output'],
  [
    'prompt_failed',
    'accepted',
    'failed',
    'post_dispatch_no_activity',
    'wrapper_error_before_activity',
  ],
  ['sandbox_stopped', 'accepted', 'failed', 'interruption', 'system_interrupt'],
  ['execution_limit', 'accepted', 'failed', 'interruption', 'system_interrupt'],
  ['sandbox_stopped', 'accepted', 'interrupted', 'interruption', 'system_interrupt'],
  ['execution_limit', 'accepted', 'interrupted', 'interruption', 'system_interrupt'],
];

describe('classifyControlPlaneFailure', () => {
  it('attributes quota denial to account capacity rather than provider or wrapper failure', () => {
    expect(
      classifyControlPlaneRunFailure({
        reason: 'container_limit_reached',
        dispatchState: 'pre_dispatch',
        status: 'failed',
      })
    ).toEqual({
      stage: 'pre_dispatch',
      code: 'container_limit_reached',
      reportStatus: 'failed',
      responsibility: 'user',
      failureReason: 'container_limit_reached',
    });
  });
  it('attributes Vercel billing credit denial to the user and admission outage to the platform', () => {
    expect(
      classifyControlPlaneRunFailure({
        reason: 'billing_blocked',
        dispatchState: 'pre_dispatch',
        status: 'failed',
      })
    ).toMatchObject({
      stage: 'pre_dispatch',
      code: 'payment_required',
      responsibility: 'user',
      failureReason: 'insufficient_credits',
    });
    expect(
      classifyControlPlaneRunFailure({
        reason: 'billing_unavailable',
        dispatchState: 'pre_dispatch',
        status: 'failed',
      })
    ).toMatchObject({
      stage: 'pre_dispatch',
      code: 'admission_billing_unavailable',
      responsibility: 'platform',
      failureReason: 'admission_billing_unavailable',
    });
  });
  it.each(cases)(
    'maps %s at %s for %s to %s/%s',
    (reason, dispatchState, status, failureStage, failureCode) => {
      expect(classifyControlPlaneFailure(reason, dispatchState, status)).toEqual({
        stage: failureStage,
        code: failureCode,
      });
    }
  );

  it('only returns valid reporting classifications', () => {
    for (const [reason, dispatchState, status] of cases) {
      const classification = classifyControlPlaneFailure(reason, dispatchState, status);
      expect(validPairs.has(`${classification.stage}:${classification.code}`)).toBe(true);
    }
  });

  it('never reports an interruption stage for a failed run', () => {
    for (const [reason, dispatchState] of [
      ['queued_message_cancelled', 'pre_dispatch'],
      ['interruption_unconfirmed', 'accepted'],
      [undefined, 'pre_dispatch'],
      ['missing_metadata', 'pre_dispatch'],
    ] as const) {
      expect(classifyControlPlaneFailure(reason, dispatchState, 'failed').stage).not.toBe(
        'interruption'
      );
    }
  });

  it('maps every new-plane failure reason to an allowed classification', () => {
    for (const reason of CONTROL_PLANE_FAILURE_REASON_VALUES) {
      for (const dispatchState of ['pre_dispatch', 'accepted'] as const) {
        for (const status of ['failed', 'interrupted'] as const) {
          const classification = classifyControlPlaneFailure(reason, dispatchState, status);
          expect(validPairs.has(`${classification.stage}:${classification.code}`)).toBe(true);
        }
      }
    }
  });
});
