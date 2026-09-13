import { Github } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Candidate = { installationId: string; accountLogin: string };

/**
 * The single post-OAuth picker for the unified "Connect GitHub" flow: a
 * user has no way to know ahead of time whether the App is already
 * installed somewhere they can access, so this always shows both options
 * together — attach one of the installations discovered for their GitHub
 * identity, or continue to the GitHub installer for an org that doesn't
 * have it yet. Selecting an installation still goes through the existing
 * connect-existing confirm path; "install new" still goes through the
 * existing fresh-install mint+redirect path. Neither path nor its
 * authorization changes here.
 */
export function GitHubConnectionAttemptState(props: {
  isLoading: boolean;
  isError: boolean;
  /** True only for a confirmed NOT_FOUND response (the attempt genuinely
   *  expired, was consumed, or never existed). Any other error — network
   *  failure, a transient server error, etc. — is not known to be expired,
   *  so it gets a retry instead of a claim that the attempt is gone.
   *  Callers must derive this as `isError && <confirmed NOT_FOUND>` (never
   *  independently of `isError`) so the two props can't disagree. */
  isNotFound: boolean;
  candidates: Candidate[] | undefined;
  isSelecting: boolean;
  isRestarting: boolean;
  onSelect: (installationId: string) => void;
  onRestart: () => void;
  /** Re-fetches the same attempt, for a non-NOT_FOUND error where the
   *  attempt itself may still be valid. */
  onRetry: () => void;
  isRetrying: boolean;
  /** Whether a fresh GitHub App install is currently permitted (mirrors the
   *  existing `canAdd` admission check; unchanged authorization). */
  canInstallNew: boolean;
  onInstallNew: () => void;
  isInstalling: boolean;
}) {
  if (props.isLoading) {
    return <p className="mt-3 text-sm text-muted-foreground">Loading eligible installations…</p>;
  }
  if (props.isError && props.isNotFound) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-destructive">
          This connection attempt expired or is no longer available.
        </p>
        <Button variant="default" onClick={props.onRestart} disabled={props.isRestarting}>
          Restart connection
        </Button>
      </div>
    );
  }
  if (props.isError) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-destructive">Could not load this connection attempt.</p>
        <Button
          variant="default"
          className="min-h-11 sm:min-h-0"
          onClick={props.onRetry}
          disabled={props.isRetrying}
        >
          {props.isRetrying ? 'Reloading…' : 'Reload connection attempt'}
        </Button>
      </div>
    );
  }

  // Only one action in the picker should ever be in flight at a time:
  // disable every action here while any one of them is pending, not just
  // its own action, so a candidate select and "install new" can't race
  // each other (e.g. selectConnection in flight, install-new still
  // clickable, before the confirm/select redirect actually navigates away).
  const anyActionPending = props.isSelecting || props.isInstalling;

  const installNewButton = props.canInstallNew && (
    <Button
      variant={props.candidates?.length ? 'outline' : 'default'}
      className="min-h-11 sm:min-h-0"
      onClick={props.onInstallNew}
      disabled={anyActionPending}
    >
      <Github className="size-4" />
      {props.isInstalling ? 'Opening GitHub…' : 'Install on a different GitHub organization'}
    </Button>
  );

  if (props.candidates?.length) {
    return (
      <div className="mt-3 grid gap-2">
        {props.candidates.map(candidate => (
          <Button
            key={candidate.installationId}
            variant="outline"
            className="justify-between"
            onClick={() => props.onSelect(candidate.installationId)}
            disabled={anyActionPending}
            aria-label={`Connect ${candidate.accountLogin}, installation ${candidate.installationId}`}
          >
            {candidate.accountLogin}
            <span className="font-mono text-xs text-muted-foreground" aria-hidden="true">
              {candidate.installationId}
            </span>
          </Button>
        ))}
        {installNewButton}
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-muted-foreground">
        {props.canInstallNew
          ? 'No existing GitHub installations are available to connect for your GitHub account. Install the GitHub App to grant Kilo access to repositories.'
          : 'No existing GitHub installations are available to connect for your GitHub account.'}
      </p>
      {installNewButton}
    </div>
  );
}
