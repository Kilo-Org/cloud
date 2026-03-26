'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

type OnboardingRepo = {
  platform: 'github' | 'gitlab' | 'manual';
  fullName: string;
  gitUrl: string;
  defaultBranch: string;
  platformIntegrationId?: string;
};

type ModelPreset = 'frontier' | 'balanced' | 'cost-effective' | 'free' | 'custom';

type CustomModels = {
  mayor?: string;
  refinery?: string;
  polecat?: string;
};

type OnboardingState = {
  townName: string;
  repo: OnboardingRepo | null;
  modelPreset: ModelPreset;
  customModels: CustomModels;
  firstTask: string;
};

type OnboardingContextValue = {
  state: OnboardingState;
  setTownName: (name: string) => void;
  setRepo: (repo: OnboardingRepo | null) => void;
  setModelPreset: (preset: ModelPreset) => void;
  setCustomModels: (models: CustomModels) => void;
  setFirstTask: (task: string) => void;
  goNext: () => void;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

const defaultState: OnboardingState = {
  townName: '',
  repo: null,
  modelPreset: 'balanced',
  customModels: {},
  firstTask: '',
};

const noop = () => {};

export function OnboardingProvider({
  children,
  goNext = noop,
}: {
  children: ReactNode;
  goNext?: () => void;
}) {
  const [state, setState] = useState<OnboardingState>(defaultState);

  const setTownName = useCallback(
    (townName: string) => setState(prev => ({ ...prev, townName })),
    []
  );
  const setRepo = useCallback(
    (repo: OnboardingRepo | null) => setState(prev => ({ ...prev, repo })),
    []
  );
  const setModelPreset = useCallback(
    (modelPreset: ModelPreset) => setState(prev => ({ ...prev, modelPreset })),
    []
  );
  const setCustomModels = useCallback(
    (customModels: CustomModels) => setState(prev => ({ ...prev, customModels })),
    []
  );
  const setFirstTask = useCallback(
    (firstTask: string) => setState(prev => ({ ...prev, firstTask })),
    []
  );

  return (
    <OnboardingContext
      value={{ state, setTownName, setRepo, setModelPreset, setCustomModels, setFirstTask, goNext }}
    >
      {children}
    </OnboardingContext>
  );
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return ctx;
}

export type { OnboardingState, OnboardingRepo, ModelPreset, CustomModels };
