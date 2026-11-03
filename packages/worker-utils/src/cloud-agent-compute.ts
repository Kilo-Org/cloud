export const SANDBOX_USAGE_SKUS = {
  Sandbox: 'cloud-agent-standard-2026-07',
  SandboxContainment: 'cloud-agent-standard-2026-07',
  SandboxSmall: 'cloud-agent-small-2026-07',
  SandboxSmallContainment: 'cloud-agent-small-2026-07',
  SandboxDIND: 'cloud-agent-dind-2026-07',
  SandboxCodeReview: 'cloud-agent-code-review-2026-07',
  SandboxCodeReviewContainment: 'cloud-agent-code-review-2026-07',
  SandboxContainersStandard3: 'cloud-agent-containers-standard-3-2026-09',
  SandboxContainersStandard4: 'cloud-agent-containers-standard-4-2026-09',
  SandboxContainersCodeReview: 'cloud-agent-code-review-2026-07',
  SandboxVercelSmall: 'cloud-agent-vercel-small-2026-09',
  SandboxVercelLarge: 'cloud-agent-vercel-large-2026-09',
} as const;

export const CLOUD_AGENT_CONTAINER_CLASSES = {
  'standard-3': 'SandboxContainersStandard3',
  'standard-4': 'SandboxContainersStandard4',
} as const;

type ContainerSkus = {
  [
    Instance in keyof typeof CLOUD_AGENT_CONTAINER_CLASSES
  ]: (typeof SANDBOX_USAGE_SKUS)[(typeof CLOUD_AGENT_CONTAINER_CLASSES)[Instance]];
};

export const CLOUD_AGENT_CONTAINER_SKUS = Object.fromEntries(
  Object.entries(CLOUD_AGENT_CONTAINER_CLASSES).map(([instance, className]) => [
    instance,
    SANDBOX_USAGE_SKUS[className],
  ])
) as ContainerSkus;
