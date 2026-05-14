'use client';

/**
 * Inline notification controls for the scheduled-action create dialogs.
 *
 * Rendered on the Scheduled tab of the per-instance Change Version
 * dialog, the bulk Change Version dialog, and the Scheduler tab forms.
 * The fields are visible by default — the underlying behavior is to
 * notify, and admins should see exactly what users will receive before
 * clicking Schedule.
 *
 * Surfaces:
 *   - notify checkbox (default ON)
 *   - lead-hours numeric input (range 0..168, default 24)
 *   - channel checkboxes (all selected by default)
 *   - optional admin-authored subject + body
 *
 * When notify is unchecked the dependent fields visually fade and stop
 * mattering — the backend ignores them when notify=false.
 */

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  NOTICE_CHANNELS,
  NOTICE_CHANNEL_LABELS,
  type NoticeChannel,
  type NotifyFormState,
} from '@/lib/kiloclaw/scheduled-action-form';

type Props = {
  /** Unique prefix so multiple instances on the same page have stable ids. */
  idPrefix: string;
  state: NotifyFormState;
  onChange: (next: NotifyFormState) => void;
  disabled?: boolean;
};

export function ScheduleNotifyFields({ idPrefix, state, onChange, disabled }: Props) {
  const notifyId = `${idPrefix}-notify`;
  const leadId = `${idPrefix}-notice-lead-hours`;
  const subjectId = `${idPrefix}-notice-subject`;
  const bodyId = `${idPrefix}-notice-body`;
  const dim = !state.notify;

  const toggleChannel = (channel: NoticeChannel, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...state.noticeChannels, channel]))
      : state.noticeChannels.filter(c => c !== channel);
    // Block deselecting the last channel; the backend rejects an empty
    // array and admins can always uncheck `notify` to disable instead.
    if (next.length === 0) return;
    onChange({ ...state, noticeChannels: next });
  };

  return (
    <div className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-3">
      <div className="flex items-start gap-2">
        <Checkbox
          id={notifyId}
          checked={state.notify}
          onCheckedChange={checked => onChange({ ...state, notify: checked === true })}
          disabled={disabled}
        />
        <div className="flex-1 space-y-1">
          <Label htmlFor={notifyId} className="cursor-pointer">
            Notify users
          </Label>
          <p className="text-muted-foreground text-xs">
            Sends a heads-up before the action fires. Recommended for any customer instance. Uncheck
            for internal/dev instances with no real end user.
          </p>
        </div>
      </div>

      <div className={`space-y-3 ${dim ? 'pointer-events-none opacity-50' : ''}`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={leadId} className="text-xs">
              Lead time (hours)
            </Label>
            <Input
              id={leadId}
              type="number"
              min={0}
              max={168}
              step={1}
              value={state.noticeLeadHours}
              onChange={e =>
                onChange({
                  ...state,
                  noticeLeadHours: Math.max(0, Math.min(168, Number(e.target.value) || 0)),
                })
              }
              disabled={disabled || dim}
            />
            <p className="text-muted-foreground text-xs">
              Range 0–168. Notice fires when now() reaches scheduled time minus this many hours.
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Channels</Label>
            <div className="flex flex-col gap-1.5">
              {NOTICE_CHANNELS.map(channel => {
                const checked = state.noticeChannels.includes(channel);
                return (
                  <label
                    key={channel}
                    className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={c => toggleChannel(channel, c === true)}
                      disabled={disabled || dim}
                    />
                    {NOTICE_CHANNEL_LABELS[channel]}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor={subjectId} className="text-xs">
            Custom subject (optional)
          </Label>
          <Input
            id={subjectId}
            value={state.noticeSubject}
            onChange={e => onChange({ ...state, noticeSubject: e.target.value })}
            disabled={disabled || dim}
            maxLength={120}
            placeholder="Leave blank to use default subject"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={bodyId} className="text-xs">
            Admin message (optional)
          </Label>
          <Textarea
            id={bodyId}
            value={state.noticeBody}
            onChange={e => onChange({ ...state, noticeBody: e.target.value })}
            disabled={disabled || dim}
            maxLength={2000}
            rows={3}
            placeholder="Optional context appended to the email body."
          />
        </div>
      </div>
    </div>
  );
}
