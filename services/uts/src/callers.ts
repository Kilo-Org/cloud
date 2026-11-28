import { z } from 'zod';

const CallerPropsSchema = z.strictObject({ caller: z.string().min(1) });

/**
 * The caller a service binding's `props` name; null when the binding carries no valid props. A
 * service binding carries `props.caller`, and only a deploy in the account can set props, so a
 * named entrypoint that answers one caller relies on deploy-level trust, as the STS broker does
 * (design 6.4); `test/repo` keeps every other config from binding the mint Worker.
 */
export function callerOf(props: unknown): string | null {
  const parsed = CallerPropsSchema.safeParse(props);
  return parsed.success ? parsed.data.caller : null;
}
