'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { useGastownTRPC, getToken } from '@/lib/gastown/trpc';
import { GASTOWN_URL } from '@/lib/constants';
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

/** Handlers the task step registers so the wizard nav can trigger creation. */
export type FinalStepHandlers = {
  submit: () => void;
  canSubmit: boolean;
  isSubmitting: boolean;
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
  /** Current final step handlers (set by the task step, read by wizard nav). */
  finalStepHandlers: FinalStepHandlers | null;
  setFinalStepHandlers: (handlers: FinalStepHandlers | null) => void;
  /** Delete the background-provisioned town (cleanup on abandon). */
  deleteBackgroundTown: (opts?: { keepalive?: boolean }) => void;
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
  // Guards against concurrent provisioning calls. Set true while a provisioning
  // chain is in-flight, reset to false when it completes (success or failure).
  const provisioningInFlightRef = useRef(false);
  /** Resolves with the town ID on success, or null on failure. */
  const provisioningPromiseRef = useRef<Promise<string | null> | null>(null);
  // Tracks the town ID as soon as createTown resolves, even before the full
  // provisioning chain finishes. Used by deleteBackgroundTown for cleanup.
  const createdTownIdRef = useRef<string | null>(null);
  const [finalStepHandlers, setFinalStepHandlers] = useState<FinalStepHandlers | null>(null);

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
  const deleteTownMutation = useMutation(trpc.gastown.deleteTown.mutationOptions({}));
  const deleteTownRef = useRef(deleteTownMutation);
  deleteTownRef.current = deleteTownMutation;
  const deleteOrgTownMutation = useMutation(trpc.gastown.deleteOrgTown.mutationOptions({}));
  const deleteOrgTownRef = useRef(deleteOrgTownMutation);
  deleteOrgTownRef.current = deleteOrgTownMutation;
  const orgIdRef = useRef(orgId);
  orgIdRef.current = orgId;

  const ensureMayor = useMutation(
    trpc.gastown.ensureMayor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getMayorStatus.queryKey(),
        });
      },
    })
  );

  // Store mutation functions in refs so provisionTownInBackground has a stable
  // identity and doesn't re-trigger the BackgroundProvisioner effect on every render.
  const createTownRef = useRef(createTown);
  createTownRef.current = createTown;
  const createOrgTownRef = useRef(createOrgTown);
  createOrgTownRef.current = createOrgTown;
  const updateConfigRef = useRef(updateConfig);
  updateConfigRef.current = updateConfig;
  const ensureMayorRef = useRef(ensureMayor);
  ensureMayorRef.current = ensureMayor;
  const backgroundTownRef = useRef(backgroundTown);
  backgroundTownRef.current = backgroundTown;

  const provisionTownInBackground = useCallback(() => {
    // Read latest state via setState callback to avoid stale closure
    setState(currentState => {
      // Must have a town name to provision
      if (!currentState.townName.trim()) return currentState;

      // Don't start another chain while one is already in-flight
      if (provisioningInFlightRef.current) return currentState;

      const bg = backgroundTownRef.current;
      const townNameTrimmed = currentState.townName.trim();
      const { modelPreset, customModels } = currentState;

      const nameChanged = bg && bg.townName !== townNameTrimmed;
      const configChanged =
        bg &&
        (bg.modelPreset !== modelPreset ||
          JSON.stringify(bg.customModels) !== JSON.stringify(customModels));

      // Town already provisioned with matching name + config — nothing to do
      if (bg && !nameChanged && !configChanged) {
        return currentState;
      }

      // Town exists but only config changed (same name) — re-apply config only
      if (bg && !nameChanged && configChanged) {
        const townId = bg.townId;
        provisioningInFlightRef.current = true;
        setIsProvisioning(true);

        provisioningPromiseRef.current = (async () => {
          try {
            const config = presetToConfig(modelPreset, customModels);
            await updateConfigRef.current.mutateAsync({ townId, config });
            setBackgroundTown({ townId, townName: bg.townName, modelPreset, customModels });
            return townId;
          } catch (configErr) {
            const message =
              configErr instanceof Error ? configErr.message : 'Failed to configure models';
            toast.error(`Model config failed: ${message}. You can update it in settings.`);
            return townId; // Town still exists, just config update failed
          } finally {
            setIsProvisioning(false);
            provisioningInFlightRef.current = false;
          }
        })();

        return currentState;
      }

      // If the name changed and an old town exists, delete it first
      if (bg && nameChanged) {
        const oldTownId = bg.townId;
        const oid = currentState.orgId;
        if (oid) {
          deleteOrgTownRef.current.mutate({ organizationId: oid, townId: oldTownId });
        } else {
          deleteTownRef.current.mutate({ townId: oldTownId });
        }
        setBackgroundTown(null);
        createdTownIdRef.current = null;
      }

      // Create a new town from scratch
      provisioningInFlightRef.current = true;
      setIsProvisioning(true);

      // Store a promise so the task step can await in-flight provisioning
      provisioningPromiseRef.current = (async () => {
        try {
          // 1. Create the town
          const town = currentState.orgId
            ? await createOrgTownRef.current.mutateAsync({
                organizationId: currentState.orgId,
                name: townNameTrimmed,
              })
            : await createTownRef.current.mutateAsync({ name: townNameTrimmed });

          const townId = town.id;
          createdTownIdRef.current = townId;

          // 2. Configure models (non-blocking; failure is non-critical)
          try {
            const config = presetToConfig(modelPreset, customModels);
            await updateConfigRef.current.mutateAsync({ townId, config });
          } catch (configErr) {
            const message =
              configErr instanceof Error ? configErr.message : 'Failed to configure models';
            toast.error(`Model config failed: ${message}. You can update it in settings.`);
          }

          // 3. Pre-warm the mayor (ensureMayor provisions the agent + container)
          try {
            await ensureMayorRef.current.mutateAsync({ townId });
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
          provisioningInFlightRef.current = false;
        }
      })();

      return currentState;
    });
  }, []);

  const waitForProvisionedTown = useCallback(async (): Promise<string | null> => {
    // If a town already exists, return it immediately
    if (backgroundTown) return backgroundTown.townId;
    // If provisioning is in-flight, await its result
    if (provisioningPromiseRef.current) return provisioningPromiseRef.current;
    // Never started
    return null;
  }, [backgroundTown]);

  const deleteBackgroundTown = useCallback(
    ({ keepalive = false }: { keepalive?: boolean } = {}) => {
      // Check both the completed backgroundTown state AND the in-flight
      // createdTownIdRef (set as soon as createTown resolves, before the
      // full provisioning chain finishes).
      const townId = backgroundTownRef.current?.townId ?? createdTownIdRef.current;
      if (!townId) return;

      setBackgroundTown(null);
      createdTownIdRef.current = null;

      const currentOrgId = orgIdRef.current;

      if (keepalive) {
        // Use raw fetch with keepalive — tRPC mutations are cancelled
        // when the page unloads or the component tree unmounts.
        const procedure = currentOrgId ? 'gastown.deleteOrgTown' : 'gastown.deleteTown';
        const body = currentOrgId
          ? { json: { organizationId: currentOrgId, townId } }
          : { json: { townId } };
        void getToken().then(token => {
          void fetch(`${GASTOWN_URL}/trpc/${procedure}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            keepalive: true,
          });
        });
      } else if (currentOrgId) {
        deleteOrgTownRef.current.mutate({ organizationId: currentOrgId, townId });
      } else {
        deleteTownRef.current.mutate({ townId });
      }
    },
    []
  );

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
        finalStepHandlers,
        setFinalStepHandlers,
        deleteBackgroundTown,
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
