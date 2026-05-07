import { z } from 'zod';

export const instanceLifecycleEventSchema = z.enum(['ready', 'start_failed']);
export type InstanceLifecycleEvent = z.infer<typeof instanceLifecycleEventSchema>;

export const scheduledActionEventSchema = z.enum([
  'scheduled_restart_notice',
  'scheduled_restart_cancelled',
  'scheduled_version_change_notice',
  'scheduled_version_change_cancelled',
]);
export type ScheduledActionEvent = z.infer<typeof scheduledActionEventSchema>;
