'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { Loader2, AlertCircle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/deployments/StatusBadge';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { DetailField } from './DetailField';
import { AdminBuildLogViewer } from './AdminBuildLogViewer';
import type { AdminDeploymentTableProps } from '@/types/admin-deployments';
import type { BuildStatus } from '@/lib/user-deployments/types';

type DeploymentDetailDialogProps = {
  deployment: AdminDeploymentTableProps | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
};

export function DeploymentDetailDialog({
  deployment,
  open,
  onOpenChange,
  onDelete,
}: DeploymentDetailDialogProps) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Reset state when deployment changes or dialog opens
  useEffect(() => {
    if (open && deployment) {
      setSelectedBuildId(null);
      setShowDeleteConfirm(false);
    }
  }, [open, deployment?.id]);

  // Fetch builds when dialog is open
  const {
    data: buildsData,
    isLoading: buildsLoading,
    error: buildsError,
  } = useQuery(
    trpc.admin.deployments.getBuilds.queryOptions(
      { deploymentId: deployment?.id ?? '' },
      { enabled: open && deployment !== null }
    )
  );

  // Auto-select the latest build when builds load
  useEffect(() => {
    if (buildsData?.builds && buildsData.builds.length > 0 && !selectedBuildId) {
      setSelectedBuildId(buildsData.builds[0].id);
    }
  }, [buildsData?.builds, selectedBuildId]);

  // Delete mutation
  const deleteMutation = useMutation(
    trpc.admin.deployments.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [['admin', 'deployments']] });
        setShowDeleteConfirm(false);
        onOpenChange(false);
        onDelete();
      },
      onError: error => {
        toast.error(`Failed to delete deployment: ${error.message}`);
      },
    })
  );

  const handleDelete = () => {
    if (!deployment) return;
    void deleteMutation.mutateAsync({ id: deployment.id });
  };

  if (!deployment) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deployment: {deployment.deployment_slug}</DialogTitle>
          <DialogDescription>View deployment details and build history</DialogDescription>
        </DialogHeader>

        <DeploymentInfoPanel deployment={deployment} />

        <BuildsSection
          builds={buildsData?.builds}
          isLoading={buildsLoading}
          hasError={Boolean(buildsError)}
          selectedBuildId={selectedBuildId}
          onSelectBuild={setSelectedBuildId}
        />

        {selectedBuildId && (
          <div className="space-y-3">
            <h3 className="font-medium">Build Logs</h3>
            <AdminBuildLogViewer buildId={selectedBuildId} />
          </div>
        )}

        <DeleteFooter
          showConfirm={showDeleteConfirm}
          onShowConfirm={setShowDeleteConfirm}
          onDelete={handleDelete}
          isPending={deleteMutation.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}

function DeploymentInfoPanel({ deployment }: { deployment: AdminDeploymentTableProps }) {
  const ownerId = deployment.owned_by_organization_id || deployment.owned_by_user_id;
  const ownerDisplay = deployment.owner_org_name
    ? `${deployment.owner_org_name} (Org)`
    : deployment.owner_email || 'Unknown';

  return (
    <div className="space-y-4 text-sm">
      {/* Primary Info - Most important at a glance */}
      <InfoSection>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-muted-foreground text-xs tracking-wide uppercase">
              Deployment
            </span>
            <h4 className="font-mono text-lg font-semibold">{deployment.deployment_slug}</h4>
          </div>
          <div className="text-right">
            {deployment.latest_build_status ? (
              <StatusBadge status={deployment.latest_build_status} />
            ) : (
              <span className="text-muted-foreground text-xs">No builds</span>
            )}
          </div>
        </div>
        <DetailField label="URL" value={deployment.deployment_url} copyable fullWidth asLink />
      </InfoSection>

      {/* Source & Repository */}
      <InfoSection title="Source">
        <div className="space-y-3">
          <DetailField
            label="Repository"
            value={deployment.repository_source}
            fullWidth
            monospace
          />
          <div className="flex gap-8">
            <DetailField label="Branch" value={deployment.branch} monospace />
            <DetailField label="Provider" value={deployment.source_type} capitalize />
          </div>
        </div>
      </InfoSection>

      {/* Ownership */}
      <InfoSection title="Ownership">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <DetailField label="Owner" value={deployment.owner_org_name || deployment.owner_email}>
            {ownerDisplay}
          </DetailField>
          <DetailField label="Created by" value={deployment.created_by_user_email} />
        </div>
      </InfoSection>

      {/* Timestamps */}
      <InfoSection title="Timeline">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <DetailField label="Created" value={deployment.created_at}>
            <span title={format(new Date(deployment.created_at), 'PPpp')}>
              {formatDistanceToNow(new Date(deployment.created_at), { addSuffix: true })}
            </span>
          </DetailField>
          <DetailField label="Last deployed" value={deployment.last_deployed_at}>
            {deployment.last_deployed_at ? (
              <span title={format(new Date(deployment.last_deployed_at), 'PPpp')}>
                {formatDistanceToNow(new Date(deployment.last_deployed_at), { addSuffix: true })}
              </span>
            ) : (
              'Never'
            )}
          </DetailField>
        </div>
      </InfoSection>

      {/* Technical IDs - these are useful to copy */}
      <InfoSection title="Technical Details" subdued>
        <div className="grid grid-cols-1 gap-2">
          <DetailField label="Deployment ID" value={deployment.id} copyable monospace smallText />
          <DetailField
            label="Owner ID"
            value={ownerId}
            copyable={Boolean(ownerId)}
            monospace
            smallText
          />
          <DetailField
            label="Creator ID"
            value={deployment.created_by_user_id}
            copyable={Boolean(deployment.created_by_user_id)}
            monospace
            smallText
          />
          {deployment.latest_build_id && (
            <DetailField
              label="Latest Build ID"
              value={deployment.latest_build_id}
              copyable
              monospace
              smallText
            />
          )}
        </div>
      </InfoSection>
    </div>
  );
}

