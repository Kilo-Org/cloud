import type { UsageContext } from '@kilocode/container-usage';
import type { SessionMetadata } from './persistence/session-metadata.js';
import type { SandboxId } from './types.js';

export const SANDBOX_USAGE_SKUS = {
  Sandbox: 'cloud-agent-standard-2026-07',
  SandboxContainment: 'cloud-agent-standard-2026-07',
  SandboxSmall: 'cloud-agent-small-2026-07',
  SandboxSmallContainment: 'cloud-agent-small-2026-07',
  SandboxDIND: 'cloud-agent-dind-2026-07',
  SandboxCodeReview: 'cloud-agent-code-review-2026-07',
  SandboxCodeReviewContainment: 'cloud-agent-code-review-2026-07',
} as const;

export type SandboxClassName = keyof typeof SANDBOX_USAGE_SKUS;
export type SandboxBillingInput = Omit<UsageContext, 'service' | 'instanceId' | 'sku'>;

const KNOWN_ORIGINS = new Set([
  'app-builder',
  'auto-triage',
  'autofix',
  'cloud-agent',
  'cloud-agent-web',
  'code-review',
  'discord',
  'github',
  'linear',
  'scheduled',
  'security-agent',
  'security-remediation',
  'slack',
  'webhook',
]);

function normalizedOrigin(origin: string | undefined): string {
  if (!origin) return 'cloud-agent';
  return KNOWN_ORIGINS.has(origin) ? origin : 'other';
}

function isIsolatedSandbox(sandboxId: SandboxId): boolean {
  return /^(crv|dind|ses)-/.test(sandboxId);
}

export function buildSandboxBillingInput(
  metadata: SessionMetadata,
  sandboxId: SandboxId
): SandboxBillingInput {
  const subject = metadata.identity.orgId
    ? { type: 'org' as const, id: metadata.identity.orgId }
    : { type: 'user' as const, id: metadata.identity.userId };
  const actor = metadata.identity.botId
    ? { type: 'bot' as const, id: metadata.identity.botId }
    : { type: 'user' as const, id: metadata.identity.userId };
  const isolated = isIsolatedSandbox(sandboxId);

  return {
    subject,
    actor,
    ...(actor.type === 'bot' ? { onBehalfOf: subject } : {}),
    ...(isolated ? { sessionId: metadata.identity.sessionId } : {}),
    metadata: isolated
      ? {
          allocation: 'isolated',
          origin: normalizedOrigin(metadata.identity.createdOnPlatform),
          ...(metadata.repository ? { repository_provider: metadata.repository.type } : {}),
        }
      : { allocation: 'shared' },
  };
}
