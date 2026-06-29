export type BitbucketCloneUrlResult =
  | {
      success: true;
      workspace: string;
      repository: string;
      fullName: string;
    }
  | { success: false; reason: 'invalid_bitbucket_url' };

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROVIDER_UUID_PATTERN = new RegExp(`^(?:\\{(${UUID_PATTERN})\\}|(${UUID_PATTERN}))$`, 'i');

export function normalizeBitbucketUuid(value: string): string | null {
  const match = PROVIDER_UUID_PATTERN.exec(value);
  if (!match) return null;
  const uuid = match[1] ?? match[2];
  return uuid ? uuid.toLowerCase() : null;
}

function normalizePathSegment(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(decoded) || decoded === '.' || decoded === '..') {
    return null;
  }
  return decoded;
}

export function parseBitbucketCloneUrl(repositoryUrl: string): BitbucketCloneUrlResult {
  const match = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\.git$/.exec(repositoryUrl);
  if (!match || match[0] !== repositoryUrl) {
    return { success: false, reason: 'invalid_bitbucket_url' };
  }

  const workspace = normalizePathSegment(match[1]);
  const repository = normalizePathSegment(match[2]);
  if (!workspace || !repository) return { success: false, reason: 'invalid_bitbucket_url' };

  return {
    success: true,
    workspace,
    repository,
    fullName: `${workspace}/${repository}`,
  };
}
