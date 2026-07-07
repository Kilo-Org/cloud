'use client';

import { useSearchParams } from 'next/navigation';
import {
  useClearOrganizationAutoRoute,
  useCreateOrganizationMode,
  useOrganizationModes,
  useOrganizationWithMembers,
  useSetOrganizationAutoRoute,
} from '@/app/api/organizations/hooks';
import { ModeForm, type ModeFormData } from './ModeForm';
import { matchesBuiltInModeState } from './EditModeForm';
import { toast } from 'sonner';
import { DEFAULT_MODES } from './default-modes';
import { useMemo } from 'react';
import {
  getOrganizationAutoRoute,
  hasActiveOrganizationModelPolicy,
} from '@/lib/organizations/organization-auto-model-shared';
import { ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';

type NewModeFormProps = {
  organizationId: string;
  defaultModeSlug?: string;
  isDefaultModelConfigEnabled?: boolean;
  canSetDefaultModel?: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function NewModeForm({
  organizationId,
  defaultModeSlug: propDefaultModeSlug,
  isDefaultModelConfigEnabled = false,
  canSetDefaultModel = true,
  onSuccess,
  onCancel,
}: NewModeFormProps) {
  const searchParams = useSearchParams();
  const createMutation = useCreateOrganizationMode();
  const setRouteMutation = useSetOrganizationAutoRoute();
  const clearRouteMutation = useClearOrganizationAutoRoute();
  const { data: modesData } = useOrganizationModes(organizationId);
  const { data: organizationData } = useOrganizationWithMembers(organizationId);

  // Check if we're editing a default mode (from prop or search params)
  const defaultModeSlug = propDefaultModeSlug || searchParams.get('defaultMode');
  const defaultMode = useMemo(() => {
    if (!defaultModeSlug) return undefined;
    return DEFAULT_MODES.find(m => m.slug === defaultModeSlug);
  }, [defaultModeSlug]);
  const routeModel = defaultModeSlug
    ? getOrganizationAutoRoute(organizationData?.settings, defaultModeSlug)
    : undefined;
  const isOrganizationAutoDefaultActive =
    organizationData?.settings.default_model === ORG_AUTO_MODEL.id;
  const hasActiveModelPolicy = hasActiveOrganizationModelPolicy(organizationData?.settings);

  // Convert default mode to the format expected by ModeForm
  const initialMode = useMemo(() => {
    if (!defaultMode) return undefined;
    return {
      id: `default-${defaultMode.slug}`,
      organization_id: organizationId,
      slug: defaultMode.slug,
      name: defaultMode.name,
      config: defaultMode.config,
      created_by: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }, [defaultMode, organizationId]);

  const persistRoute = async (modeSlug: string, targetModelId: string | undefined) => {
    if (targetModelId) {
      await setRouteMutation.mutateAsync({
        organizationId,
        mode_slug: modeSlug,
        model_id: targetModelId,
      });
    } else {
      await clearRouteMutation.mutateAsync({ organizationId, mode_slug: modeSlug });
    }
  };

  const handleSubmit = async (data: ModeFormData) => {
    try {
      if (defaultModeSlug && matchesBuiltInModeState(data, defaultModeSlug)) {
        await persistRoute(defaultModeSlug, data.defaultModel);
        toast.success(`Mode "${data.name}" route updated successfully`);
        onSuccess?.();
        return;
      }

      const nextRouteModel = data.defaultModel || undefined;
      await createMutation.mutateAsync({
        organizationId,
        name: data.name,
        slug: data.slug,
        config: {
          roleDefinition: data.roleDefinition,
          description: data.description,
          whenToUse: data.whenToUse,
          groups: data.groups as ('read' | 'edit' | 'browser' | 'command' | 'mcp')[],
          customInstructions: data.customInstructions,
        },
        ...(nextRouteModel === routeModel ? {} : { route_model: nextRouteModel ?? null }),
      });
      toast.success(`Mode "${data.name}" created successfully`);
      onSuccess?.();
    } catch (error) {
      console.error('Failed to create mode:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create mode');
      throw error;
    }
  };

  return (
    <ModeForm
      organizationId={organizationId}
      mode={initialMode}
      routeModel={routeModel}
      onSubmit={handleSubmit}
      isSubmitting={
        createMutation.isPending || setRouteMutation.isPending || clearRouteMutation.isPending
      }
      isEditingBuiltIn={!!defaultMode}
      isDefaultModelConfigEnabled={isDefaultModelConfigEnabled}
      isOrganizationAutoDefaultActive={isOrganizationAutoDefaultActive}
      canSetDefaultModel={canSetDefaultModel}
      hasActiveModelPolicy={hasActiveModelPolicy}
      existingModes={modesData?.modes || []}
      onCancel={onCancel}
    />
  );
}
