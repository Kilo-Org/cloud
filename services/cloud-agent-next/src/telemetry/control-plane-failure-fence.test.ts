import { describe, expect, it } from 'vitest';
import {
  CLOUD_AGENT_ASSISTANT_FAILURE_REASONS,
  CLOUD_AGENT_PROVIDER_OWNERSHIPS,
  WORKSPACE_FAILURE_SUBTYPES,
  type CloudAgentAssistantFailureReason,
  type CloudAgentFailureCode,
  type CloudAgentFailureReason,
  type CloudAgentFailureResponsibility,
  type CloudAgentFailureStage,
  type CloudAgentProviderOwnership,
  type WorkspaceFailureSubtype,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { CloudAgentRunFailureClassifications } from '@kilocode/worker-utils/cloud-agent-queue-report';
import {
  CLOUD_AGENT_ASSISTANT_FAILURE_REASON_VALUES,
  CLOUD_AGENT_PROVIDER_OWNERSHIP_VALUES,
  CLOUD_AGENT_WORKSPACE_FAILURE_SUBTYPE_VALUES,
} from '../shared/sandbox-control-protocol.js';
import { resolveAssistantProviderOwnership } from '../shared/assistant-failure.js';
import {
  classifyControlPlaneRunFailure,
  type ControlPlaneDispatchState,
} from './control-plane-failure.js';

const validPairs = new Set(
  CloudAgentRunFailureClassifications.map(
    classification => `${classification.failureStage}:${classification.failureCode}`
  )
);

type FenceCase = {
  name: string;
  reason: string | undefined;
  dispatchState: ControlPlaneDispatchState;
  status: 'failed' | 'interrupted';
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
  admittedModel?: string;
  workspaceSubtype?: WorkspaceFailureSubtype;
  stage: CloudAgentFailureStage;
  code: CloudAgentFailureCode;
  responsibility?: CloudAgentFailureResponsibility;
  failureReason?: CloudAgentFailureReason;
};

// Expected values are authored from the reporting taxonomy and the approved
// mapping table, not from running the classifier.
const cases: readonly FenceCase[] = [
  {
    name: 'rate_limited managed assistant failure',
    reason: undefined,
    dispatchState: 'pre_dispatch',
    status: 'failed',
    assistantReason: 'rate_limited',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'provider',
    failureReason: 'rate_limited',
  },
  {
    name: 'model_unavailable maps to model_missing',
    reason: undefined,
    dispatchState: 'pre_dispatch',
    status: 'failed',
    assistantReason: 'model_unavailable',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'model_missing',
    responsibility: 'provider',
    failureReason: 'model_unavailable',
  },
  {
    name: 'insufficient_credits maps to payment_required',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'insufficient_credits',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'payment_required',
    responsibility: 'user',
    failureReason: 'insufficient_credits',
  },
  {
    name: 'managed provider authentication',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'provider_authentication',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'platform',
    failureReason: 'managed_provider_authentication',
  },
  {
    name: 'byok provider authentication',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'provider_authentication',
    providerOwnership: 'byok',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'user',
    failureReason: 'provider_authentication',
  },
  {
    name: 'unknown ownership without an admitted model',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'provider_authentication',
    providerOwnership: 'unknown',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'unknown',
    failureReason: 'provider_ownership_unknown',
  },
  {
    name: 'managed timeout',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'timeout',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'provider',
    failureReason: 'request_timeout',
  },
  {
    name: 'managed provider unavailable',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'provider_unavailable',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'provider',
    failureReason: 'managed_provider_unavailable',
  },
  {
    name: 'context limit',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'context_limit',
    providerOwnership: 'unknown',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'provider',
    failureReason: 'assistant_context_limit',
  },
  {
    name: 'output limit',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'output_limit',
    providerOwnership: 'unknown',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'provider',
    failureReason: 'assistant_output_limit',
  },
  {
    name: 'content filter',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'content_filter',
    providerOwnership: 'unknown',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'user',
    failureReason: 'assistant_content_filter',
  },
  {
    name: 'byok invalid request',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'invalid_request',
    providerOwnership: 'byok',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'user',
    failureReason: 'assistant_invalid_request',
  },
  {
    name: 'managed invalid request',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'invalid_request',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'platform',
    failureReason: 'assistant_invalid_request',
  },
  {
    name: 'structured output',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'structured_output',
    providerOwnership: 'unknown',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'platform',
    failureReason: 'assistant_structured_output',
  },
  {
    name: 'unrecognized assistant reason',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    assistantReason: 'unknown',
    providerOwnership: 'unknown',
    admittedModel: 'kilo/example',
    stage: 'agent_activity',
    code: 'assistant_error',
    responsibility: 'unknown',
    failureReason: 'assistant_unknown',
  },
  {
    name: 'arbitrary wrapper text without facts',
    reason: 'arbitrary wrapper text',
    dispatchState: 'accepted',
    status: 'failed',
    admittedModel: 'kilo/example',
    stage: 'unknown',
    code: 'unclassified',
    responsibility: 'unknown',
    failureReason: 'unclassified',
  },
  {
    name: 'missing reason without facts',
    reason: undefined,
    dispatchState: 'accepted',
    status: 'failed',
    admittedModel: 'kilo/example',
    stage: 'unknown',
    code: 'unclassified',
    responsibility: 'unknown',
    failureReason: 'unclassified',
  },
  {
    name: 'environment_stopped accepted',
    reason: 'environment_stopped',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'post_dispatch_no_activity',
    code: 'wrapper_disconnected',
    responsibility: 'platform',
    failureReason: 'wrapper_disconnected',
  },
  {
    name: 'kilo_unhealthy pre-dispatch',
    reason: 'kilo_unhealthy',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    stage: 'pre_dispatch',
    code: 'wrapper_start_failed',
    responsibility: 'platform',
    failureReason: 'runtime_startup',
  },
  {
    name: 'heartbeat_expired accepted',
    reason: 'heartbeat_expired',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'post_dispatch_no_activity',
    code: 'wrapper_ping_timeout',
    responsibility: 'platform',
    failureReason: 'wrapper_liveness',
  },
  {
    name: 'control_replaced accepted',
    reason: 'control_replaced',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'post_dispatch_no_activity',
    code: 'wrapper_disconnected',
    responsibility: 'platform',
    failureReason: 'wrapper_disconnected',
  },
  {
    name: 'credential_containment_unavailable pre-dispatch',
    reason: 'credential_containment_unavailable',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    stage: 'pre_dispatch',
    code: 'sandbox_connect_failed',
    responsibility: 'platform',
    failureReason: 'sandbox_connectivity',
  },
  {
    name: 'health_unhealthy_unresponsive accepted',
    reason: 'health_unhealthy_unresponsive',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'post_dispatch_no_activity',
    code: 'wrapper_disconnected',
    responsibility: 'platform',
    failureReason: 'wrapper_disconnected',
  },
  {
    name: 'health_unhealthy_absent accepted',
    reason: 'health_unhealthy_absent',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'post_dispatch_no_activity',
    code: 'wrapper_disconnected',
    responsibility: 'platform',
    failureReason: 'wrapper_disconnected',
  },
  {
    name: 'idle accepted',
    reason: 'idle',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'post_dispatch_no_activity',
    code: 'wrapper_disconnected',
    responsibility: 'platform',
    failureReason: 'wrapper_disconnected',
  },
  {
    name: 'worktree_deleted stays unclassified',
    reason: 'worktree_deleted',
    dispatchState: 'accepted',
    status: 'failed',
    stage: 'unknown',
    code: 'unclassified',
    responsibility: 'unknown',
    failureReason: 'unclassified',
  },
  // An attach rejection that carries a git subtype is a workspace setup
  // failure, not `wrapper_start_failed / runtime_startup`. Expected values are
  // authored from the subtype→reason mapping, not from the classifier.
  {
    name: 'attach clone rate limit is a workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'git_rate_limited',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'platform',
    failureReason: 'rate_limited',
  },
  {
    name: 'attach clone timeout is a workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'git_clone_timeout',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'platform',
    failureReason: 'source_control_clone_timeout',
  },
  {
    name: 'attach checkout timeout is a workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'git_checkout_timeout',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'platform',
    failureReason: 'source_control_checkout_timeout',
  },
  {
    name: 'attach network failure is a workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'git_network_failed',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'platform',
    failureReason: 'source_control_network',
  },
  {
    name: 'attach authentication failure is a user workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'git_authentication_failed',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'user',
    failureReason: 'source_control_authentication',
  },
  {
    name: 'attach storage exhaustion is a platform workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'sandbox_storage_full',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'platform',
    failureReason: 'sandbox_capacity',
  },
  {
    name: 'attach unknown git failure stays a workspace setup failure',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    workspaceSubtype: 'workspace_setup_unknown',
    stage: 'pre_dispatch',
    code: 'workspace_setup_failed',
    responsibility: 'unknown',
    failureReason: 'workspace_unknown',
  },
  {
    name: 'attach without a subtype keeps wrapper_start_failed',
    reason: 'attach_exhausted',
    dispatchState: 'pre_dispatch',
    status: 'failed',
    stage: 'pre_dispatch',
    code: 'wrapper_start_failed',
    responsibility: 'platform',
    failureReason: 'runtime_startup',
  },
  {
    name: 'interrupted run carries no responsibility',
    reason: undefined,
    dispatchState: 'pre_dispatch',
    status: 'interrupted',
    stage: 'interruption',
    code: 'system_interrupt',
  },
];

function run(input: FenceCase) {
  return classifyControlPlaneRunFailure({
    reason: input.reason,
    dispatchState: input.dispatchState,
    status: input.status,
    ...(input.assistantReason === undefined ? {} : { assistantReason: input.assistantReason }),
    ...(input.providerOwnership === undefined
      ? {}
      : { providerOwnership: input.providerOwnership }),
    ...(input.admittedModel === undefined ? {} : { admittedModel: input.admittedModel }),
    ...(input.workspaceSubtype === undefined ? {} : { workspaceSubtype: input.workspaceSubtype }),
  });
}

describe('classifyControlPlaneRunFailure', () => {
  it.each(cases)('$name', testCase => {
    expect(run(testCase)).toEqual({
      stage: testCase.stage,
      code: testCase.code,
      ...(testCase.responsibility === undefined ? {} : { responsibility: testCase.responsibility }),
      ...(testCase.failureReason === undefined ? {} : { failureReason: testCase.failureReason }),
    });
  });

  it('only returns valid reporting classifications', () => {
    for (const testCase of cases) {
      const classification = run(testCase);
      expect(validPairs.has(`${classification.stage}:${classification.code}`)).toBe(true);
    }
  });

  it('keeps the local protocol enums in sync with worker-utils', () => {
    expect(CLOUD_AGENT_ASSISTANT_FAILURE_REASON_VALUES).toEqual(
      CLOUD_AGENT_ASSISTANT_FAILURE_REASONS
    );
    expect(CLOUD_AGENT_PROVIDER_OWNERSHIP_VALUES).toEqual(CLOUD_AGENT_PROVIDER_OWNERSHIPS);
    expect(CLOUD_AGENT_WORKSPACE_FAILURE_SUBTYPE_VALUES).toEqual(WORKSPACE_FAILURE_SUBTYPES);
  });
});

describe('resolveAssistantProviderOwnership', () => {
  it('preserves a byok marker', () => {
    expect(resolveAssistantProviderOwnership('byok', 'rate_limited', 'kilo/example')).toBe('byok');
  });

  it('returns the supplied ownership when no assistant reason is present', () => {
    expect(resolveAssistantProviderOwnership('unknown', undefined, 'kilo/example')).toBe('unknown');
    expect(resolveAssistantProviderOwnership(undefined, undefined, 'kilo/example')).toBeUndefined();
  });

  it('fills managed when an admitted model exists', () => {
    expect(resolveAssistantProviderOwnership('unknown', 'rate_limited', 'kilo/example')).toBe(
      'managed'
    );
    expect(resolveAssistantProviderOwnership(undefined, 'rate_limited', 'kilo/example')).toBe(
      'managed'
    );
  });

  it('leaves the supplied ownership unchanged when the admitted model is missing', () => {
    expect(resolveAssistantProviderOwnership('unknown', 'rate_limited', undefined)).toBe('unknown');
    expect(resolveAssistantProviderOwnership(undefined, 'rate_limited', undefined)).toBeUndefined();
  });
});
