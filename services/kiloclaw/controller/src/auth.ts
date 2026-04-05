import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function timingSafeTokenEqual(
  providedToken: string | null | undefined,
  expectedToken: string
): boolean {
  const provided = providedToken ?? '';
  const matches = timingSafeEqual(sha256(provided), sha256(expectedToken));
  return providedToken != null && matches;
}
