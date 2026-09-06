import { Megaphone } from 'lucide-react';

const SYSTEM_MESSAGE_TEXT = 'Important security notice';
const SYSTEM_MESSAGE_URL = 'https://blog.kilo.ai/';

export function SystemMessageBanner() {
  return (
    <a
      href={SYSTEM_MESSAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
    >
      <Megaphone aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate underline-offset-2 hover:underline">{SYSTEM_MESSAGE_TEXT}</span>
    </a>
  );
}
