import { z } from 'zod';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { dispatchWatchPrMaintenance } from '@/lib/cloud-agent/watch-pr-maintenance';
import { enablePullRequestAutoFixWorkspaces } from '@/lib/cloud-agent/pr-auto-fix';

export const maxDuration = 180;
const inputSchema = z
  .object({
    watchId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();

export async function POST(request: Request) {
  const denied = authorizeInternalApiRequest(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const input = inputSchema.safeParse(body);
  if (!input.success)
    return Response.json({ error: 'Invalid maintenance dispatch request' }, { status: 400 });
  const result = await dispatchWatchPrMaintenance(input.data);
  if (!input.data.watchId) await enablePullRequestAutoFixWorkspaces();
  return Response.json(result);
}
