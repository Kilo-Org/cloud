export type EnableInput = { cron?: string; timezone?: string };

export function parseEnableArgs(args: string | undefined): EnableInput {
  const text = (args ?? '').trim();
  if (!text) {
    return {};
  }
  const tokens = text.split(/\s+/).filter(Boolean);

  if (tokens.length >= 5) {
    const cron = tokens.slice(0, 5).join(' ');
    const timezone = tokens.slice(5).join(' ');
    return {
      cron,
      timezone: timezone.length > 0 ? timezone : undefined,
    };
  }

  if (tokens.length === 1) {
    return { cron: tokens[0] };
  }

  return {
    cron: tokens[0],
    timezone: tokens.slice(1).join(' '),
  };
}
