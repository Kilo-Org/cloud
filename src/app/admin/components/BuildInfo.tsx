import { buildInfo, getGitHubCommitUrl } from '@/lib/buildInfo';
import { ExternalLink } from 'lucide-react';

export function BuildInfo() {
  const { commitHash, vercelUrl } = buildInfo;

  if (commitHash === undefined) {
    return null;
  }

  const githubUrl = getGitHubCommitUrl(commitHash);

  return (
    <div className="text-muted-foreground flex flex-col gap-2 text-xs">
      <div className="flex justify-between">
        <span>Build:</span>
        {vercelUrl && (
          <a
            href={`https://${vercelUrl}`}
            target="_blank"
            className="hover:text-foreground flex items-center gap-1 transition-colors"
            title="View Vercel deployment"
          >
            <span>Vercel</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <a
        href={githubUrl}
        target="_blank"
        className="hover:text-foreground bg-muted flex items-center gap-1 rounded px-2 transition-colors"
        title={`Git commit: ${commitHash}`}
      >
        <code className="py-0.5 text-xs">
          {commitHash.slice(0, 7)} ({buildInfo.gitBranch}, {buildInfo.timestamp})
        </code>
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
