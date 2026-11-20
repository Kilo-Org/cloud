import { appendFile } from 'node:fs/promises';

export default {
  id: 'cloud-wakeup-contract',
  async setup(ctx) {
    const record = (kind, value) =>
      appendFile(ctx.options.recordPath, `${JSON.stringify({ kind, value })}\n`);
    const events = ctx.event.subscribe();
    void (async () => {
      for await (const event of events) {
        if (event.type === 'rpc.opencode.goal.changed') {
          await record('goal', {
            sessionID: event.data.sessionID,
            status: event.data.goal?.status ?? null,
            reason: event.data.goal?.reason,
          });
        }
      }
    })().catch(() => undefined);

    await ctx.tool.transform(tools => {
      for (const name of ['schedule_wakeup', 'cancel_wakeup']) {
        tools.update(name, tool => {
          tool.description = `Cloud contract replacement for ${name}`;
          tool.options = { ...tool.options, codemode: false };
          tool.input = tool.input.mapFields(fields =>
            name === 'schedule_wakeup'
              ? { delay: fields.delay, prompt: fields.prompt }
              : { id: fields.id }
          );
          tool.execute = async (args, context) => {
            const { sessionID } = context;
            await record('call', { name, sessionID, args });
            const session = await ctx.session.get({ sessionID });
            if (session.parentID) throw new Error('Cloud wakeups require a root chat');
            if (name === 'schedule_wakeup') {
              await ctx.session.instructions.entry.put({
                sessionID,
                key: 'cloud-wakeup',
                value: `Pending cloud-wakeup. Mode: stay awake. Prompt: ${args.prompt}`,
              });
            } else {
              await ctx.session.instructions.entry.remove({ sessionID, key: 'cloud-wakeup' });
            }
            const output = `Fixture executed ${name}`;
            return { output, content: output };
          };
        });
      }
    });
    await record('setup', true);
  },
};
