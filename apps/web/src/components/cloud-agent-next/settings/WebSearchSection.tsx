'use client';

import { useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';
import {
  webSearchPreferenceSchema,
  webSearchProviderSchema,
  webSearchProviders,
} from '@cloud-agent-shared/web-search-provider';

export function WebSearchSection() {
  const id = useId();
  const descriptionId = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.cloudAgentSettings.getWebSearch.queryOptions());
  const mutation = useMutation(
    trpc.cloudAgentSettings.setWebSearch.mutationOptions({
      onSuccess: settings => {
        queryClient.setQueryData(trpc.cloudAgentSettings.getWebSearch.queryKey(), settings);
      },
    })
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id}>Web search provider</Label>
          <p id={descriptionId} className="text-muted-foreground text-sm">
            Applies to new personal Kilo v2 workspaces. Default uses the repository’s choice or Exa.
          </p>
        </div>
        <Select
          value={mutation.isPending ? mutation.variables.provider : (query.data?.provider ?? '')}
          disabled={!query.data || mutation.isPending}
          onValueChange={provider =>
            mutation.mutate({ provider: webSearchPreferenceSchema.parse(provider) })
          }
        >
          <SelectTrigger
            id={id}
            aria-describedby={descriptionId}
            className="min-w-36 shrink-0 pointer-coarse:min-h-11"
          >
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default (Exa)</SelectItem>
            {webSearchProviderSchema.options.map(provider => (
              <SelectItem key={provider} value={provider}>
                {webSearchProviders[provider]}
              </SelectItem>
            ))}
            <SelectItem value="off">Off</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {query.isError && !query.data && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="text-sm">Could not load the web search setting.</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="text-sm">
          Could not save the web search setting. Try again.
        </p>
      )}
    </div>
  );
}
