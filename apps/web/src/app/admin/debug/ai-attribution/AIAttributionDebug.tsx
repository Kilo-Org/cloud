'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Loader2, Search, Plus, Minus, CheckCircle, XCircle, Clock, Trash2 } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { OrganizationCombobox } from './OrganizationCombobox';
import { ProjectCombobox, FilePathCombobox, BranchCombobox } from './CodeIndexingCombobox';

export function AIAttributionDebug() {
  const trpc = useTRPC();
  const [organizationId, setOrganizationId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [filePath, setFilePath] = useState('');
  const [branch, setBranch] = useState('');

  const queryClient = useQueryClient();

  const queryOptions = trpc.admin.aiAttribution.getDebugData.queryOptions({
    organization_id: organizationId,
    project_id: projectId,
    file_path: filePath,
    branch: branch || undefined,
  });

  const { data, isLoading, error } = useQuery({
    ...queryOptions,
    enabled: !!organizationId && !!projectId && !!filePath,
  });

  const deleteAttributionMutation = useMutation(
    trpc.admin.aiAttribution.deleteAttribution.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
      },
    })
  );

  const handleDeleteAttribution = (attributionId: number) => {
    if (
      window.confirm(
        `Are you sure you want to delete attribution #${attributionId}? This will also delete all associated lines added/removed records.`
      )
    ) {
      deleteAttributionMutation.mutate({
        organization_id: organizationId,
        project_id: projectId,
        file_path: filePath,
        attribution_id: attributionId,
      });
    }
  };

  const debugData = data?.success ? data.data : null;
  const errorMessage = error?.message ?? (data && !data.success ? data.error : null);

  const handleOrganizationChange = (value: string) => {
    setOrganizationId(value);
    setProjectId('');
    setFilePath('');
    setBranch('');
  };

  const handleProjectChange = (value: string) => {
    setProjectId(value);
    setFilePath('');
    setBranch('');
  };

  const handleFilePathChange = (value: string) => {
    setFilePath(value);
  };

  const handleBranchChange = (value: string) => {
    setBranch(value);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'accepted':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'rejected':
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return <Clock className="h-4 w-4 text-yellow-500" />;
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'accepted':
        return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'rejected':
        return 'bg-red-500/20 text-red-400 border-red-500/30';
      default:
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    }
  };

  return (
    <div className="w-full space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Debug AI Attribution Durable Object
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-muted-foreground text-sm">Organization</label>
                <OrganizationCombobox
                  value={organizationId}
                  onValueChange={handleOrganizationChange}
                />
              </div>
              <div className="space-y-2">
                <label className="text-muted-foreground text-sm">Project ID</label>
                <ProjectCombobox
                  organizationId={organizationId}
                  value={projectId}
                  onValueChange={handleProjectChange}
                  disabled={!organizationId}
                />
              </div>
              <div className="space-y-2">
                <label className="text-muted-foreground text-sm">File Path</label>
                <FilePathCombobox
                  organizationId={organizationId}
                  projectId={projectId}
                  value={filePath}
                  onValueChange={handleFilePathChange}
                  disabled={!organizationId || !projectId}
                />
              </div>
              <div className="space-y-2">
                <label className="text-muted-foreground text-sm">Branch (optional)</label>
                <BranchCombobox
                  organizationId={organizationId}
                  projectId={projectId}
                  value={branch}
                  onValueChange={handleBranchChange}
                  disabled={!organizationId || !projectId}
                />
              </div>
            </div>
            {isLoading && (
              <div className="text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading DO data...</span>
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-400">
              <p className="font-medium">Error</p>
              <p className="text-sm">{errorMessage}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {debugData && (
        <>
          {/* DO Key */}
          <Card>
            <CardContent className="pt-6">
              <div className="bg-muted rounded-lg p-3 font-mono text-sm">
                DO Key: <span className="text-primary font-bold">{debugData.doKey}</span>
              </div>
            </CardContent>
          </Card>

          {/* Summary */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-6 text-center">
                <div className="text-primary text-3xl font-bold">
                  {debugData.summary.total_attributions}
                </div>
                <div className="text-muted-foreground text-sm">Total Attributions</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <div className="text-3xl font-bold text-green-400">
                  {debugData.summary.total_lines_added}
                </div>
                <div className="text-muted-foreground text-sm">Lines Added</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <div className="text-3xl font-bold text-red-400">
                  {debugData.summary.total_lines_removed}
                </div>
                <div className="text-muted-foreground text-sm">Lines Removed</div>
              </CardContent>
            </Card>
          </div>

          {/* By Status and By Branch */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">By Status</CardTitle>
              </CardHeader>
              <CardContent>
                {Object.keys(debugData.summary.by_status).length === 0 ? (
                  <div className="text-muted-foreground text-sm">No data</div>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(debugData.summary.by_status).map(([status, count]) => (
                      <div
                        key={status}
                        className="border-border/50 flex items-center justify-between border-b pb-2 last:border-0"
                      >
                        <span
                          className={`rounded-full border px-3 py-1 text-xs font-medium ${getStatusBadgeClass(status)}`}
                        >
                          {status}
                        </span>
                        <span className="font-mono">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">By Branch</CardTitle>
              </CardHeader>
              <CardContent>
                {Object.keys(debugData.summary.by_branch).length === 0 ? (
                  <div className="text-muted-foreground text-sm">No data</div>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(debugData.summary.by_branch).map(([branchName, count]) => (
                      <div
                        key={branchName}
                        className="border-border/50 flex items-center justify-between border-b pb-2 last:border-0"
                      >
                        <span className="font-mono text-sm">{branchName}</span>
                        <span className="font-mono">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Attributions */}
          <Card>
            <CardHeader>
              <CardTitle>Attributions</CardTitle>
            </CardHeader>
            <CardContent>
              {debugData.attributions.length === 0 ? (
                <div className="text-muted-foreground py-12 text-center">
                  <div className="mb-4 text-4xl">📭</div>
                  <div>No attributions found for this DO</div>
                </div>
              ) : (
                <Accordion type="multiple" className="space-y-4">
                  {debugData.attributions.map(attr => (
                    <AccordionItem
                      key={attr.id}
                      value={`attr-${attr.id}`}
                      className="bg-muted/30 rounded-lg border px-4"
                    >
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex w-full items-center justify-between pr-4">
                          <div className="flex items-center gap-3">
                            {getStatusIcon(attr.status)}
                            <span className="text-primary font-bold">Attribution #{attr.id}</span>
                          </div>
                          <span
                            className={`rounded-full border px-3 py-1 text-xs font-medium ${getStatusBadgeClass(attr.status)}`}
                          >
                            {attr.status}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-4 pt-2">
                          {/* Actions */}
                          <div className="flex justify-end">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleDeleteAttribution(attr.id)}
                              disabled={deleteAttributionMutation.isPending}
                            >
                              {deleteAttributionMutation.isPending &&
                              deleteAttributionMutation.variables?.attribution_id === attr.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="mr-2 h-4 w-4" />
                              )}
                              Delete Attribution
                            </Button>
                          </div>

                          {/* Metadata Grid */}
                          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                            <MetaItem label="User ID" value={attr.user_id} />
                            <MetaItem
                              label="Organization ID"
                              value={attr.organization_id || 'N/A'}
                            />
                            <MetaItem label="Project ID" value={attr.project_id} />
                            <MetaItem label="Branch" value={attr.branch} />
                            <MetaItem label="File Path" value={attr.file_path} />
                            <MetaItem label="Task ID" value={attr.task_id || 'N/A'} />
                            <MetaItem label="Created At" value={attr.created_at} />
                          </div>

                          {/* Lines Added */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-green-400">
                              <Plus className="h-4 w-4" />
                              <span className="font-medium">
                                Lines Added ({attr.lines_added.length})
                              </span>
                            </div>
                            {attr.lines_added.length === 0 ? (
                              <div className="text-muted-foreground pl-6 text-sm">
                                No lines added
                              </div>
                            ) : (
                              <div className="max-h-48 overflow-y-auto rounded-lg border bg-black/20 p-2">
                                {attr.lines_added.map(line => (
                                  <div
                                    key={line.id}
                                    className="border-border/30 flex gap-4 border-b py-1 font-mono text-xs last:border-0"
                                  >
                                    <span className="text-muted-foreground w-12">
                                      L{line.line_number}
                                    </span>
                                    <span className="text-primary break-all">{line.line_hash}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Lines Removed */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-red-400">
                              <Minus className="h-4 w-4" />
                              <span className="font-medium">
                                Lines Removed ({attr.lines_removed.length})
                              </span>
                            </div>
                            {attr.lines_removed.length === 0 ? (
                              <div className="text-muted-foreground pl-6 text-sm">
                                No lines removed
                              </div>
                            ) : (
                              <div className="max-h-48 overflow-y-auto rounded-lg border bg-black/20 p-2">
                                {attr.lines_removed.map(line => (
                                  <div
                                    key={line.id}
                                    className="border-border/30 flex gap-4 border-b py-1 font-mono text-xs last:border-0"
                                  >
                                    <span className="text-muted-foreground w-12">
                                      L{line.line_number}
                                    </span>
                                    <span className="text-primary break-all">{line.line_hash}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/20 p-2">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-mono text-sm break-all">{value}</div>
    </div>
  );
}
