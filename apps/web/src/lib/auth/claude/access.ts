export function withLaunchedClaudeSignIn<T extends string>(
  providers: readonly T[],
  claudeSignInEnabled: boolean
): T[] {
  return claudeSignInEnabled ? [...providers] : providers.filter(provider => provider !== 'claude');
}
