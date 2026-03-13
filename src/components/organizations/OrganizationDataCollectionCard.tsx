'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import { Shield } from 'lucide-react';
import { useUserOrganizationRole } from './OrganizationContext';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useOrganizationReadOnly } from '@/lib/organizations/use-organization-read-only';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { toast } from 'sonner';

type OrganizationDataCollectionCardProps = {
  organizationId: string;
};

export function OrganizationDataCollectionCard({
  organizationId,
}: OrganizationDataCollectionCardProps) {
  const currentUserRole = useUserOrganizationRole();
  const { data: organizationData, isLoading, refetch } = useOrganizationWithMembers(organizationId);
  const trpcClient = useRawTRPCClient();
  const isReadOnly = useOrganizationReadOnly(organizationId);

  const handleDataCollectionChange = async (value: 'allow' | 'deny' | 'extension') => {
    const currentDataCollection = organizationData?.settings?.data_collection ?? null;
    const newValue = value === 'extension' ? null : value;
    if (newValue === currentDataCollection) return;

    try {
      await trpcClient.organizations.settings.updateDataCollection.mutate({
        organizationId,
        dataCollection: newValue,
      });
      toast.success('Data collection policy updated successfully');
      void refetch();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to update data collection policy';
      toast.error(errorMessage);
    }
  };

  if (isLoading) {
    return (
      <LoadingCard
        title="Data Collection Policy"
        description="Loading data collection settings..."
        rowCount={2}
      />
    );
  }

  if (!organizationData) {
    return (
      <ErrorCard
        title="Data Collection Policy"
        description="Error loading organization data"
        error={new Error('Organization data not found')}
        onRetry={() => {}}
      />
    );
  }

  // Get current data collection setting, use null as default (extension setting)
  const currentDataCollection = organizationData.settings?.data_collection ?? null;
  const displayValue = currentDataCollection === null ? 'extension' : currentDataCollection;

  const canEdit =
    (currentUserRole === 'owner' || currentUserRole === 'billing_manager') && !isReadOnly;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Shield className="mr-2 inline h-5 w-5" />
          Data Collection Policy
        </CardTitle>
        <CardDescription>
          Control whether your organization's data can be used for model training
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Current Policy</label>
          <Select
            value={displayValue}
            onValueChange={handleDataCollectionChange}
            disabled={!canEdit}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {displayValue === 'allow'
                  ? 'Allow Data Collection'
                  : displayValue === 'deny'
                    ? 'Deny Data Collection'
                    : 'Use Setting from Extension'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="extension">
                <div className="flex flex-col">
                  <span>Use Setting from Extension</span>
                  <span className="text-muted-foreground text-xs">
                    Follow the data collection setting configured in the extension
                  </span>
                </div>
              </SelectItem>
              <SelectItem value="allow">
                <div className="flex flex-col">
                  <span>Allow Data Collection</span>
                  <span className="text-muted-foreground text-xs">
                    Data may be used for model training and improvement
                  </span>
                </div>
              </SelectItem>
              <SelectItem value="deny">
                <div className="flex flex-col">
                  <span>Deny Data Collection</span>
                  <span className="text-muted-foreground text-xs">
                    Data will not be used for model training
                  </span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {!canEdit && (
          <p className="text-muted-foreground text-xs">
            Only organization owners and billing managers can modify data collection settings.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
