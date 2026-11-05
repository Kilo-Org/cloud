export async function readBoundedBody(
  request: Request,
  maximumBytes: number
): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let value = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return value + decoder.decode();
      const bytes = new Uint8Array(chunk.value);
      size += bytes.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        return null;
      }
      value += decoder.decode(bytes, { stream: true });
    }
  } catch {
    return null;
  }
}
