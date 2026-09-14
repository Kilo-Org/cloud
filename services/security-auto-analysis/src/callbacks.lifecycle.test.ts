import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { transitionAnalysisCallbackLifecycle } from './analysis-start-lifecycle.js';
import {
  getActiveAnalysisAttemptToken,
  getAnalysisActorById,
  getSecurityFindingById,
} from './db/queries.js';
import { generateApiToken } from './token.js';
import { extractSandboxAnalysis } from './extraction.js';
import { maybeAutoDismissCompletedAnalysis } from './auto-dismiss.js';
import { trackSecurityAnalysisCompleted } from './posthog.js';
import {
  dispatchSecurityLifecycleEventForFinding,
  maybeAdmitAutoRemediationForCompletedAnalysis,
} from './remediation.js';
import {
  finalizeCompletedAnalysisCallbackFromEnv,
  finalizeFailedAnalysisCallbackFromEnv,
} from './callbacks.js';

vi.mock('./analysis-start-lifecycle.js', () => ({
  transitionAnalysisCallbackLifecycle: vi.fn(),
}));

vi.mock('./db/queries.js', () => ({
  getSecurityFindingById: vi.fn(),
  getActiveAnalysisAttemptToken: vi.fn(),
  getAnalysisActorById: vi.fn(),
}));

vi.mock('./token.js', () => ({
  generateApiToken: vi.fn(),
}));

vi.mock('./extraction.js', () => ({
  extractSandboxAnalysis: vi.fn(),
}));

vi.mock('./auto-dismiss.js', () => ({
  maybeAutoDismissCompletedAnalysis: vi.fn(),
}));

vi.mock('./posthog.js', () => ({
  trackSecurityAnalysisCompleted: vi.fn(),
}));

vi.mock('./remediation.js', () => ({
  maybeAdmitAutoRemediationForCompletedAnalysis: vi.fn(),
  dispatchSecurityLifecycleEventForFinding: vi.fn(),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTEMPT_TOKEN = 'attempt-token-123';
const db = {} as never;

const env = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
  NEXTAUTH_SECRET: { get: vi.fn().mockResolvedValue('nextauth-secret') },
  ENVIRONMENT: 'development',
  KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
  SESSION_INGEST_WORKER_URL: 'https://session-ingest.test',
} as unknown as CloudflareEnv;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorkerDb).mockReturnValue(db);
  vi.mocked(transitionAnalysisCallbackLifecycle).mockResolvedValue({
    status: 'completed',
  } as never);
  vi.mocked(dispatchSecurityLifecycleEventForFinding).mockResolvedValue(undefined);
});

