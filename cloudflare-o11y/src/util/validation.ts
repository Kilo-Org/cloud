import { validator } from 'hono/validator';
import type { Context, Env } from 'hono';
import type { ZodTypeAny } from 'zod';

type ErrorResponse = {
	success: false;
	error: string;
	issues: unknown;
};

export function zodJsonValidator<T extends ZodTypeAny>(
	schema: T,
	opts?: {
		errorMessage?: string;
	},
) {
	const errorMessage = opts?.errorMessage ?? 'Invalid request body';

	return validator('json', (value, c: Context<Env>) => {
		const parsed = schema.safeParse(value);

		if (!parsed.success) {
			return c.json(
				{
					success: false,
					error: errorMessage,
					issues: parsed.error.issues,
				} satisfies ErrorResponse,
				400,
			);
		}

		return parsed.data;
	});
}
