'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { AutoTriageConfigForm } from '@/components/auto-triage/AutoTriageConfigForm';
import { AutoTriageTicketsCard } from '@/components/auto-triage/AutoTriageTicketsCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Rocket, ExternalLink, Settings2, ListChecks } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

type AutoTriagePageClientProps = {
  organizationId: string;
  organizationName: string;
  successMessage?: string;
  errorMessage?: string;
};

export function AutoTriagePageClient({
  organizationId,
  organizationName,
  successMessage,
  errorMessage,
}: AutoTriagePageClientProps) {
  const trpc = useTRPC();

  // Fetch GitHub App installation status
  const { data: statusData, isLoading: isStatusLoading } = useQuery(
    trpc.organizations.autoTriage.getGitHubStatus.queryOptions({
      organizationId,
    })
  );

  const isGitHubAppInstalled = statusData?.connected && statusData?.integration?.isValid;

  // Show toast messages from URL params
  useEffect(() => {
    if (successMessage === 'github_connected') {
      toast.success('GitHub account connected successfully');
    }
    if (errorMessage) {
      toast.error('An error occurred', {
        description: errorMessage.replace(/_/g, ' '),
      });
    }
  }, [successMessage, errorMessage]);

  return (
    <div className="container mx-auto space-y-6 px-4 py-8">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold">Auto Triage</h1>
          <Badge variant="new">new</Badge>
        </div>
        <p className="text-muted-foreground">
          Automatically triage GitHub issues with AI-powered analysis for {organizationName}
        </p>
        <a
          href="https://kilo.ai/docs/automate/auto-triage/overview"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
        >
          Learn how to use it
          <ExternalLink className="size-4" />
        </a>
      </div>

      {/* GitHub App Required Alert */}
      {!isStatusLoading && !isGitHubAppInstalled && (
        <Alert>
          <Rocket className="h-4 w-4" />
          <AlertTitle>GitHub App Required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              The Kilo GitHub App must be installed to use Auto Triage. The app automatically
              manages workflows and triggers triage on your issues.
            </p>
            <Link href={`/organizations/${organizationId}/integrations/github`}>
              <Button variant="default" size="sm">
                Install GitHub App
                <ExternalLink className="ml-2 h-3 w-3" />
              </Button>
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {/* Tabbed Content */}
      <Tabs defaultValue="config" className="w-full">
        <TabsList className="grid w-full max-w-2xl grid-cols-2">
          <TabsTrigger value="config" className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Config
          </TabsTrigger>
          <TabsTrigger
            value="tickets"
            className="flex items-center gap-2"
            disabled={!isStatusLoading && !isGitHubAppInstalled}
          >
            <ListChecks className="h-4 w-4" />
            Tickets
          </TabsTrigger>
        </TabsList>

        {/* Configuration Tab */}
        <TabsContent value="config" className="mt-6 space-y-4">
          <AutoTriageConfigForm organizationId={organizationId} />
        </TabsContent>

        {/* Tickets Tab */}
        <TabsContent value="tickets" className="mt-6 space-y-4">
          {isStatusLoading || isGitHubAppInstalled ? (
            <AutoTriageTicketsCard organizationId={organizationId} />
          ) : (
            <Alert>
              <ListChecks className="h-4 w-4" />
              <AlertTitle>No Tickets Yet</AlertTitle>
              <AlertDescription>
                Install the GitHub App and configure your auto-triage settings to see triage tickets
                here.
              </AlertDescription>
            </Alert>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
