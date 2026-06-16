'use client';

import {
  useOrganizationModeById,
  useUpdateOrganizationMode,
  useOrganizationModes,
  useClearOrganizationAutoRoute,
  useDeleteOrganizationMode,
  useOrganizationWithMembers,
  useSetOrganizationAutoRoute,
} from '@/app/api/organizations/hooks';
import { ModeForm, type ModeFormData } from './ModeForm';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import { toast } from 'sonner';
import { DEFAULT_MODES } from './default-modes';

type EditModeFormProps = {
  organizationId: string;
  modeId: string;
  defaultModeSlug?: string;
  routeModel?: string;
  isDefaultModelConfigEnabled?: boolean;
  canSetDefaultModel?: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
};

function normalizeOptionalValue(value: string | undefined): string | undefined {
  return value || undefined;
}

function normalizeGroups(groups: unknown): string[] | undefined {
  if (!Array.isArray(groups)) {
    return undefined;
  }

  return groups.map(group => JSON.stringify(group)).sort();
}

export function matchesBuiltInModeState(formData: ModeFormData, defaultModeSlug: string): boolean {
  const defaultMode = DEFAULT_MODES.find(mode => mode.slug === defaultModeSlug);
  if (!defaultMode) {
    return false;
  }

  return (
    formData.name === defaultMode.name &&
    formData.slug === defaultMode.slug &&
    formData.roleDefinition === defaultMode.config.roleDefinition &&
    normalizeOptionalValue(formData.description) === defaultMode.config.description &&
    normalizeOptionalValue(formData.whenToUse) === defaultMode.config.whenToUse &&
    JSON.stringify(normalizeGroups(formData.groups)) ===
      JSON.stringify(normalizeGroups(defaultMode.config.groups)) &&
    normalizeOptionalValue(formData.customInstructions) === defaultMode.config.customInstructions
  );
}

export function EditModeForm({
  organizationId,
  modeId,
  defaultModeSlug,
  routeModel: propRouteModel,
  isDefaultModelConfigEnabled = false,
  canSetDefaultModel = true,
  onSuccess,
  onCancel,
}: EditModeFormProps) {
  const { data, isLoading, error } = useOrganizationModeById(organizationId, modeId);
  const { data: modesData } = useOrganizationModes(organizationId);
  const updateMutation = useUpdateOrganizationMode();
  const deleteMutation = useDeleteOrganizationMode();
  const setRouteMutation = useSetOrganizationAutoRoute();
  const clearRouteMutation = useClearOrganizationAutoRoute();
  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const currentRouteModel =
    propRouteModel ??
    (defaultModeSlug
      ? organizationData?.settings.org_auto_model?.routes[defaultModeSlug]
      : data?.mode
        ? organizationData?.settings.org_auto_model?.routes[data.mode.slug]
        : undefined);

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

  const handleSubmit = async (formData: ModeFormData) => {
    try {
      if (defaultModeSlug && matchesBuiltInModeState(formData, defaultModeSlug)) {
        await deleteMutation.mutateAsync({
          organizationId,
          modeId,
        });
        await persistRoute(defaultModeSlug, formData.defaultModel);
        toast.success(`Mode "${formData.name}" reverted successfully`);
        onSuccess?.();
        return;
      }

      const updated = await updateMutation.mutateAsync({
        organizationId,
        modeId,
        name: formData.name,
        slug: formData.slug,
        config: {
          roleDefinition: formData.roleDefinition,
          description: formData.description,
          whenToUse: formData.whenToUse,
          groups: formData.groups as ('read' | 'edit' | 'browser' | 'command' | 'mcp')[],
          customInstructions: formData.customInstructions,
        },
      });
      if (formData.defaultModel !== currentRouteModel) {
        await persistRoute(updated.mode.slug, formData.defaultModel);
      }
      toast.success(`Mode "${formData.name}" updated successfully`);
      onSuccess?.();
    } catch (error) {
      console.error('Failed to update mode:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update mode');
      throw error;
    }
  };

  if (isLoading) {
    return <LoadingCard title="Loading Mode" description="Loading mode details..." rowCount={5} />;
  }

  if (error || !data?.mode) {
    return (
      <ErrorCard
        title="Error Loading Mode"
        description="Failed to load mode details"
        error={error instanceof Error ? error : new Error('Mode not found')}
        onRetry={() => {}}
      />
    );
  }

  return (
    <ModeForm
      organizationId={organizationId}
      mode={data.mode}
      routeModel={currentRouteModel}
      onSubmit={handleSubmit}
      isSubmitting={
        updateMutation.isPending ||
        deleteMutation.isPending ||
        setRouteMutation.isPending ||
        clearRouteMutation.isPending
      }
      isEditingBuiltIn={!!defaultModeSlug}
      isDefaultModelConfigEnabled={isDefaultModelConfigEnabled}
      canSetDefaultModel={canSetDefaultModel}
      existingModes={modesData?.modes || []}
      onCancel={onCancel}
      renderButtons={() => null}
    />
  );
}
