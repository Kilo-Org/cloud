/**
 * Shared helpers for the admin scheduled-action form surfaces.
 *
 * The Scheduler tab, the bulk Change Version dialog, and the per-instance
 * Change Version dialog all use the same default-now-plus-five-minutes
 * datetime-local seed. Centralizing it keeps the seed consistent and
 * gives one place to tune the floor if we ever change the minimum lead
 * time.
 */

/**
 * Default value for a `<input type="datetime-local">` seed. Returns now
 * plus five minutes formatted as `YYYY-MM-DDTHH:mm` in the caller's
 * local timezone (datetime-local has no zone, so the browser interprets
 * the string as local). The five-minute lead matches the backend's
 * one-minute floor with a comfortable cushion for the admin to review
 * before submitting.
 */
export function defaultScheduledAt(): string {
  const d = new Date(Date.now() + 5 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * v1 channel set — what the schedule dialogs render as checkboxes and
 * what `scheduleAction` accepts in `noticeChannels`. The 'agent' channel
 * is intentionally excluded (the v1 dispatcher 501s; surfacing it in
 * the picker would mislead admins).
 */
export const NOTICE_CHANNELS = ['email', 'webapp', 'mobile_push'] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

export const NOTICE_CHANNEL_LABELS: Record<NoticeChannel, string> = {
  email: 'Email',
  webapp: 'In-app banner',
  mobile_push: 'Mobile push',
};

/** Default form state for the notification block, matching backend defaults. */
export type NotifyFormState = {
  notify: boolean;
  noticeLeadHours: number;
  noticeSubject: string;
  noticeBody: string;
  noticeChannels: NoticeChannel[];
};

export function defaultNotifyFormState(): NotifyFormState {
  return {
    notify: true,
    noticeLeadHours: 24,
    noticeSubject: '',
    noticeBody: '',
    noticeChannels: [...NOTICE_CHANNELS],
  };
}
