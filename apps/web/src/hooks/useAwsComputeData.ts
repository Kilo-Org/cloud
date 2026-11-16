'use client';
import type { AwsSetupProvider } from '@kilocode/worker-utils/aws-onboarding';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';

export function useAwsComputeData(provider: AwsSetupProvider, organizationId?: string) {
  const trpc = useTRPC();
  const client = useRawTRPCClient();
  const cache = useQueryClient();
  const statusOptions =
    organizationId !== undefined
      ? trpc.organizations.awsCompute.getStatus.queryOptions({ organizationId, provider })
      : trpc.awsCompute.getStatus.queryOptions({ provider });
  const status = useQuery(statusOptions);
  const enrollment = useQuery(
    organizationId !== undefined
      ? trpc.organizations.awsCompute.getEnrollment.queryOptions({ organizationId, provider })
      : trpc.awsCompute.getEnrollment.queryOptions({ provider })
  );
  const invalidate = () => cache.invalidateQueries({ queryKey: statusOptions.queryKey });
  const prepare = useMutation({
    mutationKey: [...statusOptions.queryKey, 'prepare'],
    gcTime: 0,
    mutationFn: (accountId: string) =>
      organizationId !== undefined
        ? client.organizations.awsCompute.prepare.mutate({ organizationId, accountId, provider })
        : client.awsCompute.prepare.mutate({ accountId, provider }),
    onSuccess: invalidate,
  });
  const instructions = useMutation({
    mutationKey: [...statusOptions.queryKey, 'instructions'],
    gcTime: 0,
    mutationFn: () =>
      organizationId !== undefined
        ? client.organizations.awsCompute.instructions.mutate({ organizationId, provider })
        : client.awsCompute.instructions.mutate({ provider }),
  });
  const validate = useMutation({
    mutationKey: [...statusOptions.queryKey, 'validate'],
    gcTime: 0,
    mutationFn: (roleArn: string) =>
      organizationId !== undefined
        ? client.organizations.awsCompute.validate.mutate({ organizationId, roleArn, provider })
        : client.awsCompute.validate.mutate({ roleArn, provider }),
    onSuccess: invalidate,
  });
  const discard = useMutation({
    mutationKey: [...statusOptions.queryKey, 'discard'],
    gcTime: 0,
    mutationFn: (generation: string) =>
      organizationId !== undefined
        ? client.organizations.awsCompute.discardDraft.mutate({
            organizationId,
            generation,
            provider,
          })
        : client.awsCompute.discardDraft.mutate({ generation, provider }),
    onSuccess: async () => {
      instructions.reset();
      prepare.reset();
      validate.reset();
      await invalidate();
    },
  });
  return { status, enrollment, prepare, instructions, validate, discard };
}
