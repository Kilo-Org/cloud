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
  candidates: Candidate[] | undefined;
  isSelecting: boolean;
  isRestarting: boolean;
  onSelect: (installationId: string) => void;
  onRestart: () => void;
  /** Whether a fresh GitHub App install is currently permitted (mirrors the
   *  existing `canAdd` admission check; unchanged authorization). */
  canInstallNew: boolean;
  onInstallNew: () => void;
  isInstalling: boolean;
}) {
  if (props.isLoading) {
    return <p className="mt-3 text-sm text-muted-foreground">Loading eligible installations…</p>;
  }
  if (props.isError) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-destructive">
          This connection attempt expired or is no longer available.
        </p>
        <Button variant="outline" onClick={props.onRestart} disabled={props.isRestarting}>
          Restart connection
        </Button>
      </div>
    );
  }

  const installNewButton = props.canInstallNew && (
    <Button
      variant={props.candidates?.length ? 'outline' : 'default'}
      onClick={props.onInstallNew}
      disabled={props.isInstalling}
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
            disabled={props.isSelecting}
          >
            {candidate.accountLogin}
            <span className="font-mono text-xs text-muted-foreground">
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
