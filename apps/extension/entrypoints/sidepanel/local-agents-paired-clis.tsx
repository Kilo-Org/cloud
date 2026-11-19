import type { JSX } from 'react';
import type {
  LocalAgentsLoopbackEndpoint,
  LocalAgentsLoopbackReachability,
} from './local-agents-settings-state';

const PAIRED_CLI_LABEL = 'Kilo CLI';
const REACHABILITY_LABELS = {
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  unreachable: 'Not reachable',
} satisfies Record<LocalAgentsLoopbackReachability, string>;
const UNREACHABLE_HINT =
  'Start the Kilo CLI again to pair this browser. An entry that stays unreachable is removed after a day.';

export const LocalAgentsPairedClis = ({
  endpoints,
}: {
  endpoints: LocalAgentsLoopbackEndpoint[];
}): JSX.Element | null => {
  if (endpoints.length === 0) {
    return null;
  }

  return (
    <>
      <ul aria-label="Paired Kilo CLIs" className="mt-2 flex flex-col gap-1">
        {endpoints.map(endpoint => (
          <li className="flex min-w-0 items-center justify-between gap-2" key={endpoint.endpointId}>
            <p className="type-body truncate text-foreground" title={endpoint.address}>
              {PAIRED_CLI_LABEL} · {endpoint.address}
            </p>
            <p className="type-label shrink-0 text-foreground-muted">
              {REACHABILITY_LABELS[endpoint.reachability]}
            </p>
          </li>
        ))}
      </ul>
      {endpoints.some(endpoint => endpoint.reachability === 'unreachable') ? (
        <p className="type-body mt-2 text-foreground-muted">{UNREACHABLE_HINT}</p>
      ) : null}
    </>
  );
};
