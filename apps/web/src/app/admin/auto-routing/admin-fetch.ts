import * as z from 'zod';

const AdminApiErrorSchema = z.object({ error: z.string().optional() });

export async function parseAdminResponse<T extends object>(
  response: Response,
  schema: z.ZodType<T>
): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsedError = AdminApiErrorSchema.safeParse(body);
    throw new Error(
      parsedError.success && parsedError.data.error
        ? parsedError.data.error
        : `Request failed: ${response.status}`
    );
  }
  return schema.parse(body);
}
