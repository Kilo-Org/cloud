'use client';

import { Button } from '@/components/ui/button';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';

export default function CheckKiloPassButton({ userId }: { userId: string }) {
  const trpc = useTRPC();

  const mutation = useMutation(
    trpc.admin.users.checkKiloPass.mutationOptions({
      onSuccess: data => {
        const beforeT = data.before.kilo_pass_threshold;
        const afterT = data.after?.kilo_pass_threshold ?? null;

        if (beforeT == null) {
          toast.message('Kilo Pass: no threshold set');
          return;
        }

        if (afterT == null) {
          toast.success('Kilo Pass: bonus check ran (threshold cleared)');
          return;
        }

        toast.message('Kilo Pass: bonus check ran (not yet eligible)');
      },
      onError: error => {
        toast.error(error.message || 'Kilo Pass check failed');
      },
    })
  );

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate({ userId })}
    >
      Check bonus
    </Button>
  );
}
