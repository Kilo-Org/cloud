import { type Href } from 'expo-router';

export const SSH_HOSTS_ROUTE = '/(app)/ssh' as Href;
export const SSH_HOST_NEW_ROUTE = '/(app)/ssh/host/new' as Href;
export const SSH_HOST_IMPORT_ROUTE = '/(app)/ssh/import' as Href;
export const SSH_KNOWN_HOSTS_ROUTE = '/(app)/ssh/known-hosts' as Href;

export function sshHostPath(hostId: string): Href {
  return `/(app)/ssh/host/${encodeURIComponent(hostId)}` as Href;
}
