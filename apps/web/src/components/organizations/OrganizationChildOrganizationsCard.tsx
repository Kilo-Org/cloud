'use client';

import Link from 'next/link';
// React must be in scope for the classic JSX runtime used by the jest transform.
import React, { useState, type FormEvent } from 'react';
import { Building2, ChevronRight, Loader2, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, type ButtonProps } from '@/components/ui/button';
import { CardLinkFooter } from '@/components/ui/card.client';
import { useCreateChildOrganization, useOrganizationChildren } from '@/app/api/organizations/hooks';
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
import { toast } from 'sonner';

type Props = {
  organizationId: string;
};

export function CreateSubOrganizationButton({
  organizationId,
  variant,
  className,
}: {
  organizationId: string;
  variant?: ButtonProps['variant'];
  className?: string;
}) {
  const createChild = useCreateChildOrganization();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [name, setName] = useState('');

  const handleCreateChild = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    createChild.mutate(
      { organizationId, name: trimmedName },
      {
        onSuccess: result => {
          setName('');
          setIsCreateDialogOpen(false);
          toast.success(`${result.organization.name} created`);
        },
        onError: error => {
          toast.error(error.message || 'Failed to create sub-organization');
        },
      }
    );
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={className}
        onClick={() => setIsCreateDialogOpen(true)}
      >
        Create sub-organization
        <Plus />
      </Button>
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create sub-organization</DialogTitle>
            <DialogDescription>
              Create an empty sub-organization managed by this parent organization.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleCreateChild}>
            <div className="grid gap-2">
              <Label htmlFor="child-organization-name">Organization name</Label>
              <Input
                id="child-organization-name"
                value={name}
                onChange={event => setName(event.target.value)}
                autoComplete="organization"
                maxLength={100}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateDialogOpen(false)}
                disabled={createChild.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createChild.isPending || name.trim().length === 0}>
                {createChild.isPending && <Loader2 className="size-4 animate-spin" />}
                Create sub-organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OrganizationChildOrganizationsCard({ organizationId }: Props) {
  const { data: children = [], isLoading } = useOrganizationChildren(organizationId);

  return (
    <OrganizationChildOrganizationsCardView
      organizationId={organizationId}
      childOrganizations={children}
      isLoading={isLoading}
    />
  );
}

export function OrganizationChildOrganizationsCardView({
  organizationId,
  childOrganizations: children,
  isLoading,
}: Props & {
  childOrganizations: { id: string; name: string }[];
  isLoading: boolean;
}) {
  const visibleChildren = children.slice(0, 5);
  const remainingCount = Math.max(0, children.length - visibleChildren.length);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Building2 className="mr-2 inline h-5 w-5" />
          Sub-organizations
        </CardTitle>
        <CardDescription>
          {isLoading
            ? 'Loading sub-organizations...'
            : children.length > 0
              ? `${children.length} sub-organization${children.length === 1 ? ' belongs' : 's belong'} to this organization`
              : 'Create sub-organizations to manage teams, usage, credits, models, and permissions separately.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {visibleChildren.length > 0 && (
          <div className="space-y-2">
            {visibleChildren.map(child => (
              <Link
                key={child.id}
                prefetch={false}
                href={`/organizations/${encodeURIComponent(child.id)}`}
                className="hover:bg-surface-hover focus-visible:ring-ring -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-1 focus-visible:outline-none"
              >
                <span className="truncate font-medium" title={child.name}>
                  {child.name}
                </span>
                <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
              </Link>
            ))}
          </div>
        )}
        {!isLoading && (
          <CardLinkFooter
            href={`/organizations/${encodeURIComponent(organizationId)}/sub-organizations`}
            className="flex items-center gap-2"
          >
            {children.length > 0 ? 'Manage sub-organizations' : 'Set up sub-organizations'}
            <span className="ml-auto flex items-center gap-2">
              {remainingCount > 0 && `${remainingCount} more`}
              <ChevronRight className="size-4" />
            </span>
          </CardLinkFooter>
        )}
      </CardContent>
    </Card>
  );
}
