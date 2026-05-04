'use client';

import { useState } from 'react';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { WorkspaceSelector } from './WorkspaceSelector';
import { SlackConnectStep } from './SlackConnectStep';
import { motion, AnimatePresence } from 'motion/react';
import type { WorkspaceSelection } from './types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle2, ExternalLink, MessageSquare, TriangleAlert } from 'lucide-react';
import Link from 'next/link';

type FlowStep = 'workspace-selection' | 'slack-connect';

type SlackGetStartedFlowProps = {
  installToken?: string;
  source?: string;
  slackSuccess?: string;
  slackError?: string;
};

const slackErrorMessages: Record<string, string> = {
  invalid_install_token:
    'This Slack setup link is invalid or expired. Mention Kilo in Slack again to get a fresh link.',
  workspace_mismatch:
    'The Slack workspace selected during authorization did not match the original setup link. Start again from the Slack workspace where you mentioned Kilo.',
  workspace_already_connected:
    'This Slack workspace is already connected to another Kilo account or organization. Disconnect it there before connecting it here.',
  installation_failed: 'Slack installation failed. Mention Kilo in Slack again and retry setup.',
  missing_code: 'Slack did not return an authorization code. Please retry setup from Slack.',
  unauthorized: 'You are not authorized to finish this Slack setup.',
};

function getSlackErrorMessage(error: string): string {
  return slackErrorMessages[error] ?? `Slack setup failed: ${error}`;
}

function SlackSetupSuccess() {
  return (
    <Card>
      <CardContent className="space-y-6 pt-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10">
          <CheckCircle2 className="h-7 w-7 text-green-500" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">Kilo is ready in Slack</h2>
          <p className="text-muted-foreground">
            I posted a confirmation back in Slack. Return there and mention Kilo again to start a
            coding session, review a PR, or ask a repo question.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="https://kilo.ai/docs/advanced-usage/slackbot" target="_blank">
            <Button variant="outline" className="gap-2">
              Read the docs
              <ExternalLink className="h-4 w-4" />
            </Button>
          </Link>
          <Link href="/integrations/slack">
            <Button variant="primary" className="gap-2">
              Open Slack settings
              <MessageSquare className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export function SlackGetStartedFlow({
  installToken,
  source,
  slackSuccess,
  slackError,
}: SlackGetStartedFlowProps) {
  const [currentStep, setCurrentStep] = useState<FlowStep>('workspace-selection');
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceSelection | null>(null);

  const handleWorkspaceSelect = (selection: WorkspaceSelection) => {
    setSelectedWorkspace(selection);
    setCurrentStep('slack-connect');
  };

  const handleBack = () => {
    setCurrentStep('workspace-selection');
    setSelectedWorkspace(null);
  };

  if (slackSuccess === 'installed') {
    return (
      <KiloCardLayout title="Get Started with Kilo for Slack" className="max-w-2xl">
        <SlackSetupSuccess />
      </KiloCardLayout>
    );
  }

  const isMarketplaceInstall = source === 'slack_marketplace_install' || !!installToken;

  return (
    <KiloCardLayout title="Get Started with Kilo for Slack" className="max-w-2xl">
      <div className="mb-6 space-y-3">
        {isMarketplaceInstall && (
          <Alert variant="notice">
            <MessageSquare className="h-4 w-4" />
            <AlertTitle>Finish Slack setup</AlertTitle>
            <AlertDescription>
              Kilo is already installed in Slack. Choose where it should live in Kilo, then approve
              Slack access to finish connecting the workspace.
            </AlertDescription>
          </Alert>
        )}
        {slackError && (
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>Slack setup needs attention</AlertTitle>
            <AlertDescription>{getSlackErrorMessage(slackError)}</AlertDescription>
          </Alert>
        )}
      </div>
      <AnimatePresence mode="wait">
        {currentStep === 'workspace-selection' && (
          <motion.div
            key="workspace-selection"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
          >
            <WorkspaceSelector onSelect={handleWorkspaceSelect} />
          </motion.div>
        )}

        {currentStep === 'slack-connect' && selectedWorkspace && (
          <motion.div
            key="slack-connect"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
          >
            <SlackConnectStep
              workspace={selectedWorkspace}
              onBack={handleBack}
              installToken={installToken}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </KiloCardLayout>
  );
}
