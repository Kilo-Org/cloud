'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Plus, Search, Check, X, RefreshCw } from 'lucide-react';
import {
  useModelStatsList,
  useUpdateModel,
  useCreateModel,
  useTriggerStatsUpdate,
  useBustModelStatsCache,
} from '@/app/admin/api/model-stats/hooks';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';

export function ModelStatsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState<{
    id: string;
    field: 'aaSlug' | 'isActive' | 'isFeatured' | 'isStealth';
  } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [updatingModelId, setUpdatingModelId] = useState<string | null>(null);

  const currentPage = parseInt(searchParams.get('page') || '1');
  const currentPageSize = parseInt(searchParams.get('limit') || '25');
  const currentSearch = searchParams.get('search') || '';
  const currentIsActive = (searchParams.get('isActive') || '') as '' | 'true' | 'false';

  const { data, isLoading } = useModelStatsList({
    page: currentPage,
    limit: currentPageSize,
    sortBy: 'name',
    sortOrder: 'asc',
    search: currentSearch,
    isActive: currentIsActive,
  });

  const updateModel = useUpdateModel();
  const createModel = useCreateModel();
  const triggerStatsUpdate = useTriggerStatsUpdate();
  const bustCache = useBustModelStatsCache();

  const updateUrl = useCallback(
    (params: Record<string, string>) => {
      const newSearchParams = new URLSearchParams(searchParams.toString());
      Object.entries(params).forEach(([key, value]) => {
        if (value) {
          newSearchParams.set(key, value);
        } else {
          newSearchParams.delete(key);
        }
      });
      router.push(`/admin/model-stats?${newSearchParams.toString()}`);
    },
    [router, searchParams]
  );

  const handleSearchChange = useCallback(
    (searchTerm: string) => {
      updateUrl({
        search: searchTerm,
        page: '1',
        limit: currentPageSize.toString(),
      });
    },
    [currentPageSize, updateUrl]
  );

  const handlePageChange = useCallback(
    (page: number) => {
      updateUrl({
        search: currentSearch,
        page: page.toString(),
        limit: currentPageSize.toString(),
      });
    },
    [currentSearch, currentPageSize, updateUrl]
  );

  const startEdit = (
    modelId: string,
    aaSlug: string | null,
    field: 'aaSlug' | 'isActive' | 'isFeatured' | 'isStealth'
  ) => {
    setEditingField({ id: modelId, field });
    setEditValue(field === 'aaSlug' ? aaSlug || '' : '');
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  const saveEdit = async (
    modelId: string,
    currentIsActiveValue: boolean | null,
    currentIsFeaturedValue?: boolean | null,
    currentIsStealthValue?: boolean | null
  ) => {
    if (!editingField) return;

    // Guard against concurrent updates
    if (updatingModelId) return;

    setUpdatingModelId(modelId);
    try {
      if (editingField.field === 'aaSlug') {
        await updateModel.mutateAsync({
          id: modelId,
          aaSlug: editValue || null,
        });
      } else if (editingField.field === 'isActive') {
        await updateModel.mutateAsync({
          id: modelId,
          isActive: !currentIsActiveValue,
        });
      } else if (editingField.field === 'isFeatured') {
        await updateModel.mutateAsync({
          id: modelId,
          isFeatured: !currentIsFeaturedValue,
        });
      } else if (editingField.field === 'isStealth') {
        await updateModel.mutateAsync({
          id: modelId,
          isStealth: !currentIsStealthValue,
        });
      }
      toast.success('Model updated successfully');
      setEditingField(null);
      setEditValue('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update model');
    } finally {
      setUpdatingModelId(null);
    }
  };

  const handleCreateModel = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    try {
      await createModel.mutateAsync({
        openrouterId: formData.get('openrouterId') as string,
        name: formData.get('name') as string,
        slug: (formData.get('slug') as string) || undefined,
        aaSlug: (formData.get('aaSlug') as string) || undefined,
        isActive: formData.get('isActive') === 'on',
      });
      toast.success('Model created successfully');
      setIsCreateDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create model');
    }
  };

  const handleTriggerUpdate = async () => {
    try {
      const result = (await triggerStatsUpdate.mutateAsync()) as {
        newModels?: number;
        updatedModels?: number;
        duration?: string;
      };
      toast.success(
        `Stats updated successfully! ${result.newModels ?? 0} new, ${result.updatedModels ?? 0} updated (${result.duration ?? 'unknown'})`
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to trigger stats update');
    }
  };

  const handleBustCache = async () => {
    try {
      await bustCache.mutateAsync();
      toast.success('Cache busted successfully!');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to bust cache');
    }
  };

  const formatRelativeTime = (timestamp: string | null) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  };

  const buttons = (
    <div className="flex gap-2">
      <Button variant="outline" onClick={handleBustCache} disabled={bustCache.isPending}>
        <RefreshCw className={`h-4 w-4 ${bustCache.isPending ? 'animate-spin' : ''}`} />
        {bustCache.isPending ? 'Busting...' : 'Bust Cache'}
      </Button>
      <Button
        variant="outline"
        onClick={handleTriggerUpdate}
        disabled={triggerStatsUpdate.isPending}
      >
        <RefreshCw className={`h-4 w-4 ${triggerStatsUpdate.isPending ? 'animate-spin' : ''}`} />
        {triggerStatsUpdate.isPending ? 'Updating...' : 'Update Stats'}
      </Button>
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline">
            <Plus className="h-4 w-4" />
            Add Model
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Model</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateModel} className="space-y-4">
            <div>
              <Label htmlFor="openrouterId">OpenRouter ID *</Label>
              <Input id="openrouterId" name="openrouterId" required />
            </div>
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="slug">Slug</Label>
              <Input id="slug" name="slug" />
            </div>
            <div>
              <Label htmlFor="aaSlug">AA Slug</Label>
              <Input id="aaSlug" name="aaSlug" />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox id="isActive" name="isActive" defaultChecked />
              <Label htmlFor="isActive">Active</Label>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createModel.isPending}>
                {createModel.isPending ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );

  const breadcrumbs = (
    <BreadcrumbItem>
      <BreadcrumbPage>Model Stats</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs} buttons={buttons}>
      <div className="flex max-w-max flex-col gap-y-4">
        {data?.lastUpdated && (
          <div className="text-muted-foreground text-sm">
            Last updated: {formatRelativeTime(data.lastUpdated)}
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2 h-4 w-4" />
            <Input
              placeholder="Search by name, OpenRouter ID, or slug..."
              value={currentSearch}
              onChange={e => handleSearchChange(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>

        <div className="bg-muted/50 rounded-lg border p-4 text-sm">
          <p className="mb-2">
            <strong>About Model Stats:</strong> This table manages model data that powers the public
            models page at kilo.ai/models.
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong>Data Source:</strong> Model information is automatically synced from the
              OpenRouter API, including pricing, context length, and technical specifications.
            </li>
            <li>
              <strong>AA Slug:</strong> The "AA Slug" field corresponds to model identifiers from{' '}
              <a
                href="https://artificialanalysis.ai/models"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                artificialanalysis.ai
              </a>{' '}
              (e.g., "claude-opus-4-5-thinking" for{' '}
              <a
                href="https://artificialanalysis.ai/models/claude-opus-4-5-thinking"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                this model
              </a>
              ). Click any AA Slug value to edit it and link benchmark data.
            </li>
            <li>
              <strong>Active Status:</strong> Click the Active/Inactive badge to toggle whether a
              model appears on the public models page.
            </li>
          </ul>
        </div>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>OpenRouter ID</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>AA Slug</TableHead>
                <TableHead>Coding Index</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Featured</TableHead>
                <TableHead>Stealth</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : data?.models.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center">
                    No models found
                  </TableCell>
                </TableRow>
              ) : (
                data?.models.map(model => {
                  const isUpdating = updatingModelId === model.id;
                  return (
                    <TableRow key={model.id} className={isUpdating ? 'opacity-50' : ''}>
                      <TableCell className="font-medium">{model.name}</TableCell>
                      <TableCell className="font-mono text-sm">{model.openrouterId}</TableCell>
                      <TableCell className="font-mono text-sm">{model.slug || '-'}</TableCell>
                      <TableCell>
                        {editingField?.id === model.id && editingField.field === 'aaSlug' ? (
                          <div className="flex items-center gap-1">
                            <Input
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              className="h-8 w-32"
                              autoFocus
                              disabled={isUpdating}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => saveEdit(model.id, model.isActive)}
                              disabled={isUpdating}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={cancelEdit}
                              disabled={isUpdating}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <button
                            onClick={() => startEdit(model.id, model.aaSlug, 'aaSlug')}
                            className="cursor-pointer font-mono text-sm hover:underline"
                            disabled={isUpdating}
                          >
                            {model.aaSlug || '-'}
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {model.codingIndex ? (
                          <span className="font-mono">{Number(model.codingIndex).toFixed(1)}</span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={model.isActive ? 'default' : 'secondary'}
                          className="cursor-pointer"
                          onClick={() => {
                            if (!isUpdating) {
                              setEditingField({ id: model.id, field: 'isActive' });
                              void saveEdit(
                                model.id,
                                model.isActive,
                                model.isFeatured,
                                model.isStealth
                              );
                            }
                          }}
                        >
                          {isUpdating && editingField?.field === 'isActive'
                            ? 'Updating...'
                            : model.isActive
                              ? 'Active'
                              : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={model.isFeatured ?? false}
                            disabled={isUpdating}
                            onCheckedChange={() => {
                              if (!isUpdating) {
                                setEditingField({ id: model.id, field: 'isFeatured' });
                                void saveEdit(
                                  model.id,
                                  model.isActive,
                                  model.isFeatured,
                                  model.isStealth
                                );
                              }
                            }}
                          />
                          <Label
                            className="cursor-pointer text-sm"
                            onClick={() => {
                              if (!isUpdating) {
                                setEditingField({ id: model.id, field: 'isFeatured' });
                                void saveEdit(
                                  model.id,
                                  model.isActive,
                                  model.isFeatured,
                                  model.isStealth
                                );
                              }
                            }}
                          >
                            {isUpdating && editingField?.field === 'isFeatured'
                              ? 'Updating...'
                              : 'Featured'}
                          </Label>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={model.isStealth ?? false}
                            disabled={isUpdating}
                            onCheckedChange={() => {
                              if (!isUpdating) {
                                setEditingField({ id: model.id, field: 'isStealth' });
                                void saveEdit(
                                  model.id,
                                  model.isActive,
                                  model.isFeatured,
                                  model.isStealth
                                );
                              }
                            }}
                          />
                          <Label
                            className="cursor-pointer text-sm"
                            onClick={() => {
                              if (!isUpdating) {
                                setEditingField({ id: model.id, field: 'isStealth' });
                                void saveEdit(
                                  model.id,
                                  model.isActive,
                                  model.isFeatured,
                                  model.isStealth
                                );
                              }
                            }}
                          >
                            {isUpdating && editingField?.field === 'isStealth'
                              ? 'Updating...'
                              : 'Stealth'}
                          </Label>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(model.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatRelativeTime(model.updatedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {data && data.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground text-sm">
              Page {data.pagination.page} of {data.pagination.totalPages} ({data.pagination.total}{' '}
              total)
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === data.pagination.totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminPage>
  );
}
