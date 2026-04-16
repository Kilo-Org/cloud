export class KiloChatApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`Kilo Chat API error: ${status}`);
    this.name = 'KiloChatApiError';
  }
}
