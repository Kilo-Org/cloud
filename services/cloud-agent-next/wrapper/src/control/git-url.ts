export function authenticatedGitUrl(
  gitUrl: string,
  token: string | undefined,
  platform: 'github' | 'gitlab' | 'bitbucket' | undefined
): string {
  if (!token) return gitUrl;
  const url = new URL(gitUrl);
  url.username =
    platform === 'gitlab' ? 'oauth2' : platform === 'bitbucket' ? 'x-token-auth' : 'x-access-token';
  url.password = token;
  return url.toString();
}
