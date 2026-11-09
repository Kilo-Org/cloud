import { describe, expect, it } from 'bun:test';
import { activityFixture } from './kilo-activity-fixture.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

suite('human-required permissions with pinned Kilo', () => {
  for (const response of ['once', 'reject'] as const) {
    it(`${response} settles the real skill shell permission`, async () => {
      if (!binary) throw new Error('KILO_781_BINARY is required');
      const f = await activityFixture(binary, {
        skillMarkdown:
          '---\nname: native-human-permission\ndescription: Harmless permission fixture\n---\n!`printf native-skill-shell-approved`\n',
      });
      try {
        const sessionID = await f.session();
        let requested = false;
        f.respond(async () => {
          if (requested) return { text: 'permission-complete' };
          requested = true;
          return { tools: [{ name: 'skill', arguments: { name: 'native-human-permission' } }] };
        });
        await f.prompt(sessionID);
        const pending = await f.until(
          () => f.client.permission.list({ directory: f.directory }, { signal: f.signal }),
          result =>
            result.data?.some(permission => permission.metadata.skillShell === true) === true,
          'real skill shell permission'
        );
        const permission = pending.data?.find(
          permission => permission.metadata.skillShell === true
        );
        if (!permission) throw new Error('Missing skill shell permission');
        expect(permission.sessionID).toBe(sessionID);
        expect(
          await f.wrapper.answerPermission(permission.id, 'once', undefined, undefined, f.directory)
        ).toBe(true);
        const refused = await f.client.permission.list(
          { directory: f.directory },
          { signal: f.signal }
        );
        expect(refused.data?.some(item => item.id === permission.id)).toBe(true);
        expect(
          await f.wrapper.answerPermission(permission.id, response, undefined, true, f.directory)
        ).toBe(true);
        await f.until(
          () =>
            f.client.session.messages({ sessionID, directory: f.directory }, { signal: f.signal }),
          result =>
            result.data?.some(message =>
              message.parts.some(part =>
                response === 'once'
                  ? part.type === 'text' && part.text === 'permission-complete'
                  : part.type === 'tool' && part.tool === 'skill' && part.state.status === 'error'
              )
            ) === true,
          'native completion after human reply'
        );
        await f.idle(sessionID);
        const history = await f.client.session.messages(
          { sessionID, directory: f.directory },
          { signal: f.signal }
        );
        const tool = history.data
          ?.flatMap(message => message.parts)
          .find(part => part.type === 'tool' && part.tool === 'skill');
        if (tool?.type !== 'tool') throw new Error('Missing real skill tool');
        expect(tool.state.status).toBe(response === 'once' ? 'completed' : 'error');
        if (tool.state.status === 'completed')
          expect(tool.state.output).toContain('native-skill-shell-approved');
        const remaining = await f.client.permission.list(
          { directory: f.directory },
          { signal: f.signal }
        );
        expect(remaining.data?.some(item => item.id === permission.id)).toBe(false);
      } finally {
        await f.dispose();
      }
    }, 60_000);
  }
});
