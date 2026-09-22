export type CloudflareContainersEnrollmentEnv = {
  CLOUDFLARE_CONTAINERS_ORG_IDS?: string;
};

export type CloudflareContainersEnrollment = {
  enabled: boolean;
  orgIds: Set<string>;
  allowPersonal: boolean;
};

export function parseCloudflareContainersEnrollment(
  env: CloudflareContainersEnrollmentEnv
): CloudflareContainersEnrollment {
  const orgIds = new Set(
    (env.CLOUDFLARE_CONTAINERS_ORG_IDS ?? '')
      .split(',')
      .map(orgId => orgId.trim())
      .filter(Boolean)
  );
  if (orgIds.size === 0) {
    return { enabled: false, orgIds, allowPersonal: false };
  }

  return {
    enabled: true,
    orgIds,
    allowPersonal: orgIds.has('*'),
  };
}

/**
 * Whether the owner is enrolled for DO-managed Cloudflare containers. The org
 * allowlist is the single gate: `*` covers every owner including personal ones,
 * otherwise an org matches by id and a personal owner only when `*` is present.
 */
export function isCloudflareContainersEnrolled(
  env: CloudflareContainersEnrollmentEnv,
  owner: { orgId?: string }
): boolean {
  const enrollment = parseCloudflareContainersEnrollment(env);
  return owner.orgId !== undefined
    ? enrollment.orgIds.has('*') || enrollment.orgIds.has(owner.orgId)
    : enrollment.allowPersonal;
}
