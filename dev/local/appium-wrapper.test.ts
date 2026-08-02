import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

function executable(file: string, contents: string): void {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

const { portsFor, slugFor } = await import('../../apps/mobile/e2e/wdio/ports.js');

test('appium port assignment is deterministic and block-shaped', () => {
  const first = portsFor('A1B2C3D4-0000-0000-0000-000000000000');
  assert.deepEqual(first, portsFor('A1B2C3D4-0000-0000-0000-000000000000'));

  // Server, WDA, and system ports stay inside the device's own block of 10,
  // in valid unprivileged-port territory; the wrapper bumps whole blocks when
  // one is occupied, so hash collisions never cross-talk.
  assert.equal(first.wda, first.server + 1);
  assert.equal(first.system, first.server + 2);
  assert.ok(first.server >= 4730 && first.server <= 9730);
  assert.ok(first.system < first.server + 10);
});

test('appium device slug is filesystem- and tmux-safe', () => {
  assert.equal(
    slugFor('A1B2C3D4-0000-0000-0000-000000000000'),
    'A1B2C3D4-0000-0000-0000-000000000000'
  );
  assert.equal(slugFor('emulator-5554'), 'emulator-5554');
  assert.equal(slugFor('192.168.1.10:5555'), '192-168-1-10-5555');
});

test('appium wrapper rejects a missing device and unknown commands', () => {
  const noArgs = spawnSync('apps/mobile/e2e/appium.sh', [], { encoding: 'utf8' });
  assert.notEqual(noArgs.status, 0);
  assert.match(noArgs.stderr, /usage: appium\.sh/);

  const unknown = spawnSync('apps/mobile/e2e/appium.sh', ['some-device', 'bogus'], {
    encoding: 'utf8',
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /usage: appium\.sh/);
});

test('record.sh passes bash -n syntax check', () => {
  const result = spawnSync('bash', ['-n', path.join(repoRoot, 'apps/mobile/e2e/record.sh')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

function makeXcrunStub(bin: string, signalLog: string, videoData: string): void {
  const escapedData = videoData.replace(/'/g, "\\'");
  const script =
    '#!/usr/bin/env node\n' +
    "const fs = require('fs');\n" +
    "const path = require('path');\n" +
    'const args = process.argv.slice(2);\n' +
    "const log = process.env.SIGNAL_LOG || '/dev/null';\n" +
    "const videoData = process.env.VIDEO_DATA || '" +
    escapedData +
    "';\n" +
    "if (args[0] === 'simctl' && args[1] === 'io' && args[3] === 'recordVideo') {\n" +
    '  const videoPath = args[args.length - 1];\n' +
    '  fs.mkdirSync(path.dirname(videoPath), { recursive: true });\n' +
    "  process.on('SIGINT', () => { fs.appendFileSync(log, 'INT\\n'); fs.writeFileSync(videoPath, videoData); process.exit(0); });\n" +
    "  process.on('SIGTERM', () => { fs.appendFileSync(log, 'TERM\\n'); process.exit(0); });\n" +
    '  setInterval(() => {}, 1000);\n' +
    '} else {\n' +
    '  process.exit(0);\n' +
    '}\n';
  executable(path.join(bin, 'xcrun'), script);
}

function makeFfmpegStub(bin: string): void {
  executable(
    path.join(bin, 'ffmpeg'),
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const i = args.indexOf('-i');
const ss = args.indexOf('-ss');
const y = args.indexOf('-y');
const input = args[i + 1];
const ts = args[ss + 1];
const out = args[y + 1];
fs.writeFileSync(out, 'frame:' + input + ':' + ts);
process.exit(0);
`
  );
}

function makeAdbStub(bin: string, remoteDir: string): void {
  const escapedDir = remoteDir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const script =
    '#!/usr/bin/env node\n' +
    "const fs = require('fs');\n" +
    "const path = require('path');\n" +
    "const stateDir = process.env.RECORD_ADB_STATE || '" +
    escapedDir +
    "';\n" +
    "const pidFile = path.join(stateDir, 'pid');\n" +
    "const remoteFile = path.join(stateDir, 'remote.mp4');\n" +
    "const signalLog = process.env.SIGNAL_LOG || '/dev/null';\n" +
    "const videoData = process.env.VIDEO_DATA || 'androiddata';\n" +
    'fs.mkdirSync(stateDir, { recursive: true });\n' +
    'const args = process.argv.slice(2);\n' +
    "const cmd = args.join(' ');\n" +
    "if (cmd.includes('shell screenrecord')) {\n" +
    '  fs.writeFileSync(pidFile, String(process.pid));\n' +
    "  process.on('SIGINT', () => { fs.writeFileSync(remoteFile, videoData); fs.rmSync(pidFile, { force: true }); process.exit(0); });\n" +
    '  setInterval(() => {}, 1000);\n' +
    "} else if (cmd.includes('pkill -INT screenrecord')) {\n" +
    '  if (fs.existsSync(pidFile)) {\n' +
    "    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGINT'); fs.appendFileSync(signalLog, 'INT(device)\\n'); } catch {}\n" +
    '  }\n' +
    '  process.exit(0);\n' +
    "} else if (cmd.includes('pidof screenrecord')) {\n" +
    '  if (fs.existsSync(pidFile)) {\n' +
    "    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); } catch { fs.rmSync(pidFile, { force: true }); }\n" +
    '  }\n' +
    "  if (fs.existsSync(pidFile)) console.log(fs.readFileSync(pidFile, 'utf8'));\n" +
    '  process.exit(0);\n' +
    "} else if (cmd.includes('pull')) {\n" +
    '  const hostPath = args[args.length - 1];\n' +
    '  if (fs.existsSync(remoteFile)) fs.copyFileSync(remoteFile, hostPath);\n' +
    '  process.exit(0);\n' +
    '} else {\n' +
    '  process.exit(0);\n' +
    '}\n';
  executable(path.join(bin, 'adb'), script);
}

test('record.sh iOS start/stop finalizes a non-empty video and cleans state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-ios-test-'));
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const signalLog = path.join(root, 'signals.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  makeXcrunStub(bin, signalLog, 'h264data');
  const video = path.join(tmp, 'video.mp4');
  const minimalPath = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const env = {
    ...process.env,
    PATH: minimalPath,
    TMPDIR: tmp,
    SIGNAL_LOG: signalLog,
    VIDEO_DATA: 'h264data',
  };
  try {
    const start = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['UDID-123', 'start', video],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.equal(start.status, 0, start.stderr);
    assert.ok(fs.existsSync(path.join(tmp, 'kilo-e2e-record', 'UDID-123', 'state')));
    const second = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['UDID-123', 'start', video],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already recording/);

    const stop = spawnSync(path.join(repoRoot, 'apps/mobile/e2e/record.sh'), ['UDID-123', 'stop'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.stdout.trim(), `${video} 8`);
    assert.equal(fs.readFileSync(video, 'utf8'), 'h264data');
    assert.ok(!fs.existsSync(path.join(tmp, 'kilo-e2e-record', 'UDID-123')));
    const signals = fs.readFileSync(signalLog, 'utf8');
    assert.ok(signals.includes('INT'));
    assert.ok(!signals.includes('TERM'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record.sh Android start/stop finalizes a non-empty video and cleans state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-android-test-'));
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const adbState = path.join(root, 'adb-state');
  const signalLog = path.join(root, 'signals.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  makeAdbStub(bin, adbState);
  const video = path.join(tmp, 'video.mp4');
  const minimalPath = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const env = {
    ...process.env,
    PATH: minimalPath,
    TMPDIR: tmp,
    RECORD_ADB_STATE: adbState,
    SIGNAL_LOG: signalLog,
    VIDEO_DATA: 'androiddata',
  };
  try {
    const start = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['emulator-5554', 'start', video],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.equal(start.status, 0, start.stderr);
    assert.ok(fs.existsSync(path.join(tmp, 'kilo-e2e-record', 'emulator-5554', 'state')));
    const stop = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['emulator-5554', 'stop'],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.stdout.trim(), `${video} 11`);
    assert.equal(fs.readFileSync(video, 'utf8'), 'androiddata');
    assert.ok(!fs.existsSync(path.join(tmp, 'kilo-e2e-record', 'emulator-5554')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record.sh stop is a no-op when state is stale and video is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-stale-stop-'));
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(path.join(tmp, 'kilo-e2e-record', 'UDID-STALE'), { recursive: true });
  // Guaranteed-dead PID on Linux and macOS (pid 1 is init and kill -0 succeeds).
  // State values are base64-encoded (see record.sh write_state).
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  fs.writeFileSync(
    path.join(tmp, 'kilo-e2e-record', 'UDID-STALE', 'state'),
    `platform=${b64('ios')}\npid=${b64('999999')}\npath=${b64(path.join(tmp, 'missing.mp4'))}\n`
  );
  try {
    const stop = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['UDID-STALE', 'stop'],
      {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp },
      }
    );
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(!fs.existsSync(path.join(tmp, 'kilo-e2e-record', 'UDID-STALE')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record.sh stop fails when a live recorder exits without a video', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-empty-live-'));
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  // Stub exits on SIGINT without writing the video file.
  makeXcrunStub(bin, path.join(root, 'signals.log'), '');
  // Override to write empty / nothing: replace VIDEO_DATA with empty and
  // patch behavior via env — use a custom stub that deletes any path on INT.
  executable(
    path.join(bin, 'xcrun'),
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'simctl' && args[1] === 'io' && args[3] === 'recordVideo') {
  const videoPath = args[args.length - 1];
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  process.on('SIGINT', () => { try { fs.unlinkSync(videoPath); } catch {} process.exit(0); });
  setInterval(() => {}, 1000);
} else process.exit(0);
`
  );
  const video = path.join(tmp, 'video.mp4');
  const env = {
    ...process.env,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: tmp,
  };
  try {
    const start = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['UDID-E', 'start', video],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.equal(start.status, 0, start.stderr);
    const stop = spawnSync(path.join(repoRoot, 'apps/mobile/e2e/record.sh'), ['UDID-E', 'stop'], {
      encoding: 'utf8',
      env,
    });
    assert.notEqual(stop.status, 0);
    assert.match(stop.stderr, /no finalized video/);
    // State retained so a retry is possible.
    assert.ok(fs.existsSync(path.join(tmp, 'kilo-e2e-record', 'UDID-E', 'state')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record.sh start recovers from corrupt prior state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-corrupt-start-'));
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const signalLog = path.join(root, 'signals.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  makeXcrunStub(bin, signalLog, 'h264data');
  fs.mkdirSync(path.join(tmp, 'kilo-e2e-record', 'UDID-C'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'kilo-e2e-record', 'UDID-C', 'state'),
    'platform=not-valid-base64!!!\n'
  );
  const video = path.join(tmp, 'video.mp4');
  const env = {
    ...process.env,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: tmp,
    SIGNAL_LOG: signalLog,
    VIDEO_DATA: 'h264data',
  };
  try {
    const start = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['UDID-C', 'start', video],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.equal(start.status, 0, start.stderr);
    const stop = spawnSync(path.join(repoRoot, 'apps/mobile/e2e/record.sh'), ['UDID-C', 'stop'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(fs.readFileSync(video, 'utf8'), 'h264data');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record.sh frame invokes ffmpeg input-first and extracts a frame', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-frame-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  makeFfmpegStub(bin);
  const video = path.join(root, 'video.mp4');
  const out = path.join(root, 'frame.png');
  fs.writeFileSync(video, 'dummy');
  const minimalPath = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const env = { ...process.env, PATH: minimalPath };
  try {
    const result = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['frame', video, '00:01:23', out],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), `frame:${video}:00:01:23`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record.sh frame fails loudly when ffmpeg is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-record-frame-missing-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const video = path.join(root, 'video.mp4');
  const out = path.join(root, 'frame.png');
  fs.writeFileSync(video, 'dummy');
  const minimalPath = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const env = { ...process.env, PATH: minimalPath };
  try {
    const result = spawnSync(
      path.join(repoRoot, 'apps/mobile/e2e/record.sh'),
      ['frame', video, '00:00:01', out],
      {
        encoding: 'utf8',
        env,
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ffmpeg not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server.port is written before nohup spawn so failed-start cleanup has a port', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);

  // The port write must appear before the nohup command that spawns Appium.
  const portWriteIdx = ensureFn.indexOf('echo "$APPIUM_PORT" >"$STATE_DIR/server.port"');
  const nohupIdx = ensureFn.indexOf('nohup "$APPIUM_BIN"');
  assert.ok(portWriteIdx >= 0, 'server.port write must exist in ensure_server');
  assert.ok(nohupIdx >= 0, 'nohup spawn must exist in ensure_server');
  assert.ok(
    portWriteIdx < nohupIdx,
    'server.port must be written BEFORE nohup spawn so stop_server always has a port'
  );

  // Port is not written again on readiness success (pre-spawn is the sole write).
  const readinessSection = ensureFn.slice(nohupIdx);
  assert.doesNotMatch(
    readinessSection,
    /echo "\$APPIUM_PORT" >"\$STATE_DIR\/server\.port"/,
    'server.port should not be written again on readiness — pre-spawn is authoritative'
  );
});

test('stop_server does not require literal binary path for ownership', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const start = script.indexOf('stop_server()');
  const end = script.indexOf('\n}\n\ncmd=', start);
  const fn = script.slice(start, end) + '\n}';

  // Ownership is based on --port in the process command, not the binary path.
  // A pnpm shim (node …/node_modules/.bin/appium) does not contain $APPIUM_BIN.
  assert.doesNotMatch(fn, /grep -qF "\$APPIUM_BIN"/);
  assert.match(fn, /grep -qF -- "--port \$STOP_PORT"/);
  // When lsof can attribute the listener, a foreign PID overrides the kill.
  assert.match(fn, /SHOULD_KILL=0/);
  assert.match(fn, /SHOULD_KILL=1/);
  assert.match(fn, /lsof .*tcp:\$STOP_PORT/);
  assert.match(fn, /\$LISTENER" != "\$PID/);

  // ps must use -ww so macOS does not truncate the --port argument.
  assert.match(fn, /ps -ww -o command=.*"\$PID"/);
  // When lsof proves a foreign listener owns the port, keep state and return
  // nonzero (matching the survived-SIGKILL safety) instead of deleting the
  // handle and leaving an untracked process.
  const killBlock = fn.slice(fn.indexOf('if [ "$SHOULD_KILL" -eq 1 ]'));
  assert.match(killBlock, /else\n[^\n]*foreign listener[^\n]*\n[^\n]*return 1/);
});
