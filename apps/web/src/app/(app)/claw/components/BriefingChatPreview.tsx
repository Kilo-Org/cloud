'use client';

import { cn } from '@/lib/utils';
import type { BotIdentity } from './claw.types';

type BriefingChatPreviewProps = {
  /** Bot identity (name, emoji, nature) — pulled from earlier wizard step. */
  bot: BotIdentity;
  /** Optional greeting line that opens the message. */
  greeting?: string;
  /** Body items shown as bulleted lines inside the message bubble. */
  items: string[];
  /** Soft sign-off italicized at the bottom of the message. */
  closer?: string;
  /**
   * Copy shown when `items` is empty. Lets parents distinguish between
   * "I have nothing yet" and "look at this rich preview" without each
   * screen owning the empty state styling.
   */
  emptyMessage?: string;
  /**
   * Time stamp shown in the date separator. Static "7:30 AM" by default
   * — this is a preview, not a live stream.
   */
  time?: string;
  /**
   * Day label shown in the date separator. Defaults to "Tomorrow" since
   * every onboarding step previews the next morning's briefing.
   */
  dayLabel?: string;
  className?: string;
};

/**
 * Chat-message shell that previews tomorrow's morning briefing as if it
 * arrived in a messaging surface. Used as the left column of multi-column
 * onboarding steps so the user sees what they're configuring.
 *
 * Visual register borrows from real chat apps (iMessage / Slack / Discord)
 * rather than form chrome:
 *
 * - Content top-anchors so the chat preview reads as a paired column
 *   with the form on the right (both fill from the top, so when the
 *   grid stretches one to match the other, empty space lands at the
 *   bottom of both — never in opposite halves).
 * - Centered date separator with hairlines, the way every chat client
 *   marks a day boundary.
 * - Bubble uses the `bg-secondary` token so it sits brighter than the
 *   `bg-muted/20` shell — pops by being lighter, the way iMessage and
 *   WhatsApp dark do it. No pure-black shell needed.
 * - `rounded-tl-sm` corner gives a subtle "tail" pointing back at the
 *   avatar without resorting to a literal triangle pseudo-element.
 * - Mono timestamps for chat-app realism (numbers in dense data lean
 *   mono per `design.md` typography).
 *
 * Stays away from over-branding: no "via Kilo" footer, no presence
 * indicator on the avatar (the bot isn't online yet — this is a future
 * preview), no decorative glow.
 */
export function BriefingChatPreview({
  bot,
  greeting,
  items,
  closer,
  emptyMessage,
  time = '7:30 AM',
  dayLabel = 'Tomorrow',
  className,
}: BriefingChatPreviewProps) {
  const showEmptyMessage = items.length === 0 && emptyMessage !== undefined;

  return (
    <div
      className={cn(
        'border-border bg-muted/20 flex h-full flex-col overflow-hidden rounded-lg border',
        className
      )}
    >
      <div className="flex flex-1 flex-col gap-4 px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="bg-border h-px flex-1" aria-hidden />
          <span className="text-muted-foreground flex items-baseline gap-1.5 text-xs">
            <span>{dayLabel}</span>
            <span className="text-muted-foreground/60" aria-hidden>
              ·
            </span>
            <span className="font-mono">{time}</span>
          </span>
          <div className="bg-border h-px flex-1" aria-hidden />
        </div>

        <div className="flex items-start gap-3">
          <div
            aria-hidden
            className="border-border bg-secondary flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-xl leading-none"
          >
            {bot.botEmoji}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-foreground text-sm font-semibold tracking-tight">
              {bot.botName || 'Your bot'}
            </span>

            <div className="bg-secondary flex flex-col gap-2.5 rounded-lg rounded-tl-sm px-4 py-3">
              {greeting && <p className="text-foreground text-sm leading-relaxed">{greeting}</p>}

              {showEmptyMessage ? (
                <p className="text-muted-foreground text-sm leading-relaxed italic">
                  {emptyMessage}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {items.map((item, index) => (
                    <li
                      key={index}
                      className="text-foreground/95 flex items-start gap-2.5 text-sm leading-relaxed"
                    >
                      <span
                        className="text-muted-foreground mt-1.5 shrink-0 leading-none select-none"
                        aria-hidden
                      >
                        •
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}

              {closer && (
                <p className="text-muted-foreground text-xs leading-relaxed italic">{closer}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
