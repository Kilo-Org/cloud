'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { Building2, Check, ChevronRight, Plus, User, Users, AlertCircle } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useCreateOrganization } from '@/app/api/organizations/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type WorkspaceSelection = { type: 'org'; id: string } | { type: 'personal' };

type WorkspaceSelectorProps = {
  value: WorkspaceSelection | null;
  onSelect: (selection: WorkspaceSelection) => void;
};

const ROLE_PRIORITY: Record<string, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  billing_manager: 3,
};

export function WorkspaceSelector({ value, onSelect }: WorkspaceSelectorProps) {
  const trpc = useTRPC();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: organizations, isLoading } = useQuery(trpc.organizations.list.queryOptions());
  const createOrganizationMutation = useCreateOrganization();

  const sortedOrgs =
    organizations?.slice().sort((a, b) => {
      const aPriority = ROLE_PRIORITY[a.role] ?? 99;
      const bPriority = ROLE_PRIORITY[b.role] ?? 99;
      return aPriority - bPriority;
    }) ?? [];

  const handleCreateOrganization = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);

    if (!newOrgName.trim()) {
      setCreateError('Please enter a workspace name');
      return;
    }

    try {
      const result = await createOrganizationMutation.mutateAsync({
        name: newOrgName.trim(),
        autoAddCreator: true,
      });

      onSelect({
        type: 'org',
        id: result.organization.id,
      });
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'Failed to create workspace. Please try again.'
      );
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse space-y-3">
          <div className="bg-muted h-20 rounded-xl" />
          <div className="bg-muted h-20 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Existing Organizations */}
      {sortedOrgs.map(org => {
        const isSelected = value?.type === 'org' && value.id === org.organizationId;
        return (
          <WorkspaceRow
            key={org.organizationId}
            selected={isSelected}
            onClick={() => onSelect({ type: 'org', id: org.organizationId })}
          >
            <div className="bg-primary/10 flex size-10 items-center justify-center rounded-full">
              <Building2 className="text-primary size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">{org.organizationName}</p>
              <p className="text-muted-foreground flex items-center gap-1 text-sm">
                <Users className="size-3" />
                {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                <span className="text-muted-foreground">·</span>
                <span className="capitalize">{org.role}</span>
              </p>
            </div>
            {isSelected ? (
              <span className="bg-primary text-primary-foreground grid size-5 place-items-center rounded-full">
                <Check className="size-3" strokeWidth={3} />
              </span>
            ) : (
              <ChevronRight className="text-muted-foreground size-5" />
            )}
          </WorkspaceRow>
        );
      })}

      {/* Divider before create new / personal */}
      {(sortedOrgs.length > 0 || showCreateForm) && (
        <div className="relative py-1">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
        </div>
      )}

      {/* Create New Organization */}
      <AnimatePresence mode="wait">
        {!showCreateForm ? (
          <motion.div
            key="create-button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <WorkspaceRow onClick={() => setShowCreateForm(true)}>
              <div className="flex size-10 items-center justify-center rounded-full border-2 border-dashed border-border">
                <Plus className="text-muted-foreground size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-muted-foreground text-base font-medium">
                  Create new organization
                </p>
                <p className="text-muted-foreground text-sm">Share Kilo with your team</p>
              </div>
            </WorkspaceRow>
          </motion.div>
        ) : (
          <motion.div
            key="create-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="bg-card border-border rounded-xl border p-4">
              <form onSubmit={handleCreateOrganization} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="org-name" className="text-sm font-medium">
                    Organization name
                  </label>
                  <Input
                    id="org-name"
                    placeholder="Enter your company or team name"
                    value={newOrgName}
                    onChange={e => setNewOrgName(e.target.value)}
                    autoFocus
                  />
                </div>

                <AnimatePresence>
                  {createError && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-2 rounded-lg bg-red-950/30 p-3 text-sm text-red-400"
                    >
                      <AlertCircle className="size-4 flex-shrink-0" />
                      <span>{createError}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setShowCreateForm(false);
                      setNewOrgName('');
                      setCreateError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createOrganizationMutation.isPending}
                    className="flex-1"
                  >
                    {createOrganizationMutation.isPending ? 'Creating...' : 'Create & continue'}
                  </Button>
                </div>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Personal Account */}
      <WorkspaceRow
        selected={value?.type === 'personal'}
        onClick={() => onSelect({ type: 'personal' })}
      >
        <div className="bg-primary/10 flex size-10 items-center justify-center rounded-full">
          <User className="text-primary size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium">Personal account</p>
          <p className="text-muted-foreground text-sm">Install on your personal instance</p>
        </div>
        {value?.type === 'personal' ? (
          <span className="bg-primary text-primary-foreground grid size-5 place-items-center rounded-full">
            <Check className="size-3" strokeWidth={3} />
          </span>
        ) : (
          <ChevronRight className="text-muted-foreground size-5" />
        )}
      </WorkspaceRow>
    </div>
  );
}

type WorkspaceRowProps = {
  children: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
};

function WorkspaceRow({ children, selected, onClick }: WorkspaceRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected
          ? 'border-primary/70 ring-1 ring-primary/40 bg-primary/5'
          : 'border-border bg-card hover:border-primary/30 active:scale-[0.99]'
      )}
    >
      {children}
    </button>
  );
}
