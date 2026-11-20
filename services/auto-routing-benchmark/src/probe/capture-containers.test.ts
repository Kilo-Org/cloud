import { describe, expect, it } from 'vitest';
import { startCaptureContainers, type CaptureShell } from './capture-containers';

const params = {
  image: 'probe-capture:7.8.27',
  runner: 'probe-capture-runner',
  gateway: 'probe-capture-gateway',
  workDir: '/tmp/probe-capture',
  catalogFile: '/tmp/probe-capture/catalog.json',
  logFile: '/tmp/probe-capture/gateway.jsonl',
};

function recorder(failOn: (args: string[]) => boolean) {
  const calls: string[][] = [];
  const sh: CaptureShell = (_command, args) => {
    calls.push(args);
    if (failOn(args)) throw new Error(`docker ${args.join(' ')} failed (1)`);
    return {};
  };
  return { calls, sh };
}

describe('capture containers', () => {
  it('removes the runner when the gateway cannot start', () => {
    const { calls, sh } = recorder(args => args[0] === 'run' && args.includes(params.gateway));
    expect(() => startCaptureContainers({ ...params, sh })).toThrow(/docker run/);
    expect(calls.at(-1)).toEqual(['rm', '-f', params.runner, params.gateway]);
  });

  it('removes the runner when its setup exec fails', () => {
    const { calls, sh } = recorder(args => args[0] === 'exec');
    expect(() => startCaptureContainers({ ...params, sh })).toThrow(/docker exec/);
    expect(calls.at(-1)).toEqual(['rm', '-f', params.runner, params.gateway]);
  });

  it('leaves both containers to the caller once they are up', () => {
    const { calls, sh } = recorder(() => false);
    startCaptureContainers({ ...params, sh });
    expect(calls.map(args => args[0])).toEqual(['rm', 'run', 'exec', 'run']);
  });
});
