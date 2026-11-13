import { type SshConfigEntry } from './ssh-config-parse';

export type SshConfigForwardDraft = Readonly<{
  direction: 'local' | 'remote';
  bindHost: string;
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
}>;

export type SshConfigForwardWarnings = Readonly<{
  forwards: SshConfigForwardDraft[];
  /** The directives this reader could not turn into a forward. */
  failed: string[];
}>;

function portOf(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

type HostAndPort = Readonly<{ host: string | null; port: number | null }>;

function splitHostAndPort(token: string): HostAndPort {
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(token);
  if (bracketed) {
    return { host: bracketed[1] ?? null, port: portOf(bracketed[2] ?? '') };
  }
  const colon = token.lastIndexOf(':');
  if (colon === -1) {
    return { host: null, port: portOf(token) };
  }
  return { host: token.slice(0, colon), port: portOf(token.slice(colon + 1)) };
}

/**
 * One `LocalForward`/`RemoteForward` line, in either of OpenSSH's shapes:
 * `port host:hostport` and `[bind_address:]port host:hostport`. A Unix socket
 * target, or a port outside 1-65535, is not a forward this app can store.
 */
function parseForward(
  direction: SshConfigForwardDraft['direction'],
  value: string
): SshConfigForwardDraft | null {
  const tokens = value.split(/\s+/).filter(token => token.length > 0);
  let bindToken = tokens[0];
  let destinationToken = tokens[1];
  if (tokens.length === 1 && bindToken !== undefined) {
    const parts = bindToken.split(':');
    if (parts.length !== 3) {
      return null;
    }
    bindToken = parts[0];
    destinationToken = `${parts[1] ?? ''}:${parts[2] ?? ''}`;
  }
  if (bindToken === undefined || destinationToken === undefined) {
    return null;
  }
  const bind = splitHostAndPort(bindToken);
  const destination = splitHostAndPort(destinationToken);
  if (bind.port === null || destination.port === null || destination.host === null) {
    return null;
  }
  return {
    direction,
    bindHost: bind.host ?? '127.0.0.1',
    bindPort: bind.port,
    destinationHost: destination.host,
    destinationPort: destination.port,
  };
}

function forwardDirectionOf(key: string): SshConfigForwardDraft['direction'] | null {
  if (key === 'localforward') {
    return 'local';
  }
  return key === 'remoteforward' ? 'remote' : null;
}

/** A directive a host block may repeat, so its lines all count. */
export function isRepeatableDirective(key: string): boolean {
  return key === 'localforward' || key === 'remoteforward';
}

export function forwardsOf(entries: readonly SshConfigEntry[]): SshConfigForwardWarnings {
  const forwards: SshConfigForwardDraft[] = [];
  const failed: string[] = [];
  for (const entry of entries) {
    const direction = forwardDirectionOf(entry.key);
    if (direction !== null) {
      const forward = parseForward(direction, entry.value);
      if (forward === null) {
        failed.push(entry.key);
      } else {
        forwards.push(forward);
      }
    }
  }
  return { forwards, failed };
}
