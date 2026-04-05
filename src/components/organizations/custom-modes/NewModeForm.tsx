'use client';

import { useSearchParams } from 'next/navigation';
import { useCreateOrganizationMode, useOrganizationModes } from '@/app/api/organizations/hooks';
import { ModeForm, type ModeFormData } from './ModeForm';
import { toast } from 'sonner';
import { DEFAULT_MODES } from './default-modes';
import { useMemo } from 'react';

type NewModeFormProps = {
  organizationId: string;
  defaultModeSlug?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function NewModeForm({
  organizationId,
  defaultModeSlug: propDefaultModeSlug,
  onSuccess,
  onCancel,
}: NewModeFormProps) {
  const searchParams = useSearchParams();
  const createMutation = useCreateOrganizationMode();
  const { data: modesData } = useOrganizationModes(organizationId);

  // Check if we're editing a default mode (from prop or search params)
  const defaultModeSlug = propDefaultModeSlug || searchParams.get('defaultMode');
  const defaultMode = useMemo(() => {
    if (!defaultModeSlug) return undefined;
    return DEFAULT_MODES.find(m => m.slug === defaultModeSlug);
  }, [defaultModeSlug]);

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

  const handleSubmit = async (data: ModeFormData) => {
    try {
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
      mode={initialMode}
      onSubmit={handleSubmit}
      isSubmitting={createMutation.isPending}
      isEditingBuiltIn={!!defaultMode}
      existingModes={modesData?.modes || []}
      onCancel={onCancel}
      renderButtons={() => null}
    />
  );
}
