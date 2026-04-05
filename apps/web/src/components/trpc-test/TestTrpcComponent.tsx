'use client';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

// A self-loading component that does not use suspense.
function WithSelfLoading() {
  const trpc = useTRPC();
  const greeting = useQuery(trpc.test.hello.queryOptions());
  if (!greeting.data) return <div>Loading...</div>;
  return <div>{greeting.data.greeting}</div>;
}

export function TestTrpcComponent() {
  return (
    <>
      <WithSelfLoading />
    </>
  );
}
