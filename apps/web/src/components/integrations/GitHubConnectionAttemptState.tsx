import { Button } from '@/components/ui/button';

type Candidate = { installationId: string; accountLogin: string };

export function GitHubConnectionAttemptState(props: {
  isLoading: boolean;
  isError: boolean;
  candidates: Candidate[] | undefined;
  isSelecting: boolean;
  isRestarting: boolean;
  onSelect: (installationId: string) => void;
  onRestart: () => void;
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
      </div>
    );
  }
  return (
    <p className="mt-3 text-sm text-muted-foreground">
      No eligible existing GitHub installations were found.
    </p>
  );
}
