import {
  CLOUD_WAKEUP_HOLD_MARGIN_MS,
  CLOUD_WAKEUP_MIN_SLEEP_MS,
  cloudWakeupSchema,
  type CloudWakeup,
} from '../../shared/cloud-wakeup.js';

const prefix = 'cloud-wakeup/';
const settledPrefix = 'cloud-wakeup-settled/';
const projectionRaceWindowMs = 60_000;
const projectionSchema = cloudWakeupSchema.pick({ id: true, dueAt: true, mode: true });

export function createSandboxWakeupPolicy(kv: DurableObjectStorage['kv']) {
  return {
    add(sessionId: string, wakeup: CloudWakeup) {
      const endedAt = kv.get<number>(`${settledPrefix}${wakeup.id}`);
      if (wakeup.state === 'pending' && endedAt === undefined)
        kv.put(`${prefix}${sessionId}`, projectionSchema.parse(wakeup));
    },
    end(sessionId: string, id: string) {
      const key = `${prefix}${sessionId}`;
      const now = Date.now();
      for (const [entry, endedAt] of kv.list<number>({ prefix: settledPrefix })) {
        if (endedAt + projectionRaceWindowMs <= now) kv.delete(entry);
      }
      kv.put(`${settledPrefix}${id}`, now);
      if (projectionSchema.safeParse(kv.get(key)).data?.id !== id) return;
      kv.delete(key);
    },
    read(now: number) {
      let holdUntil = 0;
      let earlyCapture = false;
      for (const [, data] of kv.list({ prefix })) {
        const wakeup = projectionSchema.safeParse(data).data;
        if (!wakeup) continue;
        if (wakeup.mode === 'stay-awake' && wakeup.dueAt + CLOUD_WAKEUP_HOLD_MARGIN_MS > now)
          holdUntil = Math.max(holdUntil, wakeup.dueAt + CLOUD_WAKEUP_HOLD_MARGIN_MS);
        if (wakeup.mode === 'sleep' && wakeup.dueAt - now >= CLOUD_WAKEUP_MIN_SLEEP_MS)
          earlyCapture = true;
      }
      return { holdUntil, earlyCapture: earlyCapture && holdUntil === 0 };
    },
  };
}
