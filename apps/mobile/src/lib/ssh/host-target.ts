import { type SshHost } from './hosts';

/** `user@host:port`, the shape an ssh command line takes. */
export function hostTarget(host: Pick<SshHost, 'username' | 'hostname' | 'port'>): string {
  return `${host.username}@${host.hostname}:${host.port}`;
}
