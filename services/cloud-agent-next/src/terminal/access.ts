const TERMINAL_SESSION_PLATFORMS = new Set(['cloud-agent', 'cloud-agent-web', 'slack']);

export function isTerminalSessionPlatform(platform: string | undefined): boolean {
  return platform !== undefined && TERMINAL_SESSION_PLATFORMS.has(platform);
}
