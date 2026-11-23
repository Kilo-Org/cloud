'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';

export function useAwsComputeData(organizationId?: string) {
  const trpc = useTRPC();
  const client = useRawTRPCClient();
  const cache = useQueryClient();
  const statusOptions =
    organizationId !== undefined
      ? trpc.organizations.awsCompute.getStatus.queryOptions({ organizationId })
      : trpc.awsCompute.getStatus.queryOptions();
  const status = useQuery(statusOptions);
  const enrollment = useQuery(
    organizationId !== undefined
      ? trpc.organizations.awsCompute.getEnrollment.queryOptions({ organizationId })
      : trpc.awsCompute.getEnrollment.queryOptions()
  );
  const invalidate = () => cache.invalidateQueries({ queryKey: statusOptions.queryKey });
  const prepare = useMutation({
    mutationKey: [...statusOptions.queryKey, 'prepare'],
    gcTime: 0,
    mutationFn: (accountId: string) =>
      organizationId !== undefined
        ? client.organizations.awsCompute.prepare.mutate({ organizationId, accountId })
        : client.awsCompute.prepare.mutate({ accountId }),
    onSuccess: invalidate,
  });
  const instructions = useMutation({
    mutationKey: [...statusOptions.queryKey, 'instructions'],
    gcTime: 0,
    mutationFn: () =>
      organizationId !== undefined
        ? client.organizations.awsCompute.instructions.mutate({ organizationId })
        : client.awsCompute.instructions.mutate(),
  });
  const validate = useMutation({
    mutationKey: [...statusOptions.queryKey, 'validate'],
    gcTime: 0,
    mutationFn: (roleArn: string) =>
      organizationId !== undefined
        ? client.organizations.awsCompute.validate.mutate({ organizationId, roleArn })
        : client.awsCompute.validate.mutate({ roleArn }),
    onSuccess: invalidate,
  });
  const discard = useMutation({
    mutationKey: [...statusOptions.queryKey, 'discard'],
    gcTime: 0,
    mutationFn: (generation: string) =>
      organizationId !== undefined
        ? client.organizations.awsCompute.discardDraft.mutate({ organizationId, generation })
        : client.awsCompute.discardDraft.mutate({ generation }),
    onSuccess: async () => {
      instructions.reset();
      prepare.reset();
      validate.reset();
      await invalidate();
    },
  });
  return { status, enrollment, prepare, instructions, validate, discard };
}
