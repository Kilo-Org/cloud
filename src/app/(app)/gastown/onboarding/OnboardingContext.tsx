'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import type { ModelPreset, CustomModels } from './onboarding.domain';
import { presetToConfig } from './onboarding.domain';

type OnboardingRepo = {
  platform: 'github' | 'gitlab' | 'manual';
  fullName: string;
  gitUrl: string;
  defaultBranch: string;
  platformIntegrationId?: string;
};

type OnboardingState = {
  townName: string;
  townNameSetByUser: boolean;
  repo: OnboardingRepo | null;
  modelPreset: ModelPreset;
  customModels: CustomModels;
  firstTask: string;
  /** When set, the wizard creates an org-scoped town via createOrgTown. */
  orgId: string | null;
};

/** Town provisioned in the background (town + model config + ensureMayor). */
type BackgroundTown = {
  townId: string;
  /** Name used when creating the town, so we can detect if the user changed it. */
  townName: string;
  modelPreset: ModelPreset;
  customModels: CustomModels;
};

type OnboardingContextValue = {
  state: OnboardingState;
  setTownName: (name: string, setByUser?: boolean) => void;
  setRepo: (repo: OnboardingRepo | null) => void;
  setModelPreset: (preset: ModelPreset) => void;
  setCustomModels: (models: CustomModels) => void;
  setFirstTask: (task: string) => void;
  goNext: () => void;
  /** Trigger background town creation + model config + ensureMayor (idempotent). */
  provisionTownInBackground: () => void;
  /** The town ID created in the background, if available. */
  backgroundTownId: string | null;
  /** Whether background provisioning is in progress. */
  isProvisioning: boolean;
  /**
   * Waits for any in-flight background provisioning to complete and returns
   * the town ID, or null if provisioning failed / was never started.
   */
  waitForProvisionedTown: () => Promise<string | null>;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

const defaultState: OnboardingState = {
  townName: '',
  townNameSetByUser: false,
  repo: null,
  modelPreset: 'balanced',
  customModels: {},
  firstTask: '',
  orgId: null,
};

const noop = () => {};

export function OnboardingProvider({
  children,
  goNext = noop,
  orgId = null,
}: {
  children: ReactNode;
  goNext?: () => void;
  orgId?: string | null;
}) {
  const [state, setState] = useState<OnboardingState>(() => ({
    ...defaultState,
    orgId,
  }));

  const [backgroundTown, setBackgroundTown] = useState<BackgroundTown | null>(null);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const provisioningRef = useRef(false);
  /** Resolves with the town ID on success, or null on failure. */
  const provisioningPromiseRef = useRef<Promise<string | null> | null>(null);

  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const createTown = useMutation(
    trpc.gastown.createTown.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listTowns.queryKey() });
      },
    })
  );

  const createOrgTown = useMutation(
    trpc.gastown.createOrgTown.mutationOptions({
      onSuccess: () => {
        if (orgId) {
          void queryClient.invalidateQueries({
            queryKey: trpc.gastown.listOrgTowns.queryKey({ organizationId: orgId }),
          });
        }
      },
    })
  );

  const updateConfig = useMutation(trpc.gastown.updateTownConfig.mutationOptions({}));
  const ensureMayor = useMutation(
    trpc.gastown.ensureMayor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getMayorStatus.queryKey(),
        });
      },
    })
  );

  const provisionTownInBackground = useCallback(() => {
    // Read latest state via setState callback to avoid stale closure
    setState(currentState => {
      // Must have a town name to provision
      if (!currentState.townName.trim()) return currentState;

      // Already provisioning — don't start another
      if (provisioningRef.current) return currentState;

      const configChanged =
        backgroundTown &&
        (backgroundTown.modelPreset !== currentState.modelPreset ||
          JSON.stringify(backgroundTown.customModels) !==
            JSON.stringify(currentState.customModels));

      // Town already exists and config hasn't changed — nothing to do
      if (
        backgroundTown &&
        backgroundTown.townName === currentState.townName.trim() &&
        !configChanged
      ) {
        return currentState;
      }

      // Town already exists but model config changed — re-apply config only
      if (backgroundTown && configChanged) {
        const { modelPreset, customModels } = currentState;
        const townId = backgroundTown.townId;
        provisioningRef.current = true;
        setIsProvisioning(true);

        provisioningPromiseRef.current = (async () => {
          try {
            const config = presetToConfig(modelPreset, customModels);
            await updateConfig.mutateAsync({ townId, config });
            setBackgroundTown({
              townId,
              townName: backgroundTown.townName,
              modelPreset,
              customModels,
            });
            return townId;
          } catch (configErr) {
            const message =
              configErr instanceof Error ? configErr.message : 'Failed to configure models';
            toast.error(`Model config failed: ${message}. You can update it in settings.`);
            return townId; // Town still exists, just config update failed
          } finally {
            setIsProvisioning(false);
            provisioningRef.current = false;
          }
        })();

        return currentState;
      }

      // No background town yet — create one from scratch
      provisioningRef.current = true;
      setIsProvisioning(true);

      const townNameTrimmed = currentState.townName.trim();
      const { modelPreset, customModels } = currentState;

      // Store a promise so the task step can await in-flight provisioning
      provisioningPromiseRef.current = (async () => {
        try {
          // 1. Create the town
          const town = currentState.orgId
            ? await createOrgTown.mutateAsync({
                organizationId: currentState.orgId,
                name: townNameTrimmed,
              })
            : await createTown.mutateAsync({ name: townNameTrimmed });

          const townId = town.id;

          // 2. Configure models (non-blocking; failure is non-critical)
          try {
            const config = presetToConfig(modelPreset, customModels);
            await updateConfig.mutateAsync({ townId, config });
          } catch (configErr) {
            const message =
              configErr instanceof Error ? configErr.message : 'Failed to configure models';
            toast.error(`Model config failed: ${message}. You can update it in settings.`);
          }

          // 3. Pre-warm the mayor (ensureMayor provisions the agent + container)
          try {
            await ensureMayor.mutateAsync({ townId });
          } catch {
            // Non-critical — mayor will be ensured when user lands on the town page
          }

          setBackgroundTown({ townId, townName: townNameTrimmed, modelPreset, customModels });
          return townId;
        } catch (err) {
          // Town creation failed — user will create it via the task step fallback
          const message = err instanceof Error ? err.message : 'Background provisioning failed';
          toast.error(message);
          return null;
        } finally {
          setIsProvisioning(false);
          provisioningRef.current = false;
        }
      })();

      return currentState;
    });
  }, [backgroundTown, createTown, createOrgTown, updateConfig, ensureMayor]);

  const waitForProvisionedTown = useCallback(async (): Promise<string | null> => {
    // If a town already exists, return it immediately
    if (backgroundTown) return backgroundTown.townId;
    // If provisioning is in-flight, await its result
    if (provisioningPromiseRef.current) return provisioningPromiseRef.current;
    // Never started
    return null;
  }, [backgroundTown]);

  const setTownName = useCallback(
    (townName: string, setByUser?: boolean) =>
      setState(prev => ({
        ...prev,
        townName,
        townNameSetByUser: setByUser ?? prev.townNameSetByUser,
      })),
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
      value={{
        state,
        setTownName,
        setRepo,
        setModelPreset,
        setCustomModels,
        setFirstTask,
        goNext,
        provisionTownInBackground,
        backgroundTownId: backgroundTown?.townId ?? null,
        isProvisioning,
        waitForProvisionedTown,
      }}
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
