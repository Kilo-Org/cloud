'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateTownDialog } from '@/components/gastown/CreateTownDialog';
import { Plus, Factory, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

export function TownListPageClient() {
  const router = useRouter();
  const trpc = useTRPC();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const queryClient = useQueryClient();
  const townsQuery = useQuery(trpc.gastown.listTowns.queryOptions());

  const deleteTown = useMutation(
    trpc.gastown.deleteTown.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listTowns.queryKey() });
        toast.success('Town deleted');
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  return (
    <PageContainer>
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-gray-100">Gastown</h1>
              <Badge variant="beta">beta</Badge>
            </div>
            <p className="text-gray-400">Manage your towns and rigs</p>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsCreateOpen(true)}
            className="gap-2"
          >
            <Plus className="size-5" />
            New Town
          </Button>
        </div>
      </div>

      {townsQuery.isLoading && (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="mt-2 h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {townsQuery.data && townsQuery.data.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-700 py-16">
          <Factory className="mb-4 size-12 text-gray-500" />
          <h3 className="text-lg font-medium text-gray-300">No towns yet</h3>
          <p className="mt-1 text-sm text-gray-500">Create a town to get started with Gastown</p>
          <Button
            variant="primary"
            size="md"
            onClick={() => setIsCreateOpen(true)}
            className="mt-4 gap-2"
          >
            <Plus className="size-5" />
            Create your first town
          </Button>
        </div>
      )}

      {townsQuery.data && townsQuery.data.length > 0 && (
        <div className="space-y-3">
          {townsQuery.data.map(town => (
            <Card
              key={town.id}
              className="cursor-pointer transition-colors hover:bg-gray-800/50"
              onClick={() => router.push(`/gastown/${town.id}`)}
            >
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <h3 className="text-lg font-medium text-gray-100">{town.name}</h3>
                  <p className="text-sm text-gray-500">
                    Created {formatDistanceToNow(new Date(town.created_at), { addSuffix: true })}
                  </p>
                </div>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    if (
                      confirm(`Delete town "${town.name}"? This will also delete all its rigs.`)
                    ) {
                      deleteTown.mutate({ townId: town.id });
                    }
                  }}
                  className="rounded p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 className="size-4" />
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateTownDialog isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
    </PageContainer>
  );
}
