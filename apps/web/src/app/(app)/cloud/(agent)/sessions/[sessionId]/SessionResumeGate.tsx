'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import {
  SESSION_RESUME_REFUSAL_HREF,
  sessionResumeHref,
  sessionResumeNeedsSignIn,
  sessionResumeRefusal,
  sessionResumeSignInPath,
  type SessionResumeRefusal,
} from '@/lib/cloud-agent/session-resume-target';

type SessionResumeGateProps = {
  sessionId: string;
  anchorMessageId: string | null;
};

/**
 * Turns a universal session link into the chat page that opens it, carrying the
 * recorded anchor. A denial (removed session, lost access) renders the refusal
 * in place; anything the account can see is redirected into the chat, which
 * restores the position from `?at=`.
 */
export function SessionResumeGate({ sessionId, anchorMessageId }: SessionResumeGateProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const sessionQuery = useQuery(trpc.cliSessionsV2.get.queryOptions({ session_id: sessionId }));

  const targetHref = sessionQuery.data
    ? sessionResumeHref(sessionQuery.data, anchorMessageId)
    : null;
  // An expired sign-in fails the context auth, not the session lookup. That is
  // recoverable through sign-in, so it must not render as a permanent denial.
  const needsSignIn = sessionResumeNeedsSignIn(sessionQuery.error);

  useEffect(() => {
    if (targetHref) router.replace(targetHref);
  }, [router, targetHref]);

  useEffect(() => {
    if (needsSignIn) {
      router.replace(sessionResumeSignInPath(sessionId, anchorMessageId));
    }
  }, [anchorMessageId, needsSignIn, router, sessionId]);

  if (targetHref || needsSignIn || sessionQuery.isLoading) {
    return <ResumePlaceholder />;
  }

  const refusal = sessionResumeRefusal(sessionQuery.error?.data?.code);
  if (refusal) {
    return <ResumeRefusalPanel refusal={refusal} />;
  }

  return (
    <ResumeRetryPanel
      retrying={sessionQuery.isFetching}
      onRetry={() => void sessionQuery.refetch()}
    />
  );
}

/** Same centred placeholder the chat page's route wrapper shows while it loads. */
function ResumePlaceholder() {
  return <div className="flex h-full items-center justify-center">Loading...</div>;
}

/** Terminal denial: the link points at a session this account may not open. */
function ResumeRefusalPanel({ refusal }: { refusal: SessionResumeRefusal }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="space-y-1">
        <h1 className="text-base font-medium">{refusal.heading}</h1>
        <p className="text-muted-foreground text-sm">{refusal.message}</p>
      </div>
      <Button variant="secondary" size="sm" asChild>
        <Link href={SESSION_RESUME_REFUSAL_HREF}>Back to sessions</Link>
      </Button>
    </div>
  );
}

function ResumeRetryPanel({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="space-y-1">
        <h1 className="text-base font-medium">Couldn&apos;t load session</h1>
        <p className="text-muted-foreground text-sm">Check your connection and try again.</p>
      </div>
      <Button variant="secondary" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}
