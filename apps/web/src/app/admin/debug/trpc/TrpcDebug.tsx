'use client';

import { ErrorCard } from '@/components/ErrorCard';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import type { DecorateQueryProcedure } from '@trpc/tanstack-react-query';

type Props = {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  procedure: DecorateQueryProcedure<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
};

function ErrorBox({ procedure, input, title }: Props) {
  const { error, refetch } = useQuery(procedure.queryOptions(input));
  return (
    <div>
      {error && (
        <ErrorCard
          title={title}
          description="testing error formatting"
          onRetry={refetch}
          error={error}
        />
      )}
    </div>
  );
}

export function TrpcDebug() {
  const trpc = useTRPC();
  return (
    <div>
      <div>TRPC Debug Page</div>
      <ErrorBox procedure={trpc.debug.unhandledError} input={undefined} title="Unhandled Error" />
      <ErrorBox procedure={trpc.debug.badInputError} input={{}} title="Bad Input Error" />
      <ErrorBox procedure={trpc.debug.handledTrpcError} input={[]} title="Handled TRPC Error" />
      <ErrorBox
        procedure={trpc.debug.badInputObjectError}
        input={{}}
        title="Bad Input Object Error"
      />
      <ErrorBox
        procedure={trpc.debug.badInputObjectError}
        input={[]}
        title="Bad Input Array Error"
      />
    </div>
  );
}
