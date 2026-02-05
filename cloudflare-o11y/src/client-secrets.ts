const clientSecretToClientName = new Map<string, string>([['TODO', 'kilo-gateway']]);

export function getClientNameFromSecret(clientSecret: string): string | null {
	const clientSecretTrimmed = clientSecret.trim();
	if (!clientSecretTrimmed) return null;

	const clientName = clientSecretToClientName.get(clientSecretTrimmed);
	return clientName ?? null;
}
