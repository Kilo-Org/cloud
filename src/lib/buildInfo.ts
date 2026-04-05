// Get build info at build time
export const buildInfo = {
  commitHash:
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  gitBranch: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF,
  vercelUrl: process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL,
  timestamp: new Date().toISOString(),
};

export function getGitHubCommitUrl(commitHash: string): string {
  // Assuming the repo is on GitHub - adjust the org/repo as needed
  return `https://github.com/${process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER}/${process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG}/commit/${commitHash}`;
}
