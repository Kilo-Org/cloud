'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type AnthropicUserProfileStatusProps = {
  query: {
    refetch: () => unknown;
    isFetching: boolean;
    data?: { profile: unknown };
    error: { message: string } | null;
  };
};

export function AnthropicUserProfileStatus({ query }: AnthropicUserProfileStatusProps) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {query.isFetching && <Loader2 className="size-4 animate-spin" />}
        Pull status
      </Button>
      {query.error && (
        <p className="text-destructive text-sm" role="alert">
          {query.error.message}
        </p>
      )}
      {query.data && (
        <pre className="bg-muted max-h-80 w-full overflow-auto rounded-md p-3 text-xs">
          {JSON.stringify(query.data.profile, null, 2)}
        </pre>
      )}
    </div>
  );
}
