'use client';

import {
  useOrganizationModeById,
  useUpdateOrganizationMode,
  useOrganizationModes,
  useDeleteOrganizationMode,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';
import { ModeForm, type ModeFormData } from './ModeForm';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import { toast } from 'sonner';
import { DEFAULT_MODES } from './default-modes';
import { ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import { hasActiveOrganizationModelPolicy } from '@/lib/organizations/organization-auto-model-shared';

type EditModeFormProps = {
  organizationId: string;
  modeId: string;
  defaultModeSlug?: string;
  isDefaultModelConfigEnabled?: boolean;
  canSetDefaultModel?: boolean;
  canMaintainRoutedMode?: boolean;
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

  return groups
    .map(group => {
      if (Array.isArray(group) && group[0] === 'edit') {
        return JSON.stringify([
          'edit',
          { fileRegex: group[1]?.fileRegex ?? '', description: group[1]?.description ?? '' },
        ]);
      }
      return JSON.stringify(group);
    })
    .sort();
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
  isDefaultModelConfigEnabled = false,
  canSetDefaultModel = true,
  canMaintainRoutedMode = true,
  onSuccess,
  onCancel,
}: EditModeFormProps) {
  const { data, isLoading, error } = useOrganizationModeById(organizationId, modeId);
  const { data: modesData } = useOrganizationModes(organizationId);
  const updateMutation = useUpdateOrganizationMode();
  const deleteMutation = useDeleteOrganizationMode();
  const { data: organizationData, isLoading: isOrganizationLoading } =
    useOrganizationWithMembers(organizationId);
  const currentRouteModel = defaultModeSlug
    ? organizationData?.settings.org_auto_model?.routes[defaultModeSlug]
    : data?.mode
      ? organizationData?.settings.org_auto_model?.routes[data.mode.slug]
      : undefined;
  const isOrganizationAutoDefaultActive =
    organizationData?.settings.default_model === ORG_AUTO_MODEL.id;
  const hasActiveModelPolicy = hasActiveOrganizationModelPolicy(organizationData?.settings);

  const handleSubmit = async (formData: ModeFormData) => {
    try {
      const nextRouteModel = formData.defaultModel || undefined;
      if (defaultModeSlug && matchesBuiltInModeState(formData, defaultModeSlug)) {
        if (currentRouteModel && !canMaintainRoutedMode) {
          toast.error('Organization owners must revert a routed built-in mode.');
          return;
        }
        await deleteMutation.mutateAsync({
          organizationId,
          modeId,
          preserve_route: true,
          ...(nextRouteModel === currentRouteModel ? {} : { route_model: nextRouteModel ?? null }),
        });
        toast.success(`Mode "${formData.name}" reverted successfully`);
        onSuccess?.();
        return;
      }

      await updateMutation.mutateAsync({
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
        ...(nextRouteModel === currentRouteModel ? {} : { route_model: nextRouteModel ?? null }),
      });
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
      isSubmitting={isOrganizationLoading || updateMutation.isPending || deleteMutation.isPending}
      isEditingBuiltIn={!!defaultModeSlug}
      isDefaultModelConfigEnabled={isDefaultModelConfigEnabled}
      isOrganizationAutoDefaultActive={isOrganizationAutoDefaultActive}
      canSetDefaultModel={canSetDefaultModel}
      hasActiveModelPolicy={hasActiveModelPolicy}
      disableSlug={!!currentRouteModel && !canMaintainRoutedMode}
      existingModes={modesData?.modes || []}
      onCancel={onCancel}
    />
  );
}
