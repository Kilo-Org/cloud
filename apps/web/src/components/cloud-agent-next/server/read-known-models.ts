import 'server-only';
import { cookies } from 'next/headers';
import { KNOWN_MODELS_COOKIE, parseKnownModels } from '../known-models';
import type { KnownModel } from '../known-models';

/** The models in this request's cookie, which is scoped to the route's account. */
export async function readKnownModels(userId: string): Promise<KnownModel[]> {
  const cookieStore = await cookies();
  return parseKnownModels(cookieStore.get(KNOWN_MODELS_COOKIE)?.value, userId);
}
