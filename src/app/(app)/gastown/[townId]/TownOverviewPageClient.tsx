'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateRigDialog } from '@/components/gastown/CreateRigDialog';
import { ArrowLeft, Plus, GitBranch } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type TownOverviewPageClientProps = {
  townId: string;
};

export function TownOverviewPageClient({ townId }: TownOverviewPageClientProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const [isCreateRigOpen, setIsCreateRigOpen] = useState(false);

  const townQuery = useQuery(trpc.gastown.getTown.queryOptions({ townId }));
  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));

  return (
    <PageContainer>
      <div className="mb-8">
        <button
          onClick={() => router.push('/gastown')}
          className="mb-4 flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft className="size-4" />
          Back to towns
        </button>

        <div className="flex items-center justify-between">
          <div>
            {townQuery.isLoading ? (
              <>
                <Skeleton className="h-8 w-48" />
                <Skeleton className="mt-2 h-4 w-32" />
              </>
            ) : (
              <>
                <h1 className="text-3xl font-bold text-gray-100">{townQuery.data?.name}</h1>
                <p className="text-gray-400">Rigs in this town</p>
              </>
            )}
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsCreateRigOpen(true)}
            className="gap-2"
          >
            <Plus className="size-5" />
            New Rig
          </Button>
        </div>
      </div>

      {rigsQuery.isLoading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="mt-2 h-4 w-64" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {rigsQuery.data && rigsQuery.data.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-700 py-16">
          <GitBranch className="mb-4 size-12 text-gray-500" />
          <h3 className="text-lg font-medium text-gray-300">No rigs yet</h3>
          <p className="mt-1 text-sm text-gray-500">Create a rig to connect a git repository</p>
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsCreateRigOpen(true)}
            className="mt-4 gap-2"
          >
            <Plus className="size-5" />
            Create your first rig
          </Button>
        </div>
      )}

      {rigsQuery.data && rigsQuery.data.length > 0 && (
        <div className="space-y-3">
          {rigsQuery.data.map(rig => (
            <Card
              key={rig.id}
              className="cursor-pointer transition-colors hover:bg-gray-800/50"
              onClick={() => router.push(`/gastown/${townId}/rigs/${rig.id}`)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <h3 className="text-lg font-medium text-gray-100">{rig.name}</h3>
                  <div className="mt-1 flex items-center gap-3 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <GitBranch className="size-3.5" />
                      {rig.default_branch}
                    </span>
                    <span className="max-w-xs truncate">{rig.git_url}</span>
                  </div>
                </div>
                <div className="text-sm text-gray-500">
                  {formatDistanceToNow(new Date(rig.created_at), { addSuffix: true })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateRigDialog
        townId={townId}
        isOpen={isCreateRigOpen}
        onClose={() => setIsCreateRigOpen(false)}
      />
    </PageContainer>
  );
}
