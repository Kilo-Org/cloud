'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type CustomerSourceSurveyProps = {
  redirectPath: string;
};

export function CustomerSourceSurvey({ redirectPath }: CustomerSourceSurveyProps) {
  const [source, setSource] = useState('');
  const [skipped, setSkipped] = useState(false);
  const router = useRouter();
  const trpc = useTRPC();

  const { mutate: submitSource, isPending } = useMutation(
    trpc.user.submitCustomerSource.mutationOptions({
      onSuccess: () => {
        router.push(redirectPath);
      },
    })
  );

  const { mutate: skipSource } = useMutation(
    trpc.user.skipCustomerSource.mutationOptions({
      onSuccess: () => {
        router.push(redirectPath);
      },
      onError: () => {
        setSkipped(false);
      },
    })
  );

  function handleSkip() {
    setSkipped(true);
    skipSource();
  }

  return (
    <div className="space-y-4 px-6 pb-6">
      <Textarea
        autoFocus
        placeholder="Example: A YouTube video from Theo"
        value={source}
        onChange={e => setSource(e.target.value)}
        rows={3}
        maxLength={1000}
      />
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleSkip}
          disabled={skipped || isPending}
          className="cursor-pointer text-muted-foreground text-sm hover:underline"
        >
          {skipped ? 'Skipping...' : 'Skip'}
        </button>
        <Button
          onClick={() => submitSource({ source: source.trim() })}
          disabled={isPending || skipped || source.trim().length === 0}
        >
          {isPending ? 'Submitting...' : 'Submit'}
        </Button>
      </div>
    </div>
  );
}
