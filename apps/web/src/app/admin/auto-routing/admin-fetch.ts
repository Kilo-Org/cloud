import * as z from 'zod';

const AdminApiErrorSchema = z.object({ error: z.string().min(1), message: z.string().optional() });

async function adminErrorMessage(response: Response): Promise<string> {
  const parsed = AdminApiErrorSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return `Request failed: ${response.status}`;
  const { error, message } = parsed.data;
  return message ? `${error}: ${message}` : error;
}

export async function parseAdminResponse<T extends object>(
  response: Response,
  schema: z.ZodType<T>
): Promise<T> {
  if (!response.ok) throw new Error(await adminErrorMessage(response));
  return schema.parse(await response.json());
}
