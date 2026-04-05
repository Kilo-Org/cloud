'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatStorageSize } from '@/lib/code-indexing/format-storage-size';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Trash2, GitBranch, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatRelativeTime } from '@/lib/admin-utils';
import { toast } from 'sonner';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';

type UserCodeIndexingViewProps = {
  userId: string;
};

export function UserCodeIndexingView({ userId }: UserCodeIndexingViewProps) {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();

  // Fetch user's code indexing stats
  const { data: projects, isLoading: isLoadingStats } = useQuery({
    ...trpc.codeIndexing.getOrganizationStats.queryOptions({ overrideUser: userId }),
  });

  // Selected project for branch viewing and files
  const [selectedProjectForBranches, setSelectedProjectForBranches] = useState<string | null>(null);
  const [selectedProjectForFiles, setSelectedProjectForFiles] = useState<string | null>(null);
  const [branchSearchQuery, setBranchSearchQuery] = useState('');
  const [filesPage, setFilesPage] = useState(1);
  const filesPageSize = 15;

  const queryClient = useQueryClient();

  const [isDeletingOld, setIsDeletingOld] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deletingBranchKey, setDeletingBranchKey] = useState<string | null>(null);

  const handleDeleteBranch = async (projectId: string, branchName: string) => {
    const branchKey = `${projectId}:${branchName}`;
    setDeletingBranchKey(branchKey);
    try {
      const result = await trpcClient.codeIndexing.delete.mutate({
        organizationId: null,
        projectId,
        gitBranch: branchName,
      });

      if (result.success) {
        toast.success('Branch deleted successfully');
        void queryClient.invalidateQueries(trpc.codeIndexing.admin.pathFilter());
      } else {
        toast.error('Failed to delete branch');
      }
    } catch (_error) {
      toast.error('Failed to delete branch');
    } finally {
      setDeletingBranchKey(null);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    setDeletingProjectId(projectId);
    try {
      const result = await trpcClient.codeIndexing.delete.mutate({
        organizationId: null,
        projectId,
      });

      if (result.success) {
        toast.success('Project deleted successfully');
        void queryClient.invalidateQueries(trpc.codeIndexing.admin.pathFilter());
        // Clear selected project if it was deleted
        if (selectedProjectForBranches === projectId) {
          setSelectedProjectForBranches(null);
        }
      } else {
        toast.error('Failed to delete project');
      }
    } catch (_error) {
      toast.error('Failed to delete project');
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleDeleteOldProjects = async () => {
    if (!projects) return;

    setIsDeletingOld(true);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    let deletedCount = 0;
    let failedCount = 0;

    for (const project of projects) {
      const projectDate = new Date(project.last_modified);
      if (projectDate < sevenDaysAgo) {
        try {
          const result = await trpcClient.codeIndexing.delete.mutate({
            organizationId: null,
            projectId: project.project_id,
          });

          if (result.success) {
            deletedCount++;
          } else {
            failedCount++;
          }
        } catch (_error) {
          failedCount++;
        }
      }
    }

    setIsDeletingOld(false);

    if (deletedCount > 0) {
      toast.success(`Deleted ${deletedCount} old project${deletedCount === 1 ? '' : 's'}`);
      void queryClient.invalidateQueries(trpc.codeIndexing.admin.pathFilter());
    }

    if (failedCount > 0) {
      toast.error(`Failed to delete ${failedCount} project${failedCount === 1 ? '' : 's'}`);
    }

    if (deletedCount === 0 && failedCount === 0) {
      toast.info('No projects older than 7 days found');
    }
  };

  const handleDeleteOldBranches = async () => {
    if (!selectedProjectData || !selectedProjectForBranches) return;

    setIsDeletingOld(true);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    let deletedCount = 0;
    let failedCount = 0;

    for (const branch of selectedProjectData.branches) {
      const branchDate = new Date(branch.last_modified);
      if (branchDate < sevenDaysAgo) {
        try {
          const result = await trpcClient.codeIndexing.delete.mutate({
            organizationId: null,
            projectId: selectedProjectForBranches,
            gitBranch: branch.branch_name,
          });

          if (result.success) {
            deletedCount++;
          } else {
            failedCount++;
          }
        } catch (_error) {
          failedCount++;
        }
      }
    }

    setIsDeletingOld(false);

    if (deletedCount > 0) {
      toast.success(`Deleted ${deletedCount} old branch${deletedCount === 1 ? '' : 'es'}`);
      void queryClient.invalidateQueries(trpc.codeIndexing.admin.pathFilter());
    }

    if (failedCount > 0) {
      toast.error(`Failed to delete ${failedCount} branch${failedCount === 1 ? '' : 'es'}`);
    }

    if (deletedCount === 0 && failedCount === 0) {
      toast.info('No branches older than 7 days found');
    }
  };

  // Sort projects by storage size
  const sortedProjects = useMemo(() => {
    if (!projects) return [];
    const sorted = [...projects];
    sorted.sort((a, b) => b.size_kb - a.size_kb);
    return sorted;
  }, [projects]);

  // Filter branches based on search query
  const selectedProjectData = projects?.find(p => p.project_id === selectedProjectForBranches);
  const filteredBranches = useMemo(() => {
    if (!selectedProjectData) return [];

    const branches = selectedProjectData.branches;
    if (!branchSearchQuery.trim()) return branches;

    const query = branchSearchQuery.toLowerCase();
    return branches.filter(branch => branch.branch_name.toLowerCase().includes(query));
  }, [selectedProjectData, branchSearchQuery]);

  // Fetch project files when a project is selected
  const { data: projectFiles, isLoading: isLoadingFiles } = useQuery({
    ...trpc.codeIndexing.getProjectFiles.queryOptions({
      organizationId: null,
      projectId: selectedProjectForFiles || '',
      page: filesPage,
      pageSize: filesPageSize,
    }),
    enabled: !!selectedProjectForFiles,
  });

  return (
    <div className="flex flex-col gap-y-6">
      {/* Projects and Branches Section */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Projects List */}
        <div className="flex flex-col">
          <h3 className="mb-4 text-lg font-semibold">Projects</h3>
          <Card className="flex flex-col">
            <CardHeader className="border-b px-4 py-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="font-mono text-sm">Indexed Projects</span>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary-outline">{sortedProjects.length}</Badge>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleDeleteOldProjects}
                        disabled={isDeletingOld}
                        className="hover:bg-destructive/10 h-6 w-6 p-0"
                      >
                        <Trash2 className="text-destructive h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Delete all projects not updated in the past 7 days
                    </TooltipContent>
                  </Tooltip>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent
              className="flex-1 overflow-y-auto p-0"
              style={{ maxHeight: 'calc(500px - 73px)' }}
            >
              <div className="divide-y">
                {isLoadingStats ? (
                  Array.from({ length: 3 }).map((_, idx) => (
                    <div key={idx} className="p-4">
                      <Skeleton className="mb-2 h-5 w-[200px]" />
                      <Skeleton className="h-4 w-[150px]" />
                    </div>
                  ))
                ) : sortedProjects.length === 0 ? (
                  <div className="text-muted-foreground p-8 text-center">No projects found</div>
                ) : (
                  sortedProjects.map(project => {
                    const isDeleting = deletingProjectId === project.project_id;
                    return (
                      <div
                        key={project.project_id}
                        className={`hover:bg-muted/50 flex items-center transition-colors ${
                          selectedProjectForBranches === project.project_id ? 'bg-muted/50' : ''
                        } ${isDeleting ? 'opacity-50' : ''}`}
                      >
                        <button
                          onClick={() => {
                            setSelectedProjectForBranches(project.project_id);
                            setSelectedProjectForFiles(project.project_id);
                            setBranchSearchQuery('');
                            setFilesPage(1);
                          }}
                          className="w-full p-4 text-left"
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <span className="font-mono text-sm font-semibold">
                              {project.project_id}
                            </span>
                            <Badge variant="secondary-outline">
                              <GitBranch className="h-3 w-3" />
                              {project.branches.length}
                            </Badge>
                          </div>
                          <div className="text-muted-foreground flex items-center justify-between gap-x-4 text-xs">
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                              <span title={`${project.chunk_count.toLocaleString()} chunks`}>
                                {project.file_count.toLocaleString()} files
                              </span>
                              <span>{formatStorageSize(project.size_kb)}</span>
                              <span>{project.percentage_of_org}% of storage</span>
                              <span title={project.last_modified}>
                                {formatRelativeTime(project.last_modified)}
                              </span>
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={e => {
                                    e.stopPropagation();
                                    void handleDeleteProject(project.project_id);
                                  }}
                                  disabled={isDeleting}
                                  className="hover:bg-destructive/10 h-6 w-6 shrink-0 p-0"
                                >
                                  <Trash2 className="text-destructive h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete project</TooltipContent>
                            </Tooltip>
                          </div>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
          {sortedProjects.length > 0 && (
            <div className="text-muted-foreground mt-4 text-sm">
              Total: {sortedProjects.length} {sortedProjects.length === 1 ? 'project' : 'projects'}{' '}
              • {formatStorageSize(sortedProjects.reduce((sum, p) => sum + p.size_kb, 0))}
            </div>
          )}
        </div>

        {/* Branches Panel */}
        <div className="flex flex-col">
          <h3 className="mb-4 text-lg font-semibold">Branches</h3>
          <Card className="flex flex-col">
            {!selectedProjectForBranches ? (
              <CardContent className="text-muted-foreground p-8 text-center">
                Select a project to view its branches
              </CardContent>
            ) : (
              <>
                <CardHeader className="border-b px-4 py-3">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span className="font-mono text-sm">{selectedProjectForBranches}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary-outline">
                        {filteredBranches.length}{' '}
                        {branchSearchQuery && `of ${selectedProjectData?.branches.length || 0}`}
                      </Badge>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleDeleteOldBranches}
                            disabled={isDeletingOld}
                            className="hover:bg-destructive/10 h-6 w-6 p-0"
                          >
                            <Trash2 className="text-destructive h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Delete all branches not updated in the past 7 days
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </CardTitle>
                  {selectedProjectData && selectedProjectData.branches.length > 5 && (
                    <div className="relative pt-2">
                      <Filter className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                      <Input
                        placeholder="Filter branches..."
                        value={branchSearchQuery}
                        onChange={e => setBranchSearchQuery(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                  )}
                </CardHeader>
                <CardContent className="overflow-y-auto p-0" style={{ maxHeight: '427px' }}>
                  <div className="divide-y">
                    {filteredBranches.length === 0 ? (
                      <div className="text-muted-foreground p-8 text-center">
                        {branchSearchQuery ? 'No branches match your search' : 'No branches found'}
                      </div>
                    ) : (
                      filteredBranches
                        .sort(
                          (a, b) =>
                            new Date(b.last_modified).getTime() -
                            new Date(a.last_modified).getTime()
                        )
                        .map(branch => {
                          const branchKey = `${selectedProjectForBranches}:${branch.branch_name}`;
                          const isDeleting = deletingBranchKey === branchKey;
                          return (
                            <div
                              key={branch.branch_name}
                              className={`hover:bg-muted/50 flex items-center transition-colors ${
                                isDeleting ? 'opacity-50' : ''
                              }`}
                            >
                              <div className="w-full p-4">
                                <div className="mb-2 flex items-center justify-between">
                                  <span className="font-mono text-sm font-semibold">
                                    {branch.branch_name}
                                  </span>
                                </div>
                                <div className="text-muted-foreground flex items-center justify-between gap-x-4 text-xs">
                                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                                    <span title={`${branch.chunk_count.toLocaleString()} chunks`}>
                                      {branch.file_count.toLocaleString()} files
                                    </span>
                                    <span>{formatStorageSize(branch.size_kb)}</span>
                                    <span title={branch.last_modified}>
                                      {formatRelativeTime(branch.last_modified)}
                                    </span>
                                  </div>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          void handleDeleteBranch(
                                            selectedProjectForBranches,
                                            branch.branch_name
                                          )
                                        }
                                        disabled={isDeleting}
                                        className="hover:bg-destructive/10 h-6 w-6 shrink-0 p-0"
                                      >
                                        <Trash2 className="text-destructive h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Delete branch</TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>
                </CardContent>
              </>
            )}
          </Card>
        </div>
      </div>

      {/* Project Files Section */}
      {selectedProjectForFiles && (
        <div>
          <h3 className="mb-4 text-lg font-semibold">Files in {selectedProjectForFiles}</h3>
          <Card>
            <CardContent className="p-0">
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File Path</TableHead>
                      <TableHead className="text-right">Chunks</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoadingFiles ? (
                      Array.from({ length: filesPageSize }).map((_, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <Skeleton className="h-4 w-[400px]" />
                          </TableCell>
                          <TableCell className="text-right">
                            <Skeleton className="ml-auto h-4 w-[60px]" />
                          </TableCell>
                          <TableCell className="text-right">
                            <Skeleton className="ml-auto h-4 w-[80px]" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : !projectFiles || projectFiles.files.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-muted-foreground h-24 text-center">
                          No files found
                        </TableCell>
                      </TableRow>
                    ) : (
                      projectFiles.files.map((file, idx) => (
                        <TableRow key={`${file.file_path}-${idx}`}>
                          <TableCell className="font-mono text-sm">{file.file_path}</TableCell>
                          <TableCell className="text-right">
                            {file.chunk_count.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatStorageSize(file.size_kb)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {projectFiles && projectFiles.totalPages > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <div className="text-muted-foreground text-sm">
                    Showing {(projectFiles.page - 1) * projectFiles.pageSize + 1} to{' '}
                    {Math.min(projectFiles.page * projectFiles.pageSize, projectFiles.total)} of{' '}
                    {projectFiles.total} files
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFilesPage(p => Math.max(1, p - 1))}
                      disabled={projectFiles.page === 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <div className="text-sm">
                      Page {projectFiles.page} of {projectFiles.totalPages}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFilesPage(p => Math.min(projectFiles.totalPages, p + 1))}
                      disabled={projectFiles.page === projectFiles.totalPages}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
