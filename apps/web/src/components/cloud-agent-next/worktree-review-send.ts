import { z } from 'zod';
import {
  formatSessionError,
  parseCustomerBillingFailure,
  type KiloSessionId,
  type CloudAgentSessionId,
} from '@kilocode/cloud-agent-sdk';
import type { CloudAgentSendPayload } from '@kilocode/cloud-agent-sdk/transport';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import { errorShapeSchema } from '@kilocode/cloud-agent-sdk/schemas';
import { cloudAgentWorktreeIdSchema, sessionIdSchema } from '@kilocode/session-ingest-contracts';
import { normalizeAlias } from './session-config';

export type WorktreeReviewSubmission = {
  destinationKiloSessionId: KiloSessionId;
  destinationCloudAgentSessionId: CloudAgentSessionId;
  organizationId?: string;
  expectedWorktreeId: string;
  messageId: string;
  payload: Extract<CloudAgentSendPayload, { type: 'prompt' }>;
};

export type WorktreeReviewSendResult =
  | { status: 'accepted'; delivery: 'sent' | 'queued' }
  | { status: 'rejected' | 'unknown'; error: string };

export type WorktreeReviewConfiguration = {
  mode: string;
  model: string;
  variant?: string;
};

export type PrepareReviewSubmissionInput = {
  destinationKiloSessionId: string;
  expectedWorktreeId: string;
  prompt: string;
  configuration?: WorktreeReviewConfiguration;
};

export type WorktreeReviewSendApi = {
  prepareReviewSubmission: (
    input: PrepareReviewSubmissionInput
  ) => Promise<WorktreeReviewSubmission>;
  submitReview: (submission: WorktreeReviewSubmission) => Promise<WorktreeReviewSendResult>;
};

type ReviewTarget = {
  session_id: string;
  cloud_agent_session_id: string | null;
  cloud_agent_worktree_id: string | null;
  organization_id: string | null;
  created_on_platform: string;
  runtimeState: {
    sessionId: string;
    kiloSessionId?: string;
    orgId?: string;
    preparedAt?: number;
    mode?: string;
    model?: string;
    variant?: string;
    runtimeAgents?: Array<{ slug: string; model?: string; variant?: string }>;
  } | null;
};

type ReviewMessageResult = {
  cloudAgentSessionId: string;
  messageId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  acceptedAt?: number;
};

type ReviewSendDependencies = {
  organizationId?: string;
  getSession: (kiloSessionId: string) => Promise<ReviewTarget>;
  send: (submission: WorktreeReviewSubmission) => Promise<{
    cloudAgentSessionId: string;
    messageId: string;
    delivery: 'sent' | 'queued';
  }>;
  getMessageResult: (submission: WorktreeReviewSubmission) => Promise<ReviewMessageResult | null>;
};

const controlPlaneSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const promptSchema = z
  .string()
  .min(1)
  .max(CLOUD_AGENT_PROMPT_MAX_LENGTH)
  .refine(prompt => prompt.trim().length > 0);
const builtinModes = new Set(['code', 'plan', 'debug', 'orchestrator', 'ask']);

function reviewError(error: unknown): string {
  const failure = parseCustomerBillingFailure(error);
  if (failure?.code === 'COMPUTE_STOPPING') {
    return 'Cloud Agent is saving and stopping compute. Try again after shutdown completes.';
  }
  if (failure?.code === 'BILLING_UNAVAILABLE') {
    return 'Cloud Agent cannot verify compute billing right now. Please try again.';
  }
  return formatSessionError(error);
}

function isAdmissionRejection(error: unknown): boolean {
  if (parseCustomerBillingFailure(error)) return true;
  const parsed = errorShapeSchema.safeParse(error);
  if (!parsed.success) return false;
  const code = parsed.data.data?.code ?? parsed.data.shape?.data?.code ?? parsed.data.shape?.code;
  return (
    typeof code === 'string' &&
    [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'PAYMENT_REQUIRED',
      'PRECONDITION_FAILED',
      'UNPROCESSABLE_CONTENT',
      'TOO_MANY_REQUESTS',
      'CONFLICT',
    ].includes(code)
  );
}

