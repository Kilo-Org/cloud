'use client';

import { useState } from 'react';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { WorkspaceSelector } from './WorkspaceSelector';
import { SlackConnectStep } from './SlackConnectStep';
import { motion, AnimatePresence } from 'motion/react';
import type { WorkspaceSelection } from './types';

type FlowStep = 'workspace-selection' | 'slack-connect';

export function SlackGetStartedFlow() {
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

  return (
    <KiloCardLayout title="Get Started with Kilo for Slack" className="max-w-2xl">
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
            <SlackConnectStep workspace={selectedWorkspace} onBack={handleBack} />
          </motion.div>
        )}
      </AnimatePresence>
    </KiloCardLayout>
  );
}
