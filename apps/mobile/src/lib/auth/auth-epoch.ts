// The one auth epoch for the whole app. A bump invalidates every deferred
// write that captured an earlier epoch: the auth-context credential fence,
// the account-metadata persistence helper, and later cache/draft publication
// all skip work scheduled before a sign-out or sign-in.

let refreshSessionVersion = 0;

export function currentAuthEpoch(): number {
  return refreshSessionVersion;
}

export function bumpAuthEpoch(): void {
  refreshSessionVersion += 1;
}

export function isCurrentAuthEpoch(epoch: number): boolean {
  return epoch === refreshSessionVersion;
}