export function createWorktreeReviewSend(deps: ReviewSendDependencies): WorktreeReviewSendApi {
  const submissions = new WeakMap<
    WorktreeReviewSubmission,
    {
      attempted: boolean;
      result?: WorktreeReviewSendResult;
      inFlight?: Promise<WorktreeReviewSendResult>;
    }
  >();

  async function prepareReviewSubmission({
    destinationKiloSessionId,
    expectedWorktreeId,
    prompt,
    configuration,
  }: PrepareReviewSubmissionInput): Promise<WorktreeReviewSubmission> {
    const selectedConfiguration = configuration ? { ...configuration } : undefined;
    if (
      !sessionIdSchema.safeParse(destinationKiloSessionId).success ||
      !cloudAgentWorktreeIdSchema.safeParse(expectedWorktreeId).success ||
      !promptSchema.safeParse(prompt).success
    ) {
      throw new Error('Choose a worktree chat and provide a review of at most 100,000 characters.');
    }
    let target: ReviewTarget;
    try {
      target = await deps.getSession(destinationKiloSessionId);
    } catch (error) {
      throw new Error(reviewError(error));
    }
    const runtime = target.runtimeState;
    const cloudId = target.cloud_agent_session_id;
    if (
      target.session_id !== destinationKiloSessionId ||
      (target.organization_id ?? undefined) !== deps.organizationId ||
      target.cloud_agent_worktree_id !== expectedWorktreeId ||
      target.created_on_platform !== 'cloud-agent-web' ||
      !cloudId ||
      !controlPlaneSessionIdSchema.safeParse(cloudId).success ||
      !runtime ||
      runtime.sessionId !== cloudId ||
      runtime.kiloSessionId !== target.session_id ||
      runtime.orgId !== deps.organizationId
    ) {
      throw new Error('The destination must be an available chat in this worktree and account.');
    }
    const mode = normalizeAlias(selectedConfiguration?.mode ?? runtime.mode);
    const agent = runtime.runtimeAgents?.find(agent => agent.slug === mode);
    const pinnedModel = agent?.model?.trim() || undefined;
    const model = pinnedModel ?? selectedConfiguration?.model ?? runtime.model;
    const variant = pinnedModel
      ? agent?.variant?.trim() || undefined
      : selectedConfiguration
        ? selectedConfiguration.variant
        : runtime.variant;
    if (!mode || (!builtinModes.has(mode) && !agent) || !model?.trim()) {
      throw new Error('The destination chat does not have an available agent and model.');
    }
    const submission: WorktreeReviewSubmission = Object.freeze({
      destinationKiloSessionId: target.session_id as KiloSessionId,
      destinationCloudAgentSessionId: cloudId as CloudAgentSessionId,
      organizationId: deps.organizationId,
      expectedWorktreeId,
      messageId: generateMessageId(),
      payload: Object.freeze({
        type: 'prompt',
        prompt,
        mode,
        model,
        variant,
      }),
    });
    submissions.set(submission, { attempted: false });
    return submission;
  }

  async function reconcile(
    submission: WorktreeReviewSubmission
  ): Promise<Extract<WorktreeReviewSendResult, { status: 'accepted' }> | null> {
    const result = await deps.getMessageResult(submission);
    if (!result) return null;
    if (
      result.cloudAgentSessionId !== submission.destinationCloudAgentSessionId ||
      result.messageId !== submission.messageId
    ) {
      throw new Error('Message result does not match the review.');
    }
    return {
      status: 'accepted',
      delivery: result.status === 'running' || result.acceptedAt !== undefined ? 'sent' : 'queued',
    };
  }

  function submitReview(submission: WorktreeReviewSubmission): Promise<WorktreeReviewSendResult> {
    const state = submissions.get(submission);
    if (!state) {
      return Promise.resolve({
        status: 'rejected',
        error: 'Prepare this review before sending it.',
      });
    }
    if (state.inFlight) return state.inFlight;
    if (state.result?.status === 'accepted') return Promise.resolve(state.result);
    const wasUnknown = state.result?.status === 'unknown';
    const attempt = async (): Promise<WorktreeReviewSendResult> => {
      if (state.attempted) {
        try {
          const accepted = await reconcile(submission);
          if (accepted) return accepted;
        } catch (error) {
          return { status: 'unknown', error: reviewError(error) };
        }
      }
      state.attempted = true;
      try {
        const result = await deps.send(submission);
        if (
          result.cloudAgentSessionId !== submission.destinationCloudAgentSessionId ||
          result.messageId !== submission.messageId
        ) {
          throw new Error('Send response does not match the review.');
        }
        return { status: 'accepted', delivery: result.delivery };
      } catch (error) {
        try {
          const accepted = await reconcile(submission);
          if (accepted) return accepted;
        } catch {
          if (wasUnknown || !isAdmissionRejection(error)) {
            return { status: 'unknown', error: reviewError(error) };
          }
        }
        return {
          status: wasUnknown || !isAdmissionRejection(error) ? 'unknown' : 'rejected',
          error: reviewError(error),
        };
      }
    };
    state.inFlight = attempt().then(result => {
      state.result = result;
      state.inFlight = undefined;
      return result;
    });
    return state.inFlight;
  }

  return { prepareReviewSubmission, submitReview };
}
