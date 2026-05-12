/**
 * Identity used for git commit attribution.
 *
 * - `app`: commits attributed to the GitHub App bot (kiloconnect[bot])
 * - `user`: commits attributed to the connected GitHub user account
 */
export type GitIdentity =
  | { kind: 'app'; slug: string; botUserId: string }
  | { kind: 'user'; login: string; userId: string; email: string | null };
