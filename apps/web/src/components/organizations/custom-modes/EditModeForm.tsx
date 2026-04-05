'use client';

import {
  useOrganizationModeById,
  useUpdateOrganizationMode,
  useOrganizationModes,
} from '@/app/api/organizations/hooks';
import { ModeForm, type ModeFormData } from './ModeForm';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import { toast } from 'sonner';

type EditModeFormProps = {
  organizationId: string;
  modeId: string;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function EditModeForm({ organizationId, modeId, onSuccess, onCancel }: EditModeFormProps) {
  const { data, isLoading, error } = useOrganizationModeById(organizationId, modeId);
  const { data: modesData } = useOrganizationModes(organizationId);
  const updateMutation = useUpdateOrganizationMode();

  const handleSubmit = async (formData: ModeFormData) => {
    try {
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
      mode={data.mode}
      onSubmit={handleSubmit}
      isSubmitting={updateMutation.isPending}
      existingModes={modesData?.modes || []}
      onCancel={onCancel}
      renderButtons={() => null}
    />
  );
}
