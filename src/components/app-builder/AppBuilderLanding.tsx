/**
 * App Builder Landing
 *
 * Landing page component for starting new projects.
 * Features a large prompt input and model selector.
 * Uses local React state - no persistence needed across navigations.
 *
 * Routes calls to personal or organization router based on organizationId:
 * - organizationId undefined: trpc.appBuilder.*
 * - organizationId provided: trpc.organizations.appBuilder.*
 */

'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Sparkles,
  Clock,
  FolderOpen,
  Search,
  ChevronRight,
  Trash2,
  Users,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { useOrganizationWithMembers, useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';
import { PromptInput } from '@/components/app-builder/PromptInput';
import { TemplateGallery } from '@/components/app-builder/TemplateGallery';
import type { Images } from '@/lib/images-schema';
import {
  type AppBuilderGalleryTemplate,
  APP_BUILDER_TEMPLATE_ASK_PROMPT,
  APP_BUILDER_GALLERY_TEMPLATE_METADATA,
} from '@/lib/app-builder/constants';

/** Maximum number of projects to show on the landing page before "View All" */
const MAX_RECENT_PROJECTS = 4;

/**
 * Sanitizes a project title for display in delete dialogs by:
 * - Removing line breaks
 * - Truncating to 100 characters (avoids cutting words when possible)
 */
function sanitizeProjectTitle(title: string): string {
  // Replace line breaks with spaces
  const noLineBreaks = title.replace(/[\r\n]+/g, ' ');
  // Truncate to 100 chars, avoiding cutting words midway
  if (noLineBreaks.length > 100) {
    // Find the last space before or at position 100
    const truncated = noLineBreaks.substring(0, 100);
    const lastSpace = truncated.lastIndexOf(' ');
    // If there's a space, cut there; otherwise cut at 100
    return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
  }
  return noLineBreaks;
}

type AppBuilderLandingProps = {
  organizationId?: string;
  onProjectCreated: (projectId: string, prompt: string) => void;
};

/**
 * Project card component for displaying existing projects with delete functionality
 */
function ProjectCard({
  project,
  href,
  onDelete,
  isDeleting,
}: {
  project: { id: string; title: string; last_message_at: string | null };
  href: string;
  onDelete: () => Promise<void>;
  isDeleting: boolean;
}) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const timeAgo = project.last_message_at
    ? formatDistanceToNow(new Date(project.last_message_at), { addSuffix: true })
    : 'No activity yet';

  const handleConfirmDelete = async () => {
    await onDelete();
    setShowDeleteDialog(false);
  };

  return (
    <>
      <Card className="group hover:bg-accent relative transition-colors">
        <Link href={href} className="absolute inset-0 z-0" aria-label={project.title} />
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <CardTitle className="min-w-0 flex-1 truncate text-base font-medium">
              {project.title}
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10 h-7 w-7 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={e => {
                e.stopPropagation();
                setShowDeleteDialog(true);
              }}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span className="sr-only">Delete project</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="text-muted-foreground flex items-center gap-1 text-xs">
            <Clock className="h-3 w-3" />
            <span>{timeAgo}</span>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{sanitizeProjectTitle(project.title)}"? This will
              permanently delete the project and its git repository. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Project = { id: string; title: string; last_message_at: string | null };

/**
 * Project item in the AllProjectsSheet with delete functionality
 */
function SheetProjectItem({
  project,
  href,
  onDelete,
  isDeleting,
}: {
  project: Project;
  href: string;
  onDelete: () => Promise<void>;
  isDeleting: boolean;
}) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const timeAgo = project.last_message_at
    ? formatDistanceToNow(new Date(project.last_message_at), { addSuffix: true })
    : 'No activity yet';

  const handleConfirmDelete = async () => {
    await onDelete();
    setShowDeleteDialog(false);
  };

  return (
    <>
      <div className="group hover:bg-accent flex items-center gap-2 rounded-lg border p-3 transition-colors">
        <Link href={href} className="min-w-0 flex-1">
          <div className="truncate font-medium">{project.title}</div>
          <div className="text-muted-foreground flex items-center gap-1 text-xs">
            <Clock className="h-3 w-3" />
            <span>{timeAgo}</span>
          </div>
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => setShowDeleteDialog(true)}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          <span className="sr-only">Delete project</span>
        </Button>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{sanitizeProjectTitle(project.title)}"? This will
              permanently delete the project and its git repository. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ProjectViewMode = 'user' | 'all';

/**
 * All Projects Sheet - shows all projects with search and optional toggle for org context
 */
function AllProjectsSheet({
  userProjects,
  allProjects,
  organizationId,
  children,
}: {
  userProjects: Project[];
  allProjects: Project[];
  organizationId?: string;
  children: React.ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ProjectViewMode>('user');
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const basePath = organizationId ? `/organizations/${organizationId}/app-builder` : '/app-builder';
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // For non-org context, user projects and all projects are the same
  const isOrgContext = !!organizationId;
  const projects = isOrgContext ? (viewMode === 'user' ? userProjects : allProjects) : allProjects;

  // Delete mutations for personal and organization contexts
  const personalDeleteMutation = useMutation(trpc.appBuilder.deleteProject.mutationOptions());
  const orgDeleteMutation = useMutation(
    trpc.organizations.appBuilder.deleteProject.mutationOptions()
  );

  const handleDelete = async (projectId: string) => {
    setDeletingProjectId(projectId);
    try {
      if (organizationId) {
        await orgDeleteMutation.mutateAsync({ projectId, organizationId });
        // Invalidate org projects queries
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.appBuilder.listProjects.queryKey({ organizationId }),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.appBuilder.listUserProjects.queryKey({ organizationId }),
        });
      } else {
        await personalDeleteMutation.mutateAsync({ projectId });
        // Invalidate personal projects query
        await queryClient.invalidateQueries({
          queryKey: trpc.appBuilder.listProjects.queryKey(),
        });
      }
    } finally {
      setDeletingProjectId(null);
    }
  };

  const filteredProjects = useMemo(() => {
    if (!search.trim()) return projects;
    const lowerSearch = search.toLowerCase();
    return projects.filter(p => p.title.toLowerCase().includes(lowerSearch));
  }, [projects, search]);

  const projectCount = viewMode === 'user' ? userProjects.length : allProjects.length;

  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {isOrgContext && viewMode === 'all' ? 'All Org Projects' : 'Your Projects'}
          </SheetTitle>
          <SheetDescription>
            {projectCount} project{projectCount !== 1 ? 's' : ''} total
          </SheetDescription>
        </SheetHeader>

        {/* View Mode Toggle - only show for org context */}
        {isOrgContext && (
          <div className="mt-4 px-4">
            <Tabs value={viewMode} onValueChange={v => setViewMode(v as ProjectViewMode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="user" className="flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  Your Projects
                </TabsTrigger>
                <TabsTrigger value="all" className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  All Org Projects
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        {/* Search Input */}
        <div className="relative mt-4 px-4">
          <Search className="text-muted-foreground absolute top-1/2 left-7 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search projects..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Projects List */}
        <div className="max-h-[calc(100vh-280px)] overflow-y-auto px-4 pt-4 pb-4">
          {filteredProjects.length === 0 ? (
            <div className="py-8 text-center">
              <FolderOpen className="text-muted-foreground mx-auto mb-2 h-8 w-8" />
              <p className="text-muted-foreground text-sm">
                {search ? 'No projects match your search' : 'No projects yet'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredProjects.map(project => (
                <SheetProjectItem
                  key={project.id}
                  project={project}
                  href={`${basePath}/${project.id}`}
                  onDelete={() => handleDelete(project.id)}
                  isDeleting={deletingProjectId === project.id}
                />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Projects list section component - shows recent projects with "View All" option
 * For org context: shows user's projects on landing, with option to see all org projects in sheet
 */
function ProjectsSection({
  userProjects,
  allProjects,
  isLoading,
  organizationId,
}: {
  userProjects: Project[] | undefined;
  allProjects: Project[] | undefined;
  isLoading: boolean;
  organizationId?: string;
}) {
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const basePath = organizationId ? `/organizations/${organizationId}/app-builder` : '/app-builder';
  // For landing page, always show user's projects (or all projects for personal context)
  const displayProjects = userProjects;
  const recentProjects = displayProjects?.slice(0, MAX_RECENT_PROJECTS);
  const hasMoreProjects = displayProjects && displayProjects.length > MAX_RECENT_PROJECTS;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Delete mutations for personal and organization contexts
  const personalDeleteMutation = useMutation(trpc.appBuilder.deleteProject.mutationOptions());
  const orgDeleteMutation = useMutation(
    trpc.organizations.appBuilder.deleteProject.mutationOptions()
  );

  const handleDelete = async (projectId: string) => {
    setDeletingProjectId(projectId);
    try {
      if (organizationId) {
        await orgDeleteMutation.mutateAsync({ projectId, organizationId });
        // Invalidate org projects queries
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.appBuilder.listProjects.queryKey({ organizationId }),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.appBuilder.listUserProjects.queryKey({ organizationId }),
        });
      } else {
        await personalDeleteMutation.mutateAsync({ projectId });
        // Invalidate personal projects query
        await queryClient.invalidateQueries({
          queryKey: trpc.appBuilder.listProjects.queryKey(),
        });
      }
    } finally {
      setDeletingProjectId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="mt-10">
        <h3 className="text-muted-foreground mb-4 text-center text-sm font-medium">
          Your Projects
        </h3>
        <Card>
          <CardContent className="py-8">
            <div className="text-center">
              <div className="text-muted-foreground animate-pulse text-sm">Loading projects...</div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!displayProjects || displayProjects.length === 0) {
    return (
      <div className="mt-10">
        <h3 className="text-muted-foreground mb-4 text-center text-sm font-medium">
          Your Projects
        </h3>
        <Card>
          <CardContent className="py-8">
            <div className="text-center">
              <FolderOpen className="text-muted-foreground mx-auto mb-2 h-8 w-8" />
              <p className="text-muted-foreground text-sm">No projects yet</p>
              <p className="text-muted-foreground mt-1 text-xs">Create your first one above!</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-muted-foreground text-sm font-medium">
          Your Projects
          {displayProjects.length > 0 && (
            <span className="text-muted-foreground/70 ml-1.5">({displayProjects.length})</span>
          )}
        </h3>
        {hasMoreProjects && (
          <AllProjectsSheet
            userProjects={userProjects || []}
            allProjects={allProjects || []}
            organizationId={organizationId}
          >
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-auto p-0 text-xs"
            >
              View all
              <ChevronRight className="ml-1 h-3 w-3" />
            </Button>
          </AllProjectsSheet>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {recentProjects?.map(project => (
          <ProjectCard
            key={project.id}
            project={project}
            href={`${basePath}/${project.id}`}
            onDelete={() => handleDelete(project.id)}
            isDeleting={deletingProjectId === project.id}
          />
        ))}
      </div>
      {hasMoreProjects && (
        <div className="mt-4 text-center">
          <AllProjectsSheet
            userProjects={userProjects || []}
            allProjects={allProjects || []}
            organizationId={organizationId}
          >
            <Button variant="outline" size="sm">
              View all {displayProjects.length} projects
            </Button>
          </AllProjectsSheet>
        </div>
      )}
    </div>
  );
}

/**
 * Main landing component
 */
export function AppBuilderLanding({ organizationId, onProjectCreated }: AppBuilderLandingProps) {
  const [model, setModel] = useState('');
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasImages, setHasImages] = useState(false);
  const [isCreatingFromTemplate, setIsCreatingFromTemplate] = useState(false);
  // Generate a stable messageUuid for image uploads - this identifies this initial prompt message
  const [messageUuid] = useState(() => crypto.randomUUID());
  const trpc = useTRPC();

  // Fetch eligibility to check if user can use App Builder
  const personalEligibilityQuery = useQuery({
    ...trpc.appBuilder.checkEligibility.queryOptions(),
    enabled: !organizationId,
  });
  const orgEligibilityQuery = useQuery({
    ...trpc.organizations.appBuilder.checkEligibility.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });
  const eligibilityData = organizationId ? orgEligibilityQuery.data : personalEligibilityQuery.data;
  const isEligibilityLoading = organizationId
    ? orgEligibilityQuery.isPending
    : personalEligibilityQuery.isPending;
  // Access levels: 'full' = all models, 'limited' = free models only, 'blocked' = cannot use
  // Cast to include 'blocked' so UI can handle it even though server currently returns only 'full' or 'limited'
  const accessLevel = (eligibilityData?.accessLevel ?? 'full') as 'full' | 'limited' | 'blocked';
  const hasLimitedAccess = !isEligibilityLoading && accessLevel === 'limited';
  const isBlocked = !isEligibilityLoading && accessLevel === 'blocked';

  // Create project mutations - use the appropriate one based on context
  // Destructure mutateAsync for stable callback dependencies
  const { mutateAsync: personalCreateProject } = useMutation(
    trpc.appBuilder.createProject.mutationOptions()
  );
  const { mutateAsync: orgCreateProject } = useMutation(
    trpc.organizations.appBuilder.createProject.mutationOptions()
  );

  // Fetch existing projects - use the appropriate query based on context
  const personalProjectsQuery = useQuery({
    ...trpc.appBuilder.listProjects.queryOptions(),
    enabled: !organizationId,
  });
  // For org context, fetch both all org projects and user's projects
  const orgAllProjectsQuery = useQuery({
    ...trpc.organizations.appBuilder.listProjects.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });
  const orgUserProjectsQuery = useQuery({
    ...trpc.organizations.appBuilder.listUserProjects.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });

  // Select the right data based on context
  // For personal context: userProjects and allProjects are the same
  // For org context: userProjects = user's projects, allProjects = all org projects
  const userProjects = organizationId ? orgUserProjectsQuery.data : personalProjectsQuery.data;
  const allProjects = organizationId ? orgAllProjectsQuery.data : personalProjectsQuery.data;
  const projectsLoading = organizationId
    ? orgUserProjectsQuery.isLoading || orgAllProjectsQuery.isLoading
    : personalProjectsQuery.isLoading;

  // Fetch organization configuration and models
  const { data: organizationData } = useOrganizationWithMembers(organizationId || '', {
    enabled: !!organizationId,
  });
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  // Get organization's allowed models
  const savedModelAllowList = organizationData?.settings?.model_allow_list || [];
  const allModels = modelsData?.data || [];

  // Filter models based on organization's allow list (memoized to avoid prompt re-render churn)
  // When user has limited access, only show free models
  const availableModels = useMemo(() => {
    let models =
      savedModelAllowList.length === 0
        ? allModels
        : allModels.filter(m => savedModelAllowList.includes(m.id));

    // If user has limited access, filter to only free models
    if (hasLimitedAccess) {
      models = models.filter(m => {
        const promptPrice = parseFloat(m.pricing.prompt);
        const completionPrice = parseFloat(m.pricing.completion);
        return promptPrice === 0 && completionPrice === 0;
      });
    }

    return models;
  }, [allModels, savedModelAllowList, hasLimitedAccess]);

  // Check if the selected model supports images (vision)
  const selectedModelData = useMemo(
    () => availableModels.find(m => m.id === model),
    [availableModels, model]
  );

  const modelSupportsImages = useMemo(() => {
    if (!selectedModelData) return false;
    const inputModalities = selectedModelData.architecture?.input_modalities || [];
    return inputModalities.includes('image') || inputModalities.includes('image_url');
  }, [selectedModelData]);

  // Warning state: user uploaded images but model doesn't support them
  const hasImageWarning = hasImages && !modelSupportsImages;

  // Format models for the combobox (ModelOption format: id, name, supportsVision)
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      availableModels.map(m => {
        const inputModalities = m.architecture?.input_modalities || [];
        const supportsVision =
          inputModalities.includes('image') || inputModalities.includes('image_url');
        return { id: m.id, name: m.name, supportsVision };
      }),
    [availableModels]
  );

  // Set or reset model when defaults change (organization switch or initial load)
  useEffect(() => {
    // If no models are available, clear the selection to prevent invalid submissions
    if (modelOptions.length === 0) {
      if (model) {
        setModel('');
        setIsModelUserSelected(false);
      }
      return;
    }

    // If current model is not in the available models list, or if we don't have a model yet,
    // reset to an allowed model
    const isCurrentModelAvailable = modelOptions.some(m => m.id === model);
    if (!isCurrentModelAvailable || !model || !isModelUserSelected) {
      // Prefer the default model if it's in the allow list, otherwise use the first available
      const defaultModel = defaultsData?.defaultModel;
      const isDefaultAllowed = defaultModel && modelOptions.some(m => m.id === defaultModel);
      const newModel = isDefaultAllowed ? defaultModel : modelOptions[0]?.id;

      if (newModel && newModel !== model) {
        setModel(newModel);
        setIsModelUserSelected(false); // Auto-selected, not user-selected
      }
    }
  }, [defaultsData?.defaultModel, modelOptions, model, isModelUserSelected, setModel]);

  const handleSubmit = useCallback(
    async (value: string, images?: Images) => {
      // Users can proceed even with limited access (they'll use free models)
      // But blocked users cannot proceed
      // Also prevent submission if images are provided but model doesn't support them
      if (!value || isSubmitting || !model || isBlocked || (images && !modelSupportsImages)) return;

      setIsSubmitting(true);
      try {
        // Create project with model and images (saves prompt and model to DB)
        // Use the appropriate mutation based on context
        // PromptInput flow creates blank projects (no template)
        const result = organizationId
          ? await orgCreateProject({
              prompt: value,
              model,
              organizationId,
              images,
            })
          : await personalCreateProject({
              prompt: value,
              model,
              images,
            });

        // Notify parent with project details - parent will swap to chat view
        // Model is stored in DB, no need to pass it
        onProjectCreated(result.projectId, value);
      } catch (error) {
        setIsSubmitting(false);
        throw error; // Re-throw so PromptInput doesn't clear images
      }
    },
    [
      isSubmitting,
      model,
      isBlocked,
      modelSupportsImages,
      organizationId,
      orgCreateProject,
      personalCreateProject,
      onProjectCreated,
    ]
  );

  const handleTemplateSelect = useCallback(
    async (templateId: AppBuilderGalleryTemplate) => {
      if (isCreatingFromTemplate || !model || isBlocked) return;

      setIsCreatingFromTemplate(true);
      try {
        const templateName = APP_BUILDER_GALLERY_TEMPLATE_METADATA[templateId].name;
        const prompt = APP_BUILDER_TEMPLATE_ASK_PROMPT;

        const result = organizationId
          ? await orgCreateProject({
              prompt,
              model,
              organizationId,
              template: templateId,
              title: templateName,
              mode: 'ask',
            })
          : await personalCreateProject({
              prompt,
              model,
              template: templateId,
              title: templateName,
              mode: 'ask',
            });

        onProjectCreated(result.projectId, prompt);
      } catch (error) {
        setIsCreatingFromTemplate(false);
        throw error;
      }
    },
    [
      isCreatingFromTemplate,
      model,
      isBlocked,
      organizationId,
      orgCreateProject,
      personalCreateProject,
      onProjectCreated,
    ]
  );

  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
    setIsModelUserSelected(true);
  }, []);

  const handleImagesChange = useCallback((hasUploadedImages: boolean) => {
    setHasImages(hasUploadedImages);
  }, []);

  return (
    <div className="flex h-dvh w-full flex-col items-center overflow-y-auto p-4 md:p-8">
      <div className="my-auto w-full max-w-3xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="bg-primary/10 mx-auto mb-4 w-fit rounded-full p-4">
            <Sparkles className="text-primary h-8 w-8" />
          </div>
          <div className="flex items-center justify-center gap-3">
            <h1 className="text-2xl font-bold md:text-3xl">App Builder</h1>
            <Badge variant="new">new</Badge>
          </div>
          <p className="text-muted-foreground mt-2 text-sm md:text-base">
            Describe the app you want to build, and we'll create it for you
          </p>
        </div>

        {/* Blocked Banner - show when user cannot use App Builder at all */}
        {isBlocked && eligibilityData && (
          <div className="mb-6">
            <InsufficientBalanceBanner
              balance={eligibilityData.balance}
              organizationId={organizationId}
              content={{ type: 'productName', productName: 'App Builder' }}
            />
          </div>
        )}

        {/* Limited Access Banner - show when user has insufficient balance but can still use free models */}
        {hasLimitedAccess && eligibilityData && (
          <div className="mb-6">
            <InsufficientBalanceBanner
              balance={eligibilityData.balance}
              organizationId={organizationId}
              colorScheme="info"
              content={{
                type: 'custom',
                title: 'Free Models Available',
                description:
                  'You can use free models to build your app. Add credits to unlock all models and advanced features.',
                compactActionText: 'Add credits to unlock all models',
              }}
            />
          </div>
        )}

        {/* Main Input */}
        <PromptInput
          variant="landing"
          onSubmit={handleSubmit}
          messageUuid={messageUuid}
          organizationId={organizationId}
          placeholder="Describe the app you want to build... Be specific about features, design, and functionality."
          disabled={isBlocked || !model}
          isSubmitting={isSubmitting}
          onImagesChange={handleImagesChange}
          models={modelOptions}
          selectedModel={model}
          onModelChange={handleModelChange}
          isLoadingModels={isLoadingModels}
          warningMessage={
            hasImageWarning
              ? 'The selected model does not support images. Please remove the images or select a different model that supports vision.'
              : undefined
          }
        />

        {/* Template Gallery - below main input */}
        <TemplateGallery
          onSelectTemplate={handleTemplateSelect}
          isCreating={isCreatingFromTemplate}
          disabled={isBlocked || !model}
        />

        {/* Projects List */}
        <ProjectsSection
          userProjects={userProjects}
          allProjects={allProjects}
          isLoading={projectsLoading}
          organizationId={organizationId}
        />
      </div>
    </div>
  );
}
