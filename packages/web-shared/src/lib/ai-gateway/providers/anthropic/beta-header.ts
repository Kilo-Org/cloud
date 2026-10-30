export function appendAnthropicBetaHeader(extraHeaders: Record<string, string>, betaFlag: string) {
  for (const header of ['anthropic-beta', 'x-anthropic-beta']) {
    extraHeaders[header] = [extraHeaders[header], betaFlag].filter(Boolean).join(',');
  }
}
