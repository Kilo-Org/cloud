'use client';

import { useDeferredValue, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Building2, Loader2, Plus, Search, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAdminOrganizationHierarchy,
  useAdminOrganizationDetails,
  useCreateAdminOrganization,
  useSearchAdminOrganizations,
  useSetParentOrganization,
} from '@/app/admin/api/organizations/hooks';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type OrganizationSearchResult = {
  id: string;
  name: string;
};

type OrganizationSummary = {
  id: string;
  name: string;
};

type OrganizationAdminHierarchyManagementProps = {
  organizationId: string;
};

export function OrganizationAdminHierarchyManagement({
  organizationId,
}: OrganizationAdminHierarchyManagementProps) {
  const hierarchyQuery = useAdminOrganizationHierarchy(organizationId, true);
  const organizationDetailsQuery = useAdminOrganizationDetails(organizationId);
  const setParentOrganization = useSetParentOrganization(organizationId);
  const createOrganization = useCreateAdminOrganization(organizationId);
  const [newChildName, setNewChildName] = useState('');
  const [childSearch, setChildSearch] = useState('');
  const [isAddExistingDialogOpen, setIsAddExistingDialogOpen] = useState(false);
  const [isCreateNewDialogOpen, setIsCreateNewDialogOpen] = useState(false);
  const [pendingChild, setPendingChild] = useState<OrganizationSearchResult | null>(null);
  const deferredChildSearch = useDeferredValue(childSearch.trim());
  const organizationSearchQuery = useSearchAdminOrganizations(
    deferredChildSearch,
    10,
    organizationId
  );

  const childOrganizations = hierarchyQuery.data?.children ?? [];
  const organizationName = organizationDetailsQuery.data?.name ?? organizationId;
  const canManageChildren = hierarchyQuery.data?.parent === null;
  const searchResults = organizationSearchQuery.data ?? [];

  const handleCreateChild = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newChildName.trim();

    if (!name) {
      toast.error('Organization name is required');
      return;
    }

    createOrganization.mutate(
      { name, parentOrganizationId: organizationId },
      {
        onSuccess: data => {
          toast.success(`Created child organization "${data.organization.name}"`);
          setNewChildName('');
          setIsCreateNewDialogOpen(false);
        },
        onError: error => {
          toast.error(error.message || 'Failed to create child organization');
        },
      }
    );
  };

  const handleAddExistingChild = () => {
    if (!pendingChild) {
      toast.error('Select an organization to add as a child');
      return;
    }

    setParentOrganization.mutate(
      { organizationId: pendingChild.id, parentOrganizationId: organizationId },
      {
        onSuccess: () => {
          toast.success(`Added "${pendingChild.name}" as a child organization`);
          setPendingChild(null);
          setChildSearch('');
        },
        onError: error => {
          toast.error(error.message || 'Failed to add child organization');
        },
      }
    );
  };

  const handleDetachChild = (child: OrganizationSummary) => {
    setParentOrganization.mutate(
      { organizationId: child.id, parentOrganizationId: null },
      {
        onSuccess: () => {
          toast.success(`Detached "${child.name}" from this parent organization`);
        },
        onError: error => {
          toast.error(error.message || 'Failed to detach child organization');
        },
      }
    );
  };

  const handleSelectChild = (organization: OrganizationSearchResult) => {
    setPendingChild(organization);
    setIsAddExistingDialogOpen(false);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="size-5" />
            Child Organizations
          </CardTitle>
          <CardDescription>
            Attach an existing organization as a child, or create a new empty child organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              onClick={() => setIsAddExistingDialogOpen(true)}
              disabled={!canManageChildren}
            >
              <Plus className="mr-2 size-4" />
              Add Existing
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsCreateNewDialogOpen(true)}
              disabled={!canManageChildren}
            >
              <Plus className="mr-2 size-4" />
              Create New
            </Button>
          </div>
          {!canManageChildren ? (
            <p className="text-muted-foreground text-sm">
              Child organizations cannot have their own child organizations yet.
            </p>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="type-label text-foreground">Current children</h3>
              {hierarchyQuery.isFetching ? (
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              ) : null}
            </div>
            {childOrganizations.length > 0 ? (
              <div className="space-y-2">
                {childOrganizations.map(childOrganization => (
                  <div
                    key={childOrganization.id}
                    className="border-border bg-surface-raised flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <Link
                      href={`/admin/organizations/${encodeURIComponent(childOrganization.id)}`}
                      className="text-link hover:text-link-hover min-w-0 truncate text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {childOrganization.name}
                    </Link>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDetachChild(childOrganization)}
                      disabled={setParentOrganization.isPending}
                    >
                      <Unlink className="mr-2 size-4" />
                      Detach
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">No child organizations yet.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={isAddExistingDialogOpen} onOpenChange={setIsAddExistingDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Existing Organization</DialogTitle>
            <DialogDescription>
              Search for an organization to attach under {organizationName}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label htmlFor="child-organization-search">Organization</Label>
            <div className="relative">
              <Input
                id="child-organization-search"
                type="text"
                autoComplete="off"
                value={childSearch}
                onChange={event => setChildSearch(event.target.value)}
                placeholder="Search by organization name or ID"
                className="pr-10"
              />
              {organizationSearchQuery.isFetching ? (
                <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin" />
              ) : (
                <Search className="text-muted-foreground absolute top-1/2 right-3 size-4 -translate-y-1/2" />
              )}
            </div>
            {searchResults.length > 0 ? (
              <div className="bg-popover max-h-56 overflow-y-auto rounded-md border shadow-lg">
                {searchResults.map(organization => (
                  <button
                    key={organization.id}
                    type="button"
                    className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground w-full px-3 py-2 text-left text-sm focus:outline-none"
                    onClick={() => handleSelectChild(organization)}
                  >
                    <span className="block font-medium">{organization.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {organization.id}
                    </span>
                  </button>
                ))}
              </div>
            ) : childSearch.trim().length > 0 && !organizationSearchQuery.isFetching ? (
              <p className="text-muted-foreground text-sm">No matching organizations found.</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateNewDialogOpen} onOpenChange={setIsCreateNewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Child Organization</DialogTitle>
            <DialogDescription>
              Create a new empty organization under {organizationName}.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleCreateChild}>
            <div className="grid gap-2">
              <Label htmlFor="new-child-organization-name">Organization name</Label>
              <Input
                id="new-child-organization-name"
                value={newChildName}
                onChange={event => setNewChildName(event.target.value)}
                autoComplete="off"
                placeholder="New organization name"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateNewDialogOpen(false)}
                disabled={createOrganization.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createOrganization.isPending}>
                {createOrganization.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 size-4" />
                )}
                Create Organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingChild !== null}
        onOpenChange={open => {
          if (!open) {
            setPendingChild(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add child organization?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure that you want to add {pendingChild?.name ?? 'this organization'} as a
              child of {organizationName}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setParentOrganization.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleAddExistingChild}
              disabled={setParentOrganization.isPending}
            >
              {setParentOrganization.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Add Child
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
