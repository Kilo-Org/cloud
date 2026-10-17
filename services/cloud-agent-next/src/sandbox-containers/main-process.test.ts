import { describe, expect, it } from 'vitest';
import { CONTROL_SUPERVISOR_PATH } from '../sandbox-control/container-paths.js';
import {
  CONTROL_DIAGNOSTIC_STRING_CHARSET,
  CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH,
} from '../sandbox-control/diagnostics.js';
import {
  classifyMainProcess,
  mainProcessObservationFields,
  observeCmdline,
} from './main-process.js';

const encode = (value: string) => new TextEncoder().encode(value);

describe('supplied PID 1 identity', () => {
  const command = { argv: ['/bin/sh', '-c', 'exec /opt/selected/start'] };

  it('requires the exact supplied argv, including argument boundaries', () => {
    expect(classifyMainProcess(encode(`${command.argv.join('\0')}\0`), command)).toBe('startup');
    expect(classifyMainProcess(encode(command.argv.join(' ')), command)).toBe('ambiguous');
    expect(classifyMainProcess(encode(`${command.argv.join('\0')}\0extra`), command)).toBe(
      'ambiguous'
    );
  });

  it('also accepts the stable supervisor after exec', () => {
    expect(classifyMainProcess(encode(`/bin/sh\0${CONTROL_SUPERVISOR_PATH}\0`), command)).toBe(
      'supervisor'
    );
    expect(classifyMainProcess(encode('sleep\0infinity\0'), command)).toBe('sleep');
  });
});

describe('mainProcessObservationFields', () => {
  it('reports that no read completed', () => {
    expect(mainProcessObservationFields(null)).toEqual({ lastSeen: 'none' });
  });

  it('reports a recognised cmdline as a log-safe string with its byte length', () => {
    const cmdline = encode(`/bin/sh\0${CONTROL_SUPERVISOR_PATH}\0`);
    expect(mainProcessObservationFields(observeCmdline(cmdline))).toEqual({
      lastSeen: 'cmdline',
      lastIdentity: 'supervisor',
      lastCmdline: `_bin_sh_${CONTROL_SUPERVISOR_PATH.replaceAll('/', '_')}`,
      lastCmdlineBytes: cmdline.byteLength,
    });
  });

  it('bounds an unrecognised cmdline to what a control diagnostic keeps', () => {
    const fields = mainProcessObservationFields(observeCmdline(encode(`node\0${'x'.repeat(300)}`)));
    expect(fields).toMatchObject({ lastSeen: 'cmdline', lastIdentity: 'ambiguous' });
    const cmdline = fields.lastCmdline as string;
    expect(cmdline.length).toBeLessThanOrEqual(CONTROL_DIAGNOSTIC_STRING_MAX_LENGTH);
    expect(cmdline).toMatch(CONTROL_DIAGNOSTIC_STRING_CHARSET);
    expect(cmdline.startsWith('node_x')).toBe(true);
  });

  it('names an empty cmdline instead of emitting an empty string', () => {
    expect(mainProcessObservationFields(observeCmdline(new Uint8Array()))).toMatchObject({
      lastIdentity: 'ambiguous',
      lastCmdline: 'empty',
      lastCmdlineBytes: 0,
    });
  });

  it('reports a failed read by exit code or by error', () => {
    expect(
      mainProcessObservationFields({ kind: 'exit_code', identity: 'ambiguous', exitCode: 1 })
    ).toEqual({ lastSeen: 'exit_code', lastIdentity: 'ambiguous', lastExitCode: 1 });
    expect(
      mainProcessObservationFields({
        kind: 'error',
        identity: 'ambiguous',
        error: new TypeError('exec failed: no such container'),
      })
    ).toEqual({
      lastSeen: 'error',
      lastIdentity: 'ambiguous',
      lastErrorName: 'TypeError',
      lastCause: 'exec_failed:_no_such_container',
    });
  });
});
