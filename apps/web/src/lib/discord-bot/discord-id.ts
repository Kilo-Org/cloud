const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isDiscordSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value);
}

export function parseDiscordSnowflake(value: string, fieldName: string): string {
  if (isDiscordSnowflake(value)) {
    return value;
  }

  throw new Error(`Invalid Discord ${fieldName}`);
}

export function buildDiscordApiUrl(
  pathSegments: string[],
  query?: Record<string, string | number>
): string {
  const url = new URL(
    pathSegments.map(segment => encodeURIComponent(segment)).join('/'),
    DISCORD_API_BASE_URL
  );

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}
