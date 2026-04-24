export type BackgroundTask = Promise<unknown> | (() => unknown);

export type BackgroundScheduler = (task: BackgroundTask) => void;

export const runDetached: BackgroundScheduler = task => {
  const run = typeof task === 'function' ? task : () => task;
  queueMicrotask(() => {
    void Promise.resolve().then(run);
  });
};

export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
};
