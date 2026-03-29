'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { User, Building2, Plus, Users, AlertCircle, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useCreateOrganization } from '@/app/api/organizations/hooks';
import type { WorkspaceSelection } from './types';

type WorkspaceSelectorProps = {
  onSelect: (selection: WorkspaceSelection) => void;
};

export function WorkspaceSelector({ onSelect }: WorkspaceSelectorProps) {
  const trpc = useTRPC();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: organizations, isLoading } = useQuery(trpc.organizations.list.queryOptions());
  const createOrganizationMutation = useCreateOrganization();

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
        name: result.organization.name,
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
        <p className="text-muted-foreground text-center">Loading your workspaces...</p>
        <div className="animate-pulse space-y-3">
          <div className="bg-muted h-20 rounded-lg" />
          <div className="bg-muted h-20 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-muted-foreground">
          Choose which Kilo Workspace you wish to connect to Slack. You can use Kilo for Slack with
          your personal or organization account.
        </p>
      </div>

      <div className="space-y-3">
        {/* Personal Account Option */}
        <motion.div whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}>
          <Card
            className="cursor-pointer transition-all hover:border-blue-500/50 hover:shadow-md"
            onClick={() => onSelect({ type: 'user' })}
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div className="bg-brand-primary/10 flex h-12 w-12 items-center justify-center rounded-full">
                <User className="text-brand-primary h-6 w-6" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-base">Personal Account</CardTitle>
                <CardDescription className="text-sm">
                  Connect Slack for your individual use
                </CardDescription>
              </div>
              <ArrowRight className="text-muted-foreground h-5 w-5" />
            </CardContent>
          </Card>
        </motion.div>

        {/* Existing Organizations */}
        {organizations && organizations.length > 0 && (
          <>
            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card text-muted-foreground px-2">Or select a workspace</span>
              </div>
            </div>

            {organizations.map(org => (
              <motion.div
                key={org.organizationId}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
              >
                <Card
                  className="cursor-pointer transition-all hover:border-blue-500/50 hover:shadow-md"
                  onClick={() =>
                    onSelect({
                      type: 'org',
                      id: org.organizationId,
                      name: org.organizationName,
                    })
                  }
                >
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="bg-brand-primary/10 flex h-12 w-12 items-center justify-center rounded-full">
                      <Building2 className="text-brand-primary h-6 w-6" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-base">{org.organizationName}</CardTitle>
                      <CardDescription className="flex items-center gap-2 text-sm">
                        <Users className="h-3 w-3" />
                        {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                        <span className="text-muted-foreground">•</span>
                        <span className="capitalize">{org.role}</span>
                      </CardDescription>
                    </div>
                    <ArrowRight className="text-muted-foreground h-5 w-5" />
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </>
        )}

        {/* Create New Organization */}
        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card text-muted-foreground px-2">Or create new</span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {!showCreateForm ? (
            <motion.div
              key="create-button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <Card
                className="cursor-pointer border-dashed transition-all hover:border-blue-500/50 hover:shadow-md"
                onClick={() => setShowCreateForm(true)}
              >
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-dashed">
                    <Plus className="text-muted-foreground h-6 w-6" />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-muted-foreground text-base">
                      Create New Organization
                    </CardTitle>
                    <CardDescription className="text-sm">
                      Share Kilo for Slack with your team. Starts with a 14-day free trial
                    </CardDescription>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ) : (
            <motion.div
              key="create-form"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              <Card>
                <CardContent className="p-4">
                  <form onSubmit={handleCreateOrganization} className="space-y-4">
                    <div className="space-y-2">
                      <label htmlFor="org-name" className="text-sm font-medium">
                        Workspace Name
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
                          <AlertCircle className="h-4 w-4 flex-shrink-0" />
                          <span>{createError}</span>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
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
                        variant="primary"
                        disabled={createOrganizationMutation.isPending}
                        className="flex-1"
                      >
                        {createOrganizationMutation.isPending ? 'Creating...' : 'Create & Continue'}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
