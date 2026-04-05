'use client';

import { memo } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Webhook, AlertCircle } from 'lucide-react';

type GitHubIntegrationRequiredProps = {
  /** Error message from the integration check */
  errorMessage?: string;
  /** Path to the integrations page */
  integrationsPath: string;
};

/**
 * Component shown when GitHub integration is not installed.
 * Prompts user to install the integration before using webhook triggers.
 */
export const GitHubIntegrationRequired = memo(function GitHubIntegrationRequired({
  errorMessage,
  integrationsPath,
}: GitHubIntegrationRequiredProps) {
  const router = useRouter();

  const message = errorMessage || 'Connect a GitHub integration to create webhook triggers.';

  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <Webhook className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Webhook Triggers</h1>
          <Badge variant="new">new</Badge>
        </div>
        <p className="text-muted-foreground mt-2">
          Manage webhook triggers that automatically start cloud agent sessions.
        </p>
      </div>

      {/* Integration Missing Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            Connect GitHub to create webhook triggers
          </CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-gray-300">
            Webhook triggers require access to your GitHub repositories. Install the GitHub
            integration to continue.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href={integrationsPath} variant="primary" size="md">
              Open integrations
            </LinkButton>
            <Button variant="outline" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
});
