'use client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useDeleteOrganization } from '@/app/admin/api/organizations/hooks';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

export function OrganizationAdminDelete({ organizationId }: { organizationId: string }) {
  const deleteOrganization = useDeleteOrganization();
  const router = useRouter();
  const { data: organization } = useOrganizationWithMembers(organizationId);

  const handleDelete = async () => {
    try {
      await deleteOrganization.mutateAsync({ organizationId });
      router.push('/admin/organizations');
    } catch (error) {
      console.error('Failed to delete organization:', error);
    }
  };

  if (!organization) {
    return null;
  }

  return (
    <Card className="border-red-800 bg-red-950/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-200">
          <AlertTriangle />
          Danger Zone
        </CardTitle>
        <CardDescription className="text-red-300">
          Irreversible and destructive actions
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-red-200">Delete Organization</h4>
            <p className="text-sm text-red-300">
              Permanently delete this organization and all associated data. This action cannot be
              undone.
            </p>
          </div>
          <InlineDeleteConfirmation
            onDelete={handleDelete}
            isLoading={deleteOrganization.isPending}
            confirmText="Delete Organization"
            cancelText="Cancel"
            showAsButton={true}
            buttonText="Delete"
            className="ml-4"
          />
        </div>
      </CardContent>
    </Card>
  );
}
