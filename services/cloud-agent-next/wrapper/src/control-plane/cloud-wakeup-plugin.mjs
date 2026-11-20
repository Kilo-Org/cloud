export default {
  id: 'cloud-wakeup',
  async setup(ctx) {
    const { url, secret } = ctx.options;
    const activeGoals = new Set();
    const lifetime = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe()) {
        if (lifetime.signal.aborted) break;
        if (event.type !== 'rpc.opencode.goal.changed') continue;
        const { sessionID, goal } = event.data;
        if (goal?.status === 'active') activeGoals.add(sessionID);
        else activeGoals.delete(sessionID);
      }
    })().catch(() => undefined);

    await ctx.tool.transform(tools => {
      for (const name of ['schedule_wakeup', 'cancel_wakeup']) {
        tools.update(name, tool => {
          const schedule = name === 'schedule_wakeup';
          tool.description = schedule
            ? 'Schedule one future turn in this Cloud chat. Use a delay such as 10s, 15m, or 2h. Longer waits may save a workspace snapshot and stop the sandbox; files and chat state survive but running processes, terminals, and memory do not. Not supported in active goals.'
            : 'Cancel the pending wakeup in this Cloud chat by ID.';
          tool.options = { ...tool.options, codemode: false, permission: 'cloud-wakeup' };
          tool.input = tool.input.mapFields(fields =>
            schedule ? { delay: fields.delay, prompt: fields.prompt } : { id: fields.id }
          );
          tool.execute = async (args, context) => {
            const { sessionID, messageID, id, signal } = context;
            const session = await ctx.session.get({ sessionID });
            if (session.parentID) throw new Error('Cloud wakeups require a root chat.');
            if (schedule && activeGoals.has(sessionID))
              throw new Error('Cloud wakeups are not supported during an active goal.');
            const command = schedule
              ? {
                  action: 'schedule',
                  callId: `${messageID}:${id}`,
                  delay: args.delay,
                  prompt: args.prompt,
                }
              : { action: 'cancel', id: args.id };
            const response = await fetch(url, {
              method: 'POST',
              headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
              body: JSON.stringify({ sessionID, command }),
              signal,
            });
            const result = await response.json();
            if (!result.ok) throw new Error(result.error);
            const wakeup = result.wakeup;
            const due = new Date(wakeup.dueAt).toISOString();
            let output;
            if (!schedule) {
              await ctx.session.instructions.entry.remove({ sessionID, key: 'cloud-wakeup' });
              output = `Cancelled wakeup ${wakeup.id} (${due}).`;
            } else if (wakeup.state !== 'pending') {
              output = `Wakeup ${wakeup.id} is already ${wakeup.state}.`;
            } else {
              const mode = wakeup.mode === 'sleep' ? 'Sleep' : 'Stay awake';
              const notes =
                wakeup.mode === 'sleep'
                  ? 'A snapshot preserves files and chat state, not running processes, terminals, or memory. Active workspace work can prevent early stop.'
                  : 'Cloud will keep the sandbox awake for this wakeup.';
              const remainingSeconds = Math.max(1, Math.ceil((wakeup.dueAt - Date.now()) / 1000));
              await ctx.session.instructions.entry.put({
                sessionID,
                key: 'cloud-wakeup',
                value: `${wakeup.id}: due ${due}. Mode: ${mode}. ${notes}\nWhen it fires this session resumes with: ${wakeup.prompt}`,
              });
              output = `Scheduled wakeup ${wakeup.id}, due ${due} (in ${remainingSeconds}s).\nWhen it fires this session resumes with: ${wakeup.prompt}`;
              if (wakeup.mode === 'sleep') output += `\n\n${notes}`;
            }
            return { output, content: output };
          };
        });
      }
    });
    return () => lifetime.abort();
  },
};
