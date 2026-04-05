'use client';

import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTRPC } from '@/lib/trpc/utils';

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  const mb = bytes / (1024 * 1024);
  const gb = bytes / (1024 * 1024 * 1024);

  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`;
  } else if (mb >= 1) {
    return `${mb.toFixed(2)} MB`;
  } else {
    return `${kb.toFixed(2)} KB`;
  }
}

export function ClusterStatusCard() {
  const trpc = useTRPC();
  const { data: clusterStatus, isLoading: isLoadingCluster } = useQuery(
    trpc.codeIndexing.admin.getClusterStatus.queryOptions()
  );

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <h3 className="text-xl font-semibold">Cluster Status</h3>
        <p className="text-muted-foreground text-sm">
          Overview of Qdrant cluster and PostgreSQL storage
        </p>
      </div>

      <div className="rounded-lg border">
        {isLoadingCluster ? (
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4 lg:grid-cols-6">
            {Array.from({ length: 12 }).map((_, idx) => (
              <div key={idx} className="flex flex-col gap-y-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : clusterStatus ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm md:grid-cols-4 lg:grid-cols-6">
            {/* System Info */}
            <div>
              <div className="text-muted-foreground text-xs">OS</div>
              <div className="font-medium">
                {clusterStatus.distribution} {clusterStatus.distributionVersion}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">CPU</div>
              <div className="font-medium">{clusterStatus.cpuCores} cores</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Disk</div>
              <div className="font-medium">{formatBytes(clusterStatus.totalDiskBytes)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Uptime</div>
              <div className="font-medium">{clusterStatus.uptime}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Version</div>
              <div className="font-medium">v{clusterStatus.qdrantVersion}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Role</div>
              <div className="font-medium">{clusterStatus.clusterRole}</div>
            </div>

            {/* Memory */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help">
                    <div className="text-muted-foreground text-xs">Memory Used</div>
                    <div className="font-medium">
                      {formatBytes(
                        clusterStatus.memoryActiveBytes +
                          clusterStatus.memoryAllocatedBytes +
                          clusterStatus.memoryMetadataBytes +
                          clusterStatus.memoryResidentBytes
                      )}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {(
                        ((clusterStatus.memoryActiveBytes +
                          clusterStatus.memoryAllocatedBytes +
                          clusterStatus.memoryMetadataBytes +
                          clusterStatus.memoryResidentBytes) /
                          clusterStatus.totalRamBytes) *
                        100
                      ).toFixed(1)}
                      %
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1 text-xs">
                    <div>
                      <span className="font-semibold">Active:</span>{' '}
                      {formatBytes(clusterStatus.memoryActiveBytes)}
                    </div>
                    <div>
                      <span className="font-semibold">Allocated:</span>{' '}
                      {formatBytes(clusterStatus.memoryAllocatedBytes)}
                    </div>
                    <div>
                      <span className="font-semibold">Metadata:</span>{' '}
                      {formatBytes(clusterStatus.memoryMetadataBytes)}
                    </div>
                    <div>
                      <span className="font-semibold">Resident:</span>{' '}
                      {formatBytes(clusterStatus.memoryResidentBytes)}
                    </div>
                    <div className="border-t pt-1">
                      <span className="font-semibold">Total Used:</span>{' '}
                      {formatBytes(
                        clusterStatus.memoryActiveBytes +
                          clusterStatus.memoryAllocatedBytes +
                          clusterStatus.memoryMetadataBytes +
                          clusterStatus.memoryResidentBytes
                      )}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div>
              <div className="text-muted-foreground text-xs">Total RAM</div>
              <div className="font-medium">{formatBytes(clusterStatus.totalRamBytes)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Available RAM</div>
              <div className="font-medium">
                {formatBytes(
                  clusterStatus.totalRamBytes -
                    (clusterStatus.memoryActiveBytes +
                      clusterStatus.memoryAllocatedBytes +
                      clusterStatus.memoryMetadataBytes +
                      clusterStatus.memoryResidentBytes)
                )}
              </div>
              <div className="text-muted-foreground text-xs">
                {(
                  ((clusterStatus.totalRamBytes -
                    (clusterStatus.memoryActiveBytes +
                      clusterStatus.memoryAllocatedBytes +
                      clusterStatus.memoryMetadataBytes +
                      clusterStatus.memoryResidentBytes)) /
                    clusterStatus.totalRamBytes) *
                  100
                ).toFixed(1)}
                % free
              </div>
            </div>

            {/* Collection Stats */}
            <div>
              <div className="text-muted-foreground text-xs">Qdrant Points</div>
              <div className="font-medium">
                {clusterStatus.mainCollectionPoints.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">PostgreSQL Rows</div>
              <div className="font-medium">{clusterStatus.totalPostgresRows.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Optimizer</div>
              <div className="font-medium capitalize">
                {clusterStatus.mainCollectionOptimizersStatus}
              </div>
            </div>

            {/* Cluster Health */}
            <div>
              <div className="text-muted-foreground text-xs">Peers</div>
              <div className="font-medium">{clusterStatus.clusterPeers}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Pending Ops</div>
              <div className="font-medium">{clusterStatus.clusterPendingOperations}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Consensus</div>
              <div className="font-medium capitalize">{clusterStatus.consensusStatus}</div>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground p-6 text-center">Unable to load cluster status</div>
        )}
      </div>
    </div>
  );
}
