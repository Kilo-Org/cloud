import { z } from 'zod';

const recordedAuthor = z.object({ digest: z.string(), uuid: z.string().min(1) });

/** A workspace token exposes its own actor on a successful comment response.
 * A cache miss or a rotated token requires a fresh provider observation.
 */
export function bitbucketReviewAuthor(cache: KVNamespace, integrationId: string, digest: string) {
  const key = 'bitbucket-review-author:' + integrationId;
  async function current(): Promise<string | null> {
    const stored = recordedAuthor.safeParse(await cache.get(key, 'json'));
    return stored.success && stored.data.digest === digest ? stored.data.uuid : null;
  }
  return {
    current,
    async record(uuid: string) {
      if ((await current()) !== uuid) await cache.put(key, JSON.stringify({ digest, uuid }));
    },
  };
}
