'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, MessageSquare, CheckCircle2, Building2, User } from 'lucide-react';
import type { WorkspaceSelection } from './types';
import { useState } from 'react';

type SlackConnectStepProps = {
  workspace: WorkspaceSelection;
  onBack: () => void;
};

export function SlackConnectStep({ workspace, onBack }: SlackConnectStepProps) {
  const trpc = useTRPC();
  const [isStartingSlackConnection, setIsStartingSlackConnection] = useState(false);

  // Get OAuth URL only when the user clicks Connect so the signed state is fresh.
  const { refetch: refetchOAuthUrl, isFetching: isFetchingOAuthUrl } = useQuery(
    trpc.slack.getOAuthUrl.queryOptions(
      workspace.type === 'org' ? { organizationId: workspace.id } : undefined,
      { enabled: false }
    )
  );

  const handleConnectSlack = async () => {
    setIsStartingSlackConnection(true);
    const result = await refetchOAuthUrl();
    if (result.data?.url) {
      window.location.href = result.data.url;
    } else {
      setIsStartingSlackConnection(false);
    }
  };

  const workspaceName = workspace.type === 'user' ? 'Personal Account' : workspace.name;

  const workspaceIcon =
    workspace.type === 'user' ? (
      <User className="text-brand-primary h-5 w-5" />
    ) : (
      <Building2 className="text-brand-primary h-5 w-5" />
    );

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Change workspace
      </Button>

      {/* Selected workspace indicator */}
      <div className="bg-muted/50 flex items-center gap-3 rounded-lg p-3">
        <div className="bg-brand-primary/10 flex h-10 w-10 items-center justify-center rounded-full">
          {workspaceIcon}
        </div>
        <div>
          <p className="text-sm font-medium">Connecting Slack to:</p>
          <p className="text-muted-foreground text-sm">{workspaceName}</p>
        </div>
      </div>

      {/* Slack connection card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#4A154B]/10">
              <MessageSquare className="h-6 w-6 text-[#4A154B]" />
            </div>
            <div>
              <CardTitle>Connect Slack</CardTitle>
              <CardDescription>Chat with Kilo directly from your Slack workspace</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>
              After connecting, you&apos;ll be able to message Kilo directly in Slack to create PRs,
              debug code, ask questions about your repos, and more.
            </AlertDescription>
          </Alert>

          <div className="space-y-2 rounded-lg border p-4">
            <h4 className="font-medium">What you&apos;ll get:</h4>
            <ul className="text-muted-foreground space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="text-brand-primary mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>Message Kilo directly from Slack</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="text-brand-primary mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>Create pull requests with natural language</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="text-brand-primary mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>Debug code and get explanations</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="text-brand-primary mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>Ask questions about your repositories</span>
              </li>
            </ul>
          </div>

          <Button
            onClick={handleConnectSlack}
            size="lg"
            className="w-full bg-[#4A154B] text-white hover:bg-[#3a1039]"
            disabled={isStartingSlackConnection || isFetchingOAuthUrl}
          >
            <MessageSquare className="mr-2 h-5 w-5" />
            {isStartingSlackConnection || isFetchingOAuthUrl ? 'Loading...' : 'Connect Slack'}
          </Button>

          <p className="text-muted-foreground text-center text-xs">
            You&apos;ll be redirected to Slack to authorize the connection
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
