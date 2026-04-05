'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, Clock, ArrowRight, GitBranch } from 'lucide-react';
import type { Platform } from '@/lib/integrations/platform-definitions';

interface PlatformCardProps {
  platform: Platform;
  onNavigate?: (platformId: string) => void;
}

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

export function PlatformCard({ platform, onNavigate }: PlatformCardProps) {
  const handleClick = () => {
    if (platform.enabled && onNavigate) {
      onNavigate(platform.id);
    }
  };

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
              <StatusBadge status={platform.status} />
            </div>
            <CardDescription className="mt-2">{platform.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {platform.enabled ? (
          <Button variant="outline" className="group w-full" onClick={handleClick}>
            {platform.status === 'installed' ? 'Manage Integration' : 'Configure'}
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
