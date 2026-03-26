'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useOnboarding } from './OnboardingContext';
import { presetToConfig, FIRST_TASK_STORAGE_PREFIX, PHASE_LABELS } from './onboarding.domain';
import type { CreationPhase } from './onboarding.domain';

export function OnboardingStepTask() {
  const { state, setFirstTask } = useOnboarding();
  const router = useRouter();
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [phase, setPhase] = useState<CreationPhase>('idle');
  const isSubmitting = phase !== 'idle';

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
        if (state.orgId) {
          void queryClient.invalidateQueries({
            queryKey: trpc.gastown.listOrgTowns.queryKey({ organizationId: state.orgId }),
          });
        }
      },
    })
  );

  const createRig = useMutation(trpc.gastown.createRig.mutationOptions({}));

  const updateConfig = useMutation(trpc.gastown.updateTownConfig.mutationOptions({}));

  async function handleSubmit() {
    if (!state.firstTask.trim() || !state.repo || !state.townName.trim()) return;

    try {
      // Step 1: Create the town (org-scoped or personal)
      setPhase('creating-town');
      const town = state.orgId
        ? await createOrgTown.mutateAsync({
            organizationId: state.orgId,
            name: state.townName.trim(),
          })
        : await createTown.mutateAsync({ name: state.townName.trim() });
      const townId = town.id;

      // Step 2: Create the rig (non-blocking — if it fails, user can add later)
      setPhase('creating-rig');
      try {
        const rigName = state.repo.fullName.split('/').pop() ?? state.repo.fullName;
        await createRig.mutateAsync({
          townId,
          name: rigName,
          gitUrl: state.repo.gitUrl,
          defaultBranch: state.repo.defaultBranch || 'main',
          ...(state.repo.platformIntegrationId
            ? { platformIntegrationId: state.repo.platformIntegrationId }
            : {}),
        });
      } catch (rigErr) {
        const message = rigErr instanceof Error ? rigErr.message : 'Failed to add repository';
        toast.error(`Rig creation failed: ${message}. You can add it later in settings.`);
      }

      // Step 3: Set model config (non-blocking)
      setPhase('configuring-models');
      try {
        const config = presetToConfig(state.modelPreset, state.customModels);
        await updateConfig.mutateAsync({ townId, config });
      } catch (configErr) {
        const message =
          configErr instanceof Error ? configErr.message : 'Failed to configure models';
        toast.error(`Model config failed: ${message}. You can update it in settings.`);
      }

      // Step 4: Queue first task for the Mayor terminal via localStorage
      try {
        localStorage.setItem(`${FIRST_TASK_STORAGE_PREFIX}${townId}`, state.firstTask.trim());
      } catch {
        // localStorage may be unavailable; the message just won't be auto-sent
      }

      // Step 5: Redirect to the new town (org-scoped path when applicable)
      setPhase('redirecting');
      const townPath = state.orgId
        ? `/organizations/${state.orgId}/gastown/${townId}`
        : `/gastown/${townId}`;
      router.push(townPath);
    } catch (townErr) {
      // Town creation is the critical path — if it fails, stay on the wizard
      setPhase('idle');
      const message = townErr instanceof Error ? townErr.message : 'Failed to create town';
      toast.error(message);
    }
  }

  const canSubmit =
    state.firstTask.trim().length > 0 &&
    state.repo !== null &&
    state.townName.trim().length > 0 &&
    !isSubmitting;

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Give your first task</h2>
      <p className="mt-2 text-sm text-white/40">
        Tell your Mayor what to work on. This will be your first conversation.
      </p>

      <div className="mt-8 w-full max-w-lg">
        <Textarea
          ref={textareaRef}
          value={state.firstTask}
          onChange={e => setFirstTask(e.target.value)}
          placeholder="Describe something you'd like done in this repo..."
          disabled={isSubmitting}
          className="min-h-[160px] resize-none border-white/[0.08] bg-white/[0.03] text-sm leading-relaxed text-white/85 placeholder:text-white/25 focus-visible:ring-[color:oklch(95%_0.15_108_/_0.4)]"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
              void handleSubmit();
            }
          }}
        />

        {!isSubmitting && state.firstTask.trim() && (
          <p className="mt-2 text-center text-xs text-white/25">
            Press {navigator?.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to submit
          </p>
        )}

        {isSubmitting ? (
          <div className="mt-6 flex flex-col items-center gap-3">
            <Loader2 className="size-6 animate-spin text-[color:oklch(95%_0.15_108_/_0.7)]" />
            <p className="text-sm text-white/50">{PHASE_LABELS[phase]}</p>
          </div>
        ) : (
          <div className="mt-6 flex justify-center">
            <Button
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="h-11 px-8 text-sm font-medium bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)] disabled:opacity-50"
            >
              Create Town &amp; Start
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
