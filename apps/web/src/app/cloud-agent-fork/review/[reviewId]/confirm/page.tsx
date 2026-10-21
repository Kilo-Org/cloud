import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

/**
 * Confirmation step for "fix these issues" links in review comments. Opening the
 * link lands here; the fix session starts only when the signed-in reader submits
 * this page's form.
 */
export default async function ConfirmFixSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { reviewId } = await params;
  const { error } = await searchParams;

  if (!z.uuid().safeParse(reviewId).success) {
    redirect('/code-reviews?error=invalid_review_id');
  }

  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(`/cloud-agent-fork/review/${reviewId}/confirm`)}`
  );

  return (
    <KiloCardLayout title="Start a fix session">
      <p className="text-muted-foreground text-sm">
        Kilo starts a cloud agent session that applies this review&apos;s comments to the pull
        request, commits each fix, and pushes the commits to the branch. The session uses your Kilo
        credits.
      </p>
      {error === 'rate_limited' ? (
        <Alert variant="destructive">
          <AlertDescription>
            You have started several fix sessions in the last hour. Try again later.
          </AlertDescription>
        </Alert>
      ) : null}
      <form
        method="post"
        action={`/cloud-agent-fork/review/${reviewId}`}
        className="flex flex-col gap-3"
      >
        <Button type="submit">Start fix session</Button>
        <Button asChild variant="ghost">
          <Link href="/code-reviews">Cancel</Link>
        </Button>
      </form>
    </KiloCardLayout>
  );
}
