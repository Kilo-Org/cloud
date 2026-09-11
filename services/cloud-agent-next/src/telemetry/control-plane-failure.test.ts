import { describe, expect, it } from 'vitest';
import { CloudAgentRunFailureClassifications } from '@kilocode/worker-utils/cloud-agent-queue-report';
import {
  classifyControlPlaneFailure,
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
  ['provider_unknown', 'accepted', 'failed', 'pre_dispatch', 'sandbox_connect_failed'],
  ['runtime_unhealthy', 'accepted', 'failed', 'post_dispatch_no_activity', 'wrapper_disconnected'],
  ['runtime_unhealthy', 'pre_dispatch', 'failed', 'pre_dispatch', 'wrapper_start_failed'],
  ['accepted_overdue', 'pre_dispatch', 'failed', 'post_dispatch_no_activity', 'wrapper_no_output'],
  ['invalid_model', 'pre_dispatch', 'failed', 'pre_dispatch', 'model_missing'],
  // failed: a cancellation reason or arbitrary text is never an interruption stage.
  ['queued_message_cancelled', 'pre_dispatch', 'failed', 'unknown', 'unclassified'],
  ['interruption_unconfirmed', 'accepted', 'failed', 'unknown', 'unclassified'],
  [undefined, 'pre_dispatch', 'failed', 'unknown', 'unclassified'],
  ['some_wrapper_reason', 'accepted', 'failed', 'unknown', 'unclassified'],
  // interrupted: the lifecycle status decides, regardless of the reason text.
  ['queued_message_cancelled', 'pre_dispatch', 'interrupted', 'interruption', 'user_interrupt'],
  ['interruption_unconfirmed', 'accepted', 'interrupted', 'interruption', 'user_interrupt'],
  [undefined, 'pre_dispatch', 'interrupted', 'interruption', 'system_interrupt'],
  ['missing_metadata', 'pre_dispatch', 'interrupted', 'interruption', 'system_interrupt'],
  ['preparation_timeout', 'accepted', 'interrupted', 'interruption', 'system_interrupt'],
  ['some_wrapper_reason', 'accepted', 'interrupted', 'interruption', 'system_interrupt'],
];

describe('classifyControlPlaneFailure', () => {
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
});
