'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, Clock, ArrowRight, GitBranch } from 'lucide-react';
import type { Platform } from '@/lib/integrations/platform-definitions';

export type GitHubIdentityStatus = 'connected' | 'revoked';

type PlatformCardProps = {
  platform: Platform;
  githubIdentityStatus?: GitHubIdentityStatus;
  onNavigate?: (platformId: string) => void;
};

const PlatformIcon = () => {
  // Using GitBranch as placeholder for all, we can add specific icons later
  return <GitBranch className="h-6 w-6" />;
};

const StatusBadge = ({ status }: { status: Platform['status'] }) => {
  switch (status) {
    case 'installed':
      return (
        <Badge variant="default" className="flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Installed
        </Badge>
      );
    case 'not_installed':
      return (
        <Badge variant="secondary" className="flex items-center gap-1">
          <XCircle className="h-3 w-3" />
          Not Installed
        </Badge>
      );
    case 'coming_soon':
      return (
        <Badge variant="outline" className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Coming Soon
        </Badge>
      );
  }
};

const GitHubIdentityBadge = ({ status }: { status: GitHubIdentityStatus }) => {
  if (status === 'connected') {
    return (
      <Badge variant="default" className="flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Identity connected
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="flex items-center gap-1">
      <XCircle className="h-3 w-3" />
      Reconnect identity
    </Badge>
  );
};

export function PlatformCard({ platform, githubIdentityStatus, onNavigate }: PlatformCardProps) {
  const handleClick = () => {
    if (platform.enabled && onNavigate) {
      onNavigate(platform.id);
    }
  };

  const description =
    githubIdentityStatus === 'connected'
      ? platform.status === 'installed'
        ? 'Your GitHub identity is connected and personal repository access is set up.'
        : 'Your GitHub identity is connected. Set up personal repository access here, or use access from an organization.'
      : githubIdentityStatus === 'revoked'
        ? 'Reconnect your GitHub identity to let Cloud Agent act as you. Repository access is managed separately.'
        : platform.description;

  return (
    <Card
      className={`transition-all ${
        platform.enabled ? 'cursor-pointer hover:shadow-md' : 'cursor-not-allowed opacity-60'
      }`}
      onClick={platform.enabled ? handleClick : undefined}
    >
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg border p-2">
            <PlatformIcon />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{platform.name}</CardTitle>
              {githubIdentityStatus ? (
                <GitHubIdentityBadge status={githubIdentityStatus} />
              ) : (
                <StatusBadge status={platform.status} />
              )}
            </div>
            <CardDescription className="mt-2">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {platform.enabled ? (
          <Button variant="outline" className="group w-full" onClick={handleClick}>
            {platform.status === 'installed' || githubIdentityStatus
              ? 'Manage Integration'
              : 'Configure'}
            <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        ) : (
          <div className="text-muted-foreground py-2 text-center text-sm">
            This integration will be available soon
          </div>
        )}
      </CardContent>
    </Card>
  );
}
