/**
 * Posts to the paging webhook. House rule: a message an automation posts starts with `bot: `.
 * The message never carries a secret or an event payload.
 */
export async function pageSlack(
  webhookUrl: string,
  message: string,
  http: typeof fetch
): Promise<boolean> {
  try {
    const response = await http(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `bot: ${message}` }),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
