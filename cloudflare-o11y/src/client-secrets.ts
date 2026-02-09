export async function getClientName(clientSecret: string, env: Env): Promise<string | null> {
	const trimmed = clientSecret.trim();
	if (!trimmed) return null;

	if (trimmed === (await env.O11Y_KILO_GATEWAY_CLIENT_SECRET.get())) return 'kilo-gateway';

	return null;
}
