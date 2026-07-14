const noopDeadlineRejection = (_error: Error) => undefined;

export async function withUiDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let rejectDeadline: (error: Error) => void = noopDeadlineRejection;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeoutId = setTimeout(() => {
    rejectDeadline(
      new Error('This is taking longer than expected. You can close this and check again.')
    );
  }, timeoutMs);

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
