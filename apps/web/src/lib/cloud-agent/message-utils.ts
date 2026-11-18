/**
 * Strip the `<available_images>...</available_images>` XML block appended to
 * user messages that have image attachments. The block is only meaningful
 * to the AI agent; it should not be shown in the UI.
 */
export function stripImageContext(text: string): string {
  return text.replace(/\n*<available_images>[\s\S]*?<\/available_images>\s*$/, '');
}
