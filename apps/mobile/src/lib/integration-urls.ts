function trimTrailingSlash(webBaseUrl: string): string {
  return webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
}

// Every provider's connect flow now starts on an app-shell page
// (`app-shell-handoff`), and Bitbucket's workspace access token is pasted in the
// app's own connect sheet (`app/(app)/bitbucket-connect.tsx`), so no provider
// opens a full-web `/integrations/...` page from the app any more.

// The BYOK key editor has no mobile screen, so a reviewer blocked by a broken
// key sends the user to the web settings page that owns it.
export function getByokUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = trimTrailingSlash(webBaseUrl);
  if (!organizationId) {
    return `${baseUrl}/byok`;
  }
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/byok`;
}
