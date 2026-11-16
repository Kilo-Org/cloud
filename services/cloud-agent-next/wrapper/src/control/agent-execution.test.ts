import { describe, expect, it } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_GID, AGENT_UID } from '../../../src/shared/runtime-environment.js';

const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;

describe('Linux agent credential boundary', () => {
  it.skipIf(!linuxRoot)('closes directory descriptors when ownership transfer fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-ownership-failure-'));
    await chmod(directory, 0o777);
    const fixture = `
      import fs from 'node:fs/promises';
      import { initializeAgentExecution, writeAgentFile } from ${JSON.stringify(path.join(import.meta.dir, 'agent-execution.ts'))};
      await initializeAgentExecution();
      process.setgroups([]);
      process.setgid(65534);
      process.setuid(65534);
      const before = (await fs.readdir('/proc/self/fd')).length;
      const errors = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        try { await writeAgentFile(${JSON.stringify(directory)} + '/' + attempt + '/file', 'content'); }
        catch (error) { errors.push(error.code); }
      }
      const after = (await fs.readdir('/proc/self/fd')).length;
      console.log(JSON.stringify({ before, after, errors }));
    `;
    try {
      const child = Bun.spawn([process.execPath, '--eval', fixture], {
        env: { PATH: process.env.PATH },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
      const result = JSON.parse(stdout);
      expect(result.errors).toEqual(Array(8).fill('EPERM'));
      expect(result.after).toBe(result.before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!linuxRoot)(
    'denies wrapper credentials across all agent spawn paths',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-isolation-'));
      await chmod(directory, 0o755);
      const workspace = path.join(directory, 'workspace');
      const artifacts = path.join(directory, 'artifacts');
      const credential = path.join(directory, 'wrapper-credential');
      const privateDirectory = path.join(directory, 'wrapper-private');
      const setuid = path.join(directory, 'setuid-id');
      await mkdir(workspace);
      await mkdir(artifacts);
      await mkdir(privateDirectory, { mode: 0o700 });
      await writeFile(credential, 'synthetic-file-credential', { mode: 0o600 });
      await writeFile(path.join(privateDirectory, 'credential'), 'synthetic-private-credential');
      await copyFile('/usr/bin/id', setuid);
      await chmod(setuid, 0o4755);

      const probe = `
      const fs = require('node:fs');
      const { spawnSync } = require('node:child_process');
      const forbidden = JSON.parse(process.env.PROBE_FORBIDDEN);
      const denied = forbidden.map(file => {
        try { const fd = fs.openSync(file, 'r'); fs.closeSync(fd); return 'READABLE'; }
        catch (error) { return error.code; }
      });
      let regainRoot;
      try { process.setuid(0); regainRoot = 'ALLOWED'; } catch (error) { regainRoot = error.code; }
      const descendant = spawnSync('/bin/sh', ['-c', 'cat "$1" >/dev/null 2>&1', 'probe', forbidden[0]]);
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      fs.writeFileSync(process.env.PROBE_ARTIFACT, 'agent artifact', { mode: 0o600 });
      fs.writeFileSync(process.env.XDG_DATA_HOME + '/gh/extensions/toolchain-proof', 'writable');
      fs.readFileSync(process.env.XDG_DATA_HOME + '/kilo/auth.json');
      if (!fs.readFileSync(process.env.XDG_DATA_HOME + '/kilo/cloud-agent/git-credentials', 'utf8').includes('synthetic-git-alias')) throw new Error('Git aliases must be agent-readable');
      for (const file of JSON.parse(process.env.PROBE_READABLE)) fs.readFileSync(file);
      fs.writeFileSync(process.env.PROBE_RESTORED_DIRECTORY + '/agent-edit', 'writable');
      fs.rmSync(process.env.PROBE_RESTORED_DIRECTORY + '/agent-edit');
      console.log(JSON.stringify({
        uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), denied, regainRoot,
        descendantDenied: descendant.status !== 0,
        privileges: status.split('\\n').filter(line => /^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/.test(line)),
        setuidResult: spawnSync(process.env.PROBE_SETUID, ['-u'], { encoding: 'utf8' }).stdout.trim(),
        inheritedSecret: process.env.SANDBOX_CONTROL_CREDENTIAL ?? null,
      }));
    `;

      const fixture = `
      import fs from 'node:fs/promises';
      import { initializeAgentExecution, agentOwns, agentOwnsTree, writeAgentFile } from ${JSON.stringify(path.join(import.meta.dir, 'agent-execution.ts'))};
      import { runProcess } from ${JSON.stringify(path.join(import.meta.dir, '../utils.ts'))};
      import { createOwnedProcessScope } from ${JSON.stringify(path.join(import.meta.dir, 'owned-processes.ts'))};
      import { spawnGated, releaseGate } from ${JSON.stringify(path.join(import.meta.dir, 'gated-spawn.ts'))};
      import { spawnInCgroup } from ${JSON.stringify(path.join(import.meta.dir, 'setup-cgroup.ts'))};
      import { buildWorktreeKiloEnvironment } from ${JSON.stringify(path.join(import.meta.dir, 'worktree-runtime.ts'))};
      import { prepareKiloFilesystem } from ${JSON.stringify(path.join(import.meta.dir, '../control-plane/kilo-runtime.ts'))};
      import { writeGitCredentialRecords } from ${JSON.stringify(path.join(import.meta.dir, 'git-credentials.ts'))};
      import { materializeMessageAttachments } from ${JSON.stringify(path.join(import.meta.dir, '../session-bootstrap.ts'))};
      import { seedSessionIngestRegistration } from ${JSON.stringify(path.join(import.meta.dir, '../restore-session.ts'))};
      const workspace = ${JSON.stringify(workspace)};
      const artifacts = ${JSON.stringify(artifacts)};
      const fd = await fs.open(${JSON.stringify(credential)}, 'r');
      await initializeAgentExecution();
      await agentOwns(workspace);
      await agentOwns(artifacts);
      await fs.symlink(${JSON.stringify(credential)}, workspace + '/credential-link');
      await fs.symlink(${JSON.stringify(privateDirectory)}, workspace + '/redirect');
      await fs.link(${JSON.stringify(credential)}, workspace + '/credential-hardlink');
      let rejectedPaths = 0;
      for (const file of [workspace + '/credential-link', workspace + '/redirect/credential', workspace + '/credential-hardlink']) {
        try { await writeAgentFile(file, 'must not overwrite the wrapper credential'); }
        catch { rejectedPaths++; }
      }
      try { await agentOwnsTree(workspace + '/redirect'); } catch { rejectedPaths++; }
      const tree = workspace + '/tree';
      await fs.mkdir(tree + '/nested', { recursive: true });
      await fs.writeFile(tree + '/nested/wrapper-file', 'wrapper content');
      await fs.link(${JSON.stringify(credential)}, tree + '/nested/credential-hardlink');
      await fs.symlink(${JSON.stringify(credential)}, tree + '/credential-symlink');
      await agentOwnsTree(tree);
      const owner = async file => (await fs.lstat(file)).uid;
      const treeOwners = {
        directory: await owner(tree + '/nested'),
        file: await owner(tree + '/nested/wrapper-file'),
        credential: await owner(${JSON.stringify(credential)}),
        symlink: await owner(tree + '/credential-symlink'),
      };
      const forbidden = [
        '/proc/' + process.pid + '/environ', '/proc/' + process.pid + '/mem',
        '/proc/' + process.pid + '/fd/' + fd.fd,
        ${JSON.stringify(credential)}, ${JSON.stringify(path.join(privateDirectory, 'credential'))},
      ];
      const env = buildWorktreeKiloEnvironment(workspace, workspace, {
        scopeId: 'synthetic-scope', token: 'synthetic-runtime-handle',
        targets: { providerBaseUrl: 'https://provider.example', backendBaseUrl: 'https://backend.example', sessionIngestBaseUrl: 'https://ingest.example' },
      }, {
        PROBE_FORBIDDEN: JSON.stringify(forbidden), PROBE_ARTIFACT: artifacts + '/proof',
        PROBE_SETUID: ${JSON.stringify(setuid)},
      });
      const outputs = [];
      await prepareKiloFilesystem(env, workspace);
      await writeGitCredentialRecords({ home: workspace, credentials: [{ url: 'https://git.example.test/acme/repo.git', token: 'synthetic-git-alias' }] });
      const attachment = ${JSON.stringify(path.join(directory, 'attachments', 'session', 'user', 'message', 'diagram.png'))};
      const materialized = await materializeMessageAttachments(
        { id: 'msg_synthetic', prompt: 'Read the attachment', attachments: [{ filename: 'diagram.png', mime: 'image/png', signedUrl: 'https://attachments.example.test/diagram.png', localPath: attachment }] },
        { fetch: async () => new Response('synthetic attachment') }
      );
      if (!materialized.parts?.some(part => part.type === 'file')) throw new Error('Attachment was not materialized');
      await seedSessionIngestRegistration('synthetic_session', env);
      await writeAgentFile(workspace + '/restored/nested/file', 'restored content');
      env.PROBE_READABLE = JSON.stringify([
        attachment,
        env.XDG_DATA_HOME + '/kilo/storage/session_share/synthetic_session.json',
        workspace + '/restored/nested/file',
      ]);
      env.PROBE_RESTORED_DIRECTORY = workspace + '/restored/nested';
      const run = async (spawn) => {
        const result = await runProcess(process.execPath, ['--eval', ${JSON.stringify(probe)}], {
          cwd: workspace, env, inheritEnv: false, timeoutMs: 5000, ...(spawn ? { spawn } : {}),
        });
        if (result.exitCode !== 0) throw new Error(result.stderr);
        outputs.push(JSON.parse(result.stdout));
      };
      await run();
      await run((command, args, options) => {
        const child = spawnGated(command, args, { ...options, stdio: 'pipe' });
        releaseGate(child.stdin);
        child.stdin.end();
        return child;
      });
      const scope = createOwnedProcessScope();
      await scope.run(() => run());
      await scope.stop(Date.now() + 5000);
      const procs = await fs.open(${JSON.stringify(path.join(directory, 'fake-cgroup'))}, 'w+');
      await run((command, args, options) => spawnInCgroup({ procs: procs.fd, procsPath: '/dev/null' }, command, args, options));
      await procs.close();
      const git = async (args) => {
        const result = await runProcess('git', args, { cwd: workspace, env, inheritEnv: false });
        if (result.exitCode !== 0) throw new Error(result.stderr);
      };
      await git(['init', '-q']);
      await git(['config', 'user.name', 'Synthetic Agent']);
      await git(['config', 'user.email', 'agent@example.test']);
      await fs.writeFile(workspace + '/.git/hooks/pre-commit', '#!/bin/sh\\nid -u > hook-uid\\n', { mode: 0o755 });
      await git(['commit', '--allow-empty', '-m', 'verify unprivileged hook']);
      const hookUid = (await fs.readFile(workspace + '/hook-uid', 'utf8')).trim();
      console.log(JSON.stringify({ outputs, hookUid, rejectedPaths, treeOwners, artifact: await fs.readFile(artifacts + '/proof', 'utf8') }));
      await fd.close();
    `;
      try {
        const child = Bun.spawn([process.execPath, '--eval', fixture], {
          env: {
            PATH: process.env.PATH,
            SANDBOX_CONTROL_CREDENTIAL: 'synthetic-launch-credential',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
        const result = JSON.parse(stdout);
        expect(result.outputs).toHaveLength(4);
        for (const output of result.outputs) {
          expect(output.uid).toBe(AGENT_UID);
          expect(output.gid).toBe(AGENT_GID);
          expect(output.groups).not.toContain(0);
          expect(output.denied).toEqual(Array(5).fill('EACCES'));
          expect(output.regainRoot).toBe('EPERM');
          expect(output.descendantDenied).toBe(true);
          expect(output.setuidResult).toBe(String(AGENT_UID));
          expect(output.inheritedSecret).toBeNull();
          expect(output.privileges).toHaveLength(6);
          for (const privilege of output.privileges) {
            expect(privilege).toMatch(/:\s*(?:0+|1)$/);
            if (privilege.startsWith('NoNewPrivs')) expect(privilege).toMatch(/:\s*1$/);
            else expect(privilege).toMatch(/:\s*0+$/);
          }
        }
        expect(result.hookUid).toBe(String(AGENT_UID));
        expect(result.rejectedPaths).toBe(4);
        expect(result.treeOwners).toEqual({
          directory: AGENT_UID,
          file: AGENT_UID,
          credential: 0,
          symlink: 0,
        });
        expect(result.artifact).toBe('agent artifact');
        expect(await readFile(credential, 'utf8')).toBe('synthetic-file-credential');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000
  );
});
