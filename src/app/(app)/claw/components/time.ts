import { formatDistanceToNow } from 'date-fns';

export function formatTs(ts: number | null | undefined) {
  if (ts == null) return 'Never';
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}
