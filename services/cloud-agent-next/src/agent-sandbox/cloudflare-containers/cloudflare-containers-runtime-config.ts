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
