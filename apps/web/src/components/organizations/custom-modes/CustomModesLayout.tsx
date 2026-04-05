'use client';

import { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { useOrganizationModes, useDeleteOrganizationMode } from '@/app/api/organizations/hooks';
import { Button } from '@/components/ui/button';
import { LockableContainer } from '../LockableContainer';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Plus, Edit, Trash2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OrganizationMode } from '@/lib/organizations/organization-modes';
import { DEFAULT_MODES } from './default-modes';
import { ModeDrawer } from './ModeDrawer';
import { NewModeForm } from './NewModeForm';
import { EditModeForm } from './EditModeForm';
import { useOrganizationReadOnly } from '@/lib/organizations/use-organization-read-only';

type CustomModesLayoutProps = {
  organizationId: string;
};

type DisplayMode = OrganizationMode & {
  isDefault: boolean;
  isOverridden: boolean;
};

type ModesListProps = {
  organizationId: string;
  modes: DisplayMode[];
  readonly: boolean;
  onDeleteClick: (mode: DisplayMode) => void;
  onEditClick: (mode: DisplayMode) => void;
};

function ModesList({ modes, readonly, onDeleteClick, onEditClick }: ModesListProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {modes.map((mode, index) => (
        <motion.div
          key={mode.isDefault && !mode.isOverridden ? mode.slug : mode.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.3,
            delay: index * 0.05,
            ease: [0.25, 0.1, 0.25, 1],
          }}
        >
          <Card className="flex h-full flex-col">
            <CardHeader className="flex-none">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <CardTitle className="mb-2 line-clamp-1">{mode.name}</CardTitle>
                  <p className="text-muted-foreground line-clamp-2 h-10 text-sm">
                    {mode.config.description}
                  </p>
                </div>
                {!readonly && (
                  <div className="-mt-3 -mr-3 flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => onEditClick(mode)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    {mode.isOverridden ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDeleteClick(mode)}
                        className="text-amber-600 hover:text-amber-700"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    ) : (
                      !mode.isDefault && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onDeleteClick(mode)}
                          className="text-red-400 hover:text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1">
              <div className="flex h-full flex-col">
                {mode.config?.groups && mode.config.groups.length > 0 && (
                  <div className="flex-1">
                    <h4 className="mb-2 text-sm font-medium">Available Tools</h4>
                    <div className="flex flex-wrap gap-2">
                      {mode.config.groups.map((group, idx) => {
                        const groupName = Array.isArray(group) ? group[0] : group;
                        const groupConfig = Array.isArray(group) ? group[1] : null;
                        const hasRestriction = !!groupConfig;
                        const tooltipText = groupConfig
                          ? `Restricted file access: ${groupConfig.description || ''} (${groupConfig.fileRegex})`.trim()
                          : undefined;

                        const badgeContent = (
                          <Badge
                            key={`${groupName}-${idx}`}
                            variant="secondary"
                            className={hasRestriction ? 'cursor-pointer' : undefined}
                          >
                            {groupName}
                            {hasRestriction && ' *'}
                          </Badge>
                        );

                        return hasRestriction ? (
                          <Tooltip key={`${groupName}-${idx}`}>
                            <TooltipTrigger asChild>{badgeContent}</TooltipTrigger>
                            <TooltipContent>{tooltipText}</TooltipContent>
                          </Tooltip>
                        ) : (
                          badgeContent
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

export function CustomModesLayout({ organizationId }: CustomModesLayoutProps) {
  const { data, isLoading, error } = useOrganizationModes(organizationId);
  const deleteMutation = useDeleteOrganizationMode();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [modeToDelete, setModeToDelete] = useState<DisplayMode | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create');
  const [editingMode, setEditingMode] = useState<DisplayMode | null>(null);
  const isReadOnly = useOrganizationReadOnly(organizationId);

  const readonly = isReadOnly;

  // Separate built-in modes and custom modes
  const { builtInModes, customModes } = useMemo(() => {
    const customModesData = data?.modes || [];

    // Create a map of custom modes by slug for quick lookup
    const customModesBySlug = new Map(customModesData.map(m => [m.slug, m]));

    // Build the built-in modes list
    const builtInDisplayModes: DisplayMode[] = DEFAULT_MODES.map(defaultMode => {
      const customMode = customModesBySlug.get(defaultMode.slug);

      if (customMode) {
        // This default mode has been overridden
        return {
          ...customMode,
          isDefault: true,
          isOverridden: true,
        };
      } else {
        // This default mode is not overridden
        return {
          // Create a fake ID for default modes
          id: `default-${defaultMode.slug}`,
          organization_id: organizationId,
          slug: defaultMode.slug,
          name: defaultMode.name,
          config: defaultMode.config,
          created_by: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          isDefault: true,
          isOverridden: false,
        };
      }
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Build the custom modes list (only modes that don't override defaults)
    const defaultSlugs = new Set(DEFAULT_MODES.map(dm => dm.slug));
    const customDisplayModes: DisplayMode[] = customModesData
      .filter(mode => !defaultSlugs.has(mode.slug))
      .map(mode => ({
        ...mode,
        isDefault: false,
        isOverridden: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      builtInModes: builtInDisplayModes,
      customModes: customDisplayModes,
    };
  }, [data?.modes, organizationId]);

  const handleDelete = async () => {
    if (!modeToDelete) return;

    const action = modeToDelete.isOverridden ? 'reverted' : 'deleted';

    try {
      await deleteMutation.mutateAsync({
        organizationId,
        modeId: modeToDelete.id,
      });
      toast.success(`Mode "${modeToDelete.name}" ${action} successfully`);
      setDeleteDialogOpen(false);
      setModeToDelete(null);
    } catch (error) {
      console.error(`Failed to ${action.slice(0, -2)} mode:`, error);
      toast.error(error instanceof Error ? error.message : `Failed to ${action.slice(0, -2)} mode`);
    }
  };

  const openDeleteDialog = (mode: DisplayMode) => {
    setModeToDelete(mode);
    setDeleteDialogOpen(true);
  };

  const handleCreateMode = () => {
    setDrawerMode('create');
    setEditingMode(null);
    setDrawerOpen(true);
  };

  const handleEditMode = (mode: DisplayMode) => {
    setDrawerMode('edit');
    setEditingMode(mode);
    setDrawerOpen(true);
  };

  const handleDrawerClose = () => {
    setDrawerOpen(false);
    setEditingMode(null);
  };

  if (isLoading) {
    return <LoadingCard title="Custom Modes" description="Loading modes..." rowCount={3} />;
  }

  if (error) {
    return (
      <ErrorCard
        title="Custom Modes"
        description="Error loading custom modes"
        error={error instanceof Error ? error : new Error('Unknown error')}
        onRetry={() => {}}
      />
    );
  }

  return (
    <LockableContainer>
      <div className="space-y-6">
        <SetPageTitle title="Modes" />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-muted-foreground">
              Manage default and custom modes for your organization
            </p>
          </div>
          {!readonly && (
            <Button
              variant="primary"
              onClick={handleCreateMode}
              className="flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Create New Mode
            </Button>
          )}
        </div>

        <div className="space-y-8">
          {/* Built-in Modes Section */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Built-in Modes</h2>
            <ModesList
              organizationId={organizationId}
              modes={builtInModes}
              readonly={readonly}
              onDeleteClick={openDeleteDialog}
              onEditClick={handleEditMode}
            />
          </div>

          {/* Custom Modes Section */}
          {customModes.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Custom Modes</h2>
              <ModesList
                organizationId={organizationId}
                modes={customModes}
                readonly={readonly}
                onDeleteClick={openDeleteDialog}
                onEditClick={handleEditMode}
              />
            </div>
          )}
        </div>

        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {modeToDelete?.isOverridden ? 'Revert to Default Mode' : 'Delete Mode'}
              </DialogTitle>
              <DialogDescription>
                {modeToDelete?.isOverridden
                  ? `Are you sure you want to revert "${modeToDelete?.name}" to the default settings? This will delete your custom configuration.`
                  : `Are you sure you want to delete "${modeToDelete?.name}"? This action cannot be undone.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setModeToDelete(null);
                }}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant={modeToDelete?.isOverridden ? 'default' : 'destructive'}
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending
                  ? modeToDelete?.isOverridden
                    ? 'Reverting...'
                    : 'Deleting...'
                  : modeToDelete?.isOverridden
                    ? 'Revert to Default'
                    : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ModeDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title={drawerMode === 'create' ? 'Create New Mode' : `Edit - ${editingMode?.name}`}
          description={
            drawerMode === 'create'
              ? 'Configure a new custom mode for your organization'
              : editingMode?.isDefault && !editingMode?.isOverridden
                ? 'Create a custom version of this built-in mode for your organization'
                : 'Update the configuration for this custom mode'
          }
          footer={
            <div className="flex items-center justify-end gap-4">
              <Button type="button" variant="outline" onClick={handleDrawerClose}>
                Cancel
              </Button>
              <Button type="submit" form="mode-form" variant="primary">
                {drawerMode === 'create' ? 'Create Mode' : 'Update Mode'}
              </Button>
            </div>
          }
        >
          {drawerMode === 'create' || (editingMode?.isDefault && !editingMode?.isOverridden) ? (
            <NewModeForm
              organizationId={organizationId}
              defaultModeSlug={
                editingMode?.isDefault && !editingMode?.isOverridden ? editingMode.slug : undefined
              }
              onSuccess={handleDrawerClose}
              onCancel={handleDrawerClose}
            />
          ) : editingMode ? (
            <EditModeForm
              organizationId={organizationId}
              modeId={editingMode.id}
              onSuccess={handleDrawerClose}
              onCancel={handleDrawerClose}
            />
          ) : null}
        </ModeDrawer>
      </div>
    </LockableContainer>
  );
}