function InfoSection({
  title,
  subdued,
  children,
}: {
  title?: string;
  subdued?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        subdued ? 'border-border/50 bg-muted/20' : 'border-border bg-muted/30'
      )}
    >
      {title && (
        <h4
          className={cn(
            'mb-3 text-xs font-medium tracking-wide uppercase',
            subdued ? 'text-muted-foreground/70' : 'text-muted-foreground'
          )}
        >
          {title}
        </h4>
      )}
      <dl>{children}</dl>
    </div>
  );
}

type Build = {
  id: string;
  status: BuildStatus;
  started_at: string | null;
  completed_at: string | null;
};

type BuildsSectionProps = {
  builds: Build[] | undefined;
  isLoading: boolean;
  hasError: boolean;
  selectedBuildId: string | null;
  onSelectBuild: (id: string) => void;
};

function BuildsSection({
  builds,
  isLoading,
  hasError,
  selectedBuildId,
  onSelectBuild,
}: BuildsSectionProps) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium">Recent Builds (last 5)</h3>

      {isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-4">
          <Loader2 className="size-4 animate-spin" />
          <span>Loading builds...</span>
        </div>
      ) : hasError ? (
        <div className="flex items-center gap-2 py-4 text-red-400">
          <AlertCircle className="size-4" />
          <span>Failed to load builds</span>
        </div>
      ) : builds?.length === 0 ? (
        <p className="text-muted-foreground py-4">No builds found</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Completed</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {builds?.map(build => (
              <BuildRow
                key={build.id}
                build={build}
                isSelected={selectedBuildId === build.id}
                onSelect={() => onSelectBuild(build.id)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

type BuildRowProps = {
  build: Build;
  isSelected: boolean;
  onSelect: () => void;
};

function BuildRow({ build, isSelected, onSelect }: BuildRowProps) {
  return (
    <TableRow className={cn('cursor-pointer', isSelected && 'bg-muted/50')} onClick={onSelect}>
      <TableCell>
        <StatusBadge status={build.status} />
      </TableCell>
      <TableCell>
        {build.started_at
          ? formatDistanceToNow(new Date(build.started_at), { addSuffix: true })
          : '-'}
      </TableCell>
      <TableCell>
        {build.completed_at
          ? formatDistanceToNow(new Date(build.completed_at), { addSuffix: true })
          : '-'}
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="sm"
          onClick={e => {
            e.stopPropagation();
            onSelect();
          }}
          className={cn(isSelected && 'bg-muted')}
        >
          View Logs
        </Button>
      </TableCell>
    </TableRow>
  );
}

type DeleteFooterProps = {
  showConfirm: boolean;
  onShowConfirm: (show: boolean) => void;
  onDelete: () => void;
  isPending: boolean;
};

function DeleteFooter({ showConfirm, onShowConfirm, onDelete, isPending }: DeleteFooterProps) {
  if (showConfirm) {
    return (
      <DialogFooter className="border-border border-t pt-4">
        <div className="flex w-full items-center justify-end gap-2">
          <span className="text-muted-foreground mr-2 text-sm">
            Are you sure you want to delete this deployment?
          </span>
          <Button variant="destructive" size="sm" onClick={onDelete} disabled={isPending}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : 'Confirm Delete'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onShowConfirm(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      </DialogFooter>
    );
  }

  return (
    <DialogFooter className="border-border border-t pt-4">
      <Button variant="destructive" onClick={() => onShowConfirm(true)} disabled={isPending}>
        <Trash2 className="mr-2 size-4" />
        Delete Deployment
      </Button>
    </DialogFooter>
  );
}
