import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { atom, getDefaultStore } from 'jotai';
import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import { createServiceState } from '@kilocode/cloud-agent-sdk/service-state';
import { PREPARATION_MAX_STEPS } from '@kilocode/cloud-agent-sdk/schemas';
import { PreparationDrawer } from './PreparationDrawer';

Object.assign(globalThis, { React });

const mockAttempts = atom<readonly PreparationAttempt[]>([]);
jest.mock('./CloudAgentProvider', () => ({
  useManager: () => ({ atoms: { preparationAttempts: mockAttempts } }),
}));
jest.mock('@/components/ui/sheet', () => {
  const Container = ({ children }: { children: React.ReactNode }) => children;
  return {
    Sheet: Container,
    SheetContent: Container,
    SheetDescription: Container,
    SheetHeader: Container,
    SheetTitle: Container,
  };
});

describe('PreparationDrawer diagnostics', () => {
  it('renders retained command diagnostics once', () => {
    const state = createServiceState({ rootSessionId: 'session' });
    const base = {
      type: 'preparing' as const,
      version: 2 as const,
      attemptId: 'attempt',
      triggerMessageId: 'message',
      step: 'setup_commands',
      message: 'Preparing workspace',
      timestamp: 1,
      revision: 1,
    };
    state.process({ ...base, action: 'attempt_started' });
    state.process({
      ...base,
      action: 'step_started',
      stepId: 'first-phase',
      kind: 'phase',
      label: 'First setup',
      revision: 2,
    });
    for (let index = 0; index < PREPARATION_MAX_STEPS - 1; index++) {
      state.process({
        ...base,
        action: 'step_snapshot',
        stepId: `command-${index}`,
        revision: index + 3,
        stepSnapshot: {
          id: `command-${index}`,
          key: 'setup_commands',
          kind: 'setup_command',
          label: `Saved command ${index}`,
          parentStepId: 'first-phase',
          status: 'failed',
          safeError: `Saved error ${index}`,
          outputTail: `Saved output ${index}`,
          startedAt: 1,
          startedRevision: index + 3,
          revision: index + 3,
        },
      });
    }
    state.process({
      ...base,
      action: 'step_started',
      stepId: 'second-phase',
      kind: 'phase',
      label: 'Second setup',
      revision: PREPARATION_MAX_STEPS + 3,
    });
    const attempts = state.getPreparationAttempts();
    expect(attempts[0]?.steps.some(step => step.id === 'first-phase')).toBe(false);
    getDefaultStore().set(mockAttempts, attempts);
    const markup = renderToStaticMarkup(
      React.createElement(PreparationDrawer, { attemptId: 'attempt', onOpenChange: jest.fn() })
    );
    expect(markup).toContain('Second setup');
    for (let index = 0; index < PREPARATION_MAX_STEPS - 1; index++) {
      expect(markup.split(`>Saved command ${index}<`)).toHaveLength(2);
      expect(markup).toContain(`Saved error ${index}`);
      expect(markup).toContain(`Saved output ${index}`);
    }
    getDefaultStore().set(mockAttempts, []);
  });
});
