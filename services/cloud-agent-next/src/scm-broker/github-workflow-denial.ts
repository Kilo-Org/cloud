const INSPECTION_MS = 500;
const MAX_MESSAGE_BYTES = 16 * 1024;

async function boundedProviderMessage(response: Response): Promise<string | null> {
  const body: ReadableStream<unknown> | null = response.clone().body;
  const reader = body?.getReader();
  if (!reader) return null;
  const deadline = Date.now() + INSPECTION_MS;
  const decoder = new TextDecoder();
  let message = '',
    length = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
      if (!result) return null;
      if (result.done) return message + decoder.decode();
      if (!(result.value instanceof Uint8Array)) return null;
      length += result.value.byteLength;
      if (length > MAX_MESSAGE_BYTES) return null;
      message += decoder.decode(result.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    // Tee cancellation can wait for the untouched provider branch. It must not delay forwarding.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** GitHub's provider restriction also applies to opaque Git pushes. */
export async function workflowPermissionDenial(response: Response): Promise<Response | null> {
  if (response.status !== 403) return null;
  let unsupported = /workflows?\s*=\s*write/i.test(
    response.headers.get('x-accepted-github-permissions') ?? ''
  );
  if (!unsupported) {
    const message = await boundedProviderMessage(response);
    unsupported =
      message !== null &&
      /workflow/i.test(message) &&
      /permission|scope|refus|not permitted/i.test(message);
  }
  if (!unsupported) return null;
  void response.body?.cancel().catch(() => undefined);
  return new Response(
    'operation_not_supported: Workflow file changes are not supported by workspace repository access.',
    { status: 403 }
  );
}