describe('analysis lifecycle push emit wiring', () => {
  it('emits analysis_completed when a completed callback finalizes', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: FINDING_ID,
      session_id: 'agent-123',
      cli_session_id: 'ses-123',
      ignored_reason: null,
      analysis_status: 'running',
      analysis: { triggeredByUserId: 'user-1' },
    } as never);
    vi.mocked(getActiveAnalysisAttemptToken).mockResolvedValue(ATTEMPT_TOKEN);
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      is_admin: false,
    } as never);
    vi.mocked(generateApiToken).mockResolvedValue('api-token');
    vi.mocked(extractSandboxAnalysis).mockResolvedValue({
      isExploitable: false,
      extractionStatus: 'succeeded',
      exploitabilityReasoning: 'No reachable usage',
      usageLocations: [],
      suggestedFix: 'Upgrade package',
      suggestedAction: 'dismiss',
      summary: 'Not exploitable.',
      rawMarkdown: '# Completed analysis',
      analysisAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(maybeAutoDismissCompletedAnalysis).mockResolvedValue(undefined);
    vi.mocked(maybeAdmitAutoRemediationForCompletedAnalysis).mockResolvedValue({
      admitted: false,
      reason: 'monitor_required',
    } as never);
    vi.mocked(trackSecurityAnalysisCompleted).mockResolvedValue(undefined);

    await expect(
      finalizeCompletedAnalysisCallbackFromEnv({
        env,
        findingId: FINDING_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
          lastAssistantMessageText: '# Completed analysis',
        },
      })
    ).resolves.toEqual({ status: 'completed-finalized' });

    expect(dispatchSecurityLifecycleEventForFinding).toHaveBeenCalledWith({
      env,
      db,
      findingId: FINDING_ID,
      event: 'analysis_completed',
    });
  });

  it('emits analysis_failed when a completed callback result text is missing', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: FINDING_ID,
      session_id: 'agent-123',
      cli_session_id: 'ses-123',
      ignored_reason: null,
      analysis_status: 'running',
      analysis: null,
    } as never);
    vi.mocked(getActiveAnalysisAttemptToken).mockResolvedValue(ATTEMPT_TOKEN);

    await expect(
      finalizeCompletedAnalysisCallbackFromEnv({
        env,
        findingId: FINDING_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
        },
      })
    ).resolves.toEqual({ status: 'result-missing' });

    expect(dispatchSecurityLifecycleEventForFinding).toHaveBeenCalledWith({
      env,
      db,
      findingId: FINDING_ID,
      event: 'analysis_failed',
    });
  });

  it('emits analysis_failed when a failed callback finalizes', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: FINDING_ID,
      session_id: 'agent-123',
      cli_session_id: null,
      ignored_reason: null,
      analysis_status: 'running',
    } as never);
    vi.mocked(getActiveAnalysisAttemptToken).mockResolvedValue(ATTEMPT_TOKEN);

    await expect(
      finalizeFailedAnalysisCallbackFromEnv({
        env,
        findingId: FINDING_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'failed',
          errorMessage: 'upstream 503',
        },
      })
    ).resolves.toEqual({ status: 'failed-finalized' });

    expect(dispatchSecurityLifecycleEventForFinding).toHaveBeenCalledWith({
      env,
      db,
      findingId: FINDING_ID,
      event: 'analysis_failed',
    });
  });

  it('does not emit for non-terminal callback dispositions', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: FINDING_ID,
      session_id: 'agent-123',
      cli_session_id: null,
      ignored_reason: null,
      analysis_status: 'failed',
    } as never);
    vi.mocked(getActiveAnalysisAttemptToken).mockResolvedValue(null);

    await expect(
      finalizeFailedAnalysisCallbackFromEnv({
        env,
        findingId: FINDING_ID,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'failed',
          errorMessage: 'upstream 503',
        },
      })
    ).resolves.toEqual({ status: 'already-terminal' });

    expect(dispatchSecurityLifecycleEventForFinding).not.toHaveBeenCalled();
  });

  it('still emits analysis_completed when a post-commit follow-up throws', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: FINDING_ID,
      session_id: 'agent-123',
      cli_session_id: 'ses-123',
      ignored_reason: null,
      analysis_status: 'running',
      analysis: { triggeredByUserId: 'user-1' },
    } as never);
    vi.mocked(getActiveAnalysisAttemptToken).mockResolvedValue(ATTEMPT_TOKEN);
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      is_admin: false,
    } as never);
    vi.mocked(generateApiToken).mockResolvedValue('api-token');
    vi.mocked(extractSandboxAnalysis).mockResolvedValue({
      isExploitable: false,
      extractionStatus: 'succeeded',
      exploitabilityReasoning: 'No reachable usage',
      usageLocations: [],
      suggestedFix: 'Upgrade package',
      suggestedAction: 'dismiss',
      summary: 'Not exploitable.',
      rawMarkdown: '# Completed analysis',
      analysisAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(maybeAutoDismissCompletedAnalysis).mockRejectedValue(
      new Error('auto-dismiss unavailable')
    );
    vi.mocked(maybeAdmitAutoRemediationForCompletedAnalysis).mockRejectedValue(
      new Error('auto-remediate unavailable')
    );
    vi.mocked(trackSecurityAnalysisCompleted).mockRejectedValue(new Error('posthog unavailable'));

    await expect(
      finalizeCompletedAnalysisCallbackFromEnv({
        env,
        findingId: FINDING_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
          lastAssistantMessageText: '# Completed analysis',
        },
      })
    ).resolves.toEqual({ status: 'completed-finalized' });

    expect(dispatchSecurityLifecycleEventForFinding).toHaveBeenCalledWith({
      env,
      db,
      findingId: FINDING_ID,
      event: 'analysis_completed',
    });
  });
});
