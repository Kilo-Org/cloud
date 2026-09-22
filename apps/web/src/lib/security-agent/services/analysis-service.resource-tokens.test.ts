import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { kilocode_users, type SecurityFinding } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { prepareCloudAgentWorkflowUser } from '@/lib/auth/cloud-agent-workflow-user';
import { getSecurityFindingById } from '../db/security-findings';
import { triageSecurityFinding } from './triage-service';
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { startSecurityAnalysis } from './analysis-service';

jest.mock('../db/security-findings', () => ({ getSecurityFindingById: jest.fn() }));
jest.mock('../db/security-analysis', () => ({
  tryAcquireAnalysisStartLease: jest.fn(async () => true),
  updateAnalysisStatus: jest.fn(async () => true),
  clearAnalysisStatus: jest.fn(),
}));
jest.mock('./triage-service', () => ({ triageSecurityFinding: jest.fn() }));
jest.mock('./extraction-service', () => ({ extractSandboxAnalysis: jest.fn() }));
jest.mock('./auto-dismiss-service', () => ({ maybeAutoDismissAnalysis: jest.fn() }));
jest.mock('../posthog-tracking', () => ({
  trackSecurityAgentAnalysisStarted: jest.fn(),
  trackSecurityAgentAnalysisCompleted: jest.fn(),
}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    prepareSession: jest.fn(async () => ({
      cloudAgentSessionId: 'session',
      kiloSessionId: 'kilo',
    })),
    initiateFromPreparedSession: jest.fn(async () => ({})),
  })),
  InsufficientCreditsError: class extends Error {},
}));

const flags = [
  'SHARED_RESOURCE_TOKENS_ENABLED',
  'CLOUD_AGENT_RESOURCE_TOKENS_ENABLED',
  'WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED',
] as const;
const saved = flags.map(key => [key, process.env[key]] as const);
beforeEach(() => {
  jest.clearAllMocks();
  process.env.SHARED_RESOURCE_TOKENS_ENABLED = 'true';
  process.env.CLOUD_AGENT_RESOURCE_TOKENS_ENABLED = 'false';
  process.env.WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED = 'false';
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it.each([
  [false, true],
  [false, false],
  [true, false],
  [true, true],
])(
  'starts security analysis with cloud=%s gateway=%s and a null pepper',
  async (cloud, gateway) => {
    process.env.CLOUD_AGENT_RESOURCE_TOKENS_ENABLED = String(cloud);
    process.env.WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED = String(gateway);
    const user = await insertTestUser({ api_token_pepper: null });
    jest.mocked(getSecurityFindingById).mockResolvedValue({
      id: 'finding',
      owned_by_user_id: user.id,
      owned_by_organization_id: null,
      status: 'open',
      source: 'dependabot',
      source_id: '42',
      repo_full_name: 'acme/repo',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      severity: 'high',
      title: 'Vulnerability',
      description: 'Test finding',
      cwe_ids: [],
      raw_data: null,
      analysis: null,
      analysis_completed_at: null,
      analysis_error: null,
      analysis_started_at: null,
      analysis_status: 'new',
      cli_session_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      first_detected_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      cve_id: null,
      cvss_score: null,
      dependabot_html_url: null,
      dependency_scope: 'runtime',
      fixed_at: null,
      ghsa_id: null,
      ignored_by: null,
      ignored_reason: null,
      manifest_path: 'package.json',
      patched_version: null,
      platform_integration_id: null,
      session_id: null,
      sla_due_at: null,
      vulnerable_version_range: null,
    } satisfies SecurityFinding);
    jest.mocked(triageSecurityFinding).mockResolvedValue({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'Inspect runtime dependency',
      suggestedAction: 'analyze_codebase',
      confidence: 'high',
      triageAt: new Date().toISOString(),
    });
    const result = await startSecurityAnalysis({
      findingId: 'finding',
      user,
      githubRepo: 'acme/repo',
      githubToken: 'test-github-token',
    });
    expect(result).toMatchObject({ started: true, triageOnly: false });
    const [persisted] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(persisted.api_token_pepper).toBeNull();
    const gatewayClaims = jwt.verify(
      jest.mocked(triageSecurityFinding).mock.calls[0][0].authToken,
      NEXTAUTH_SECRET
    ) as jwt.JwtPayload;
    const cloudClaims = jwt.verify(
      jest.mocked(createCloudAgentNextClient).mock.calls[0][0],
      NEXTAUTH_SECRET
    ) as jwt.JwtPayload;
    expect(gatewayClaims.aud).toBe(gateway ? 'kilo-gateway' : undefined);
    expect(gatewayClaims.tokenPurpose).toBe(gateway ? 'delegated-workload' : undefined);
    expect(cloudClaims.aud).toBe(cloud ? 'cloud-agent-next' : undefined);
    expect(cloudClaims.tokenPurpose).toBe(cloud ? 'internal-service' : undefined);
    if (gateway) {
      expect(gatewayClaims.apiTokenPepper).toBe(persisted.api_token_pepper);
      expect(gatewayClaims.exp! - gatewayClaims.iat!).toBe(3600);
    }
  }
);

it('does not initialize cloud-only callers when only the gateway gate is enabled', async () => {
  process.env.WORKFLOW_GATEWAY_RESOURCE_TOKENS_ENABLED = 'true';
  const user = await insertTestUser({ api_token_pepper: null });
  expect(await prepareCloudAgentWorkflowUser(user)).toBe(user);
  const [persisted] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
  expect(persisted.api_token_pepper).toBeNull();
});
