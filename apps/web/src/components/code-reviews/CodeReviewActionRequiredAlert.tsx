import Link from 'next/link';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { CodeReviewActionRequiredState } from '@/lib/code-reviews/action-required-shared';
import {
  getCodeReviewActionRequiredCopy,
  getCodeReviewActionRequiredRecoveryHref,
} from '@/lib/code-reviews/action-required-shared';

type CodeReviewActionRequiredAlertProps = {
  actionRequired: CodeReviewActionRequiredState;
  organizationId?: string;
  compact?: boolean;
};

export function CodeReviewActionRequiredAlert({
  actionRequired,
  organizationId,
  compact = false,
}: CodeReviewActionRequiredAlertProps) {
  const copy = getCodeReviewActionRequiredCopy(actionRequired.reason);
  const recoveryHref = getCodeReviewActionRequiredRecoveryHref(
    actionRequired.reason,
    organizationId
  );
  const isMailto = recoveryHref.startsWith('mailto:');

  const cta = (
    <Button variant="outline" size="sm" asChild>
      {isMailto ? (
        <a href={recoveryHref}>
          {copy.recoveryLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <Link href={recoveryHref}>
          {copy.recoveryLabel}
          <ExternalLink className="h-3 w-3" />
        </Link>
      )}
    </Button>
  );

  return (
    <Alert variant="destructive" className={compact ? 'py-3' : undefined}>
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{copy.description}</p>
        {cta}
      </AlertDescription>
    </Alert>
  );
}
