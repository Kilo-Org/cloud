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
  // When lsof proves a foreign listener owns the port outside start-loop cleanup
  // (SHOULD_KILL=0), record the conflict in server.conflicts, clear active state
  // files, and return 0 so the port bump continues. Survived SIGKILL preserves
  // state and returns 1. The start-loop's APPIUM_CLEANUP_OWNED=1 context
  // overrides: the PID is provably ours and the loop must continue.
  const killBlock = fn.slice(fn.indexOf('if [ "$SHOULD_KILL" -eq 1 ]'));
  assert.match(killBlock, /else\n.*foreign listener.*\n.*server\.conflicts/s);
  assert.match(killBlock, /else\n.*foreign listener.*\n.*rm -f.*appium\.pid/s);
  assert.match(killBlock, /else\n.*foreign listener.*\n.*return 0/s);
  // Survived SIGKILL must still return 1.
  assert.match(killBlock, /survived SIGKILL.*\n.*return 1/s);
  assert.match(fn, /APPIUM_CLEANUP_OWNED/);
  assert.match(fn, /our just-spawned pid/);
  assert.match(fn, /cleaning up/);
});

test('start-loop stop_server call sets APPIUM_CLEANUP_OWNED so foreign-listener cleanup does not abort', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);

  // The start loop's cleanup must set APPIUM_CLEANUP_OWNED=1 so that
  // stop_server kills our just-spawned PID (not the foreign listener) and
  // continues to the next port block instead of returning non-zero.
  assert.match(ensureFn, /APPIUM_CLEANUP_OWNED=1 stop_server/);

  // ensure_server contains three stop_server calls: two in the adoption block
  // (protection against stale/recycled PIDs) and one in the start-loop cleanup
  // (with APPIUM_CLEANUP_OWNED=1, correct for just-spawned PID).
  const stopCalls = [...ensureFn.matchAll(/\bstop_server\b/g)];
  assert.equal(stopCalls.length, 3, 'ensure_server must have exactly three stop_server calls');

  // Adoption-block stop_server calls must handle nonzero returns (|| true) so
  // a foreign listener or a survived-SIGKILL stale PID does not abort the
  // entire ensure_server under set -e. They must never set
  // APPIUM_CLEANUP_OWNED=1 because those PIDs are not provably ours.
  const adoptionStopCalls = [...ensureFn.matchAll(/stop_server \|\| true/g)];
  assert.equal(
    adoptionStopCalls.length,
    2,
    'adoption-block stop_server calls must use || true to handle nonzero returns'
  );

  // The owned-child call must NOT use || true — it must propagate failure
  // so the start loop can retry the next port block.
  const ownedStopCalls = [
    ...ensureFn.matchAll(/APPIUM_CLEANUP_OWNED=1 stop_server\b(?! \|\| true)/g),
  ];
  assert.equal(
    ownedStopCalls.length,
    1,
    'start-loop stop_server call must set APPIUM_CLEANUP_OWNED=1 and must NOT use || true'
  );
});

test('adoption-block stop_server || true calls are followed by conflict-state guards', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);

  // After each adoption-block stop_server || true there must be a guard that
  // checks for preserved state files and returns 1, preventing the start loop
  // from overwriting a conflict record.
  const guardPattern = /stop_server \|\| true\n\s*if \[ -f "\$STATE_DIR\/appium\.pid" \]; then/;
  const guards = [...ensureFn.matchAll(new RegExp(guardPattern.source, 'g'))];
  assert.equal(
    guards.length,
    2,
    'both adoption-block stop_server || true calls must be followed by conflict-state guards'
  );

  // Each guard must return 1 (not fall through to start loop).
  const guardReturns = [...ensureFn.matchAll(/refusing to overwrite[^\n]*\n\s*return 1/g)];
  assert.equal(guardReturns.length, 2, 'each guard must return 1');
});

test('start-loop APPIUM_CLEANUP_OWNED=1 stop_server is unguarded so port-bump continues', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);

  // Find the APPIUM_CLEANUP_OWNED=1 stop_server call position.
  const ownedCallIdx = ensureFn.indexOf('APPIUM_CLEANUP_OWNED=1 stop_server');
  assert.ok(ownedCallIdx >= 0, 'APPIUM_CLEANUP_OWNED=1 stop_server must exist');

  // The text after that call (up to 2 lines) must NOT contain a conflict guard.
  const afterOwned = ensureFn.slice(ownedCallIdx, ownedCallIdx + 200);
  assert.doesNotMatch(
    afterOwned,
    /refusing to overwrite/,
    'start-loop stop_server must NOT have a conflict guard — port-bump recovery must proceed'
  );
});

test('stop_server foreign listener returns 0 (clears state, records conflict) while survived SIGKILL returns 1 (keeps state)', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const start = script.indexOf('stop_server()');
  const end = script.indexOf('\n}\n\ncmd=', start);
  const fn = script.slice(start, end) + '\n}';

  // Foreign listener (SHOULD_KILL=0): conflict recorded, state cleared, return 0.
  const foreignBlock = fn.slice(fn.indexOf('else\n') + 5, fn.indexOf('return 0'));
  assert.match(foreignBlock, /foreign listener/);
  assert.match(foreignBlock, /server\.conflicts/);
  assert.match(foreignBlock, /rm -f.*appium\.pid.*server\.port/);

  // Survived SIGKILL (inside SHOULD_KILL=1): state preserved, return 1.
  const survivedBlock = fn.slice(fn.indexOf('survived SIGKILL'));
  assert.match(survivedBlock, /keeping server state/);
  assert.match(survivedBlock, /return 1/);

  // The survived-SIGKILL return must appear BEFORE the foreign-listener else
  // block's return, verifying they are distinct code paths.
  const survivedIdx = fn.indexOf('survived SIGKILL');
  const foreignReturnIdx = fn.lastIndexOf('return 0');
  assert.ok(
    survivedIdx < foreignReturnIdx,
    'survived-SIGKILL return must appear before foreign-listener return 0'
  );
});

test('conflict file is appended to, never overwritten, and survives ensure_server cycles', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');

  // Conflict file is written with >> (append), never with > (overwrite).
  const stopServerStart = script.indexOf('stop_server()');
  const stopServerEnd = script.indexOf('\n}\n\ncmd=', stopServerStart);
  const stopFn = script.slice(stopServerStart, stopServerEnd) + '\n}';
  const conflictWrites = [...stopFn.matchAll(/server\.conflicts/g)];
  assert.ok(conflictWrites.length >= 1, 'stop_server must write to server.conflicts');
  const conflictAppend = [...stopFn.matchAll(/>>"\$STATE_DIR\/server\.conflicts"/g)];
  assert.ok(conflictAppend.length >= 1, 'conflict file must use >> (append), never > (overwrite)');

  // Also in ensure_server adoption probe.
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);
  const ensureConflictAppend = [...ensureFn.matchAll(/>>"\$STATE_DIR\/server\.conflicts"/g)];
  assert.equal(
    ensureConflictAppend.length,
    1,
    'ensure_server adoption probe must also append to server.conflicts'
  );

  // No rm of server.conflicts anywhere — the file persists across cycles.
  assert.doesNotMatch(
    script,
    /rm.*server\.conflicts/,
    'server.conflicts must never be deleted by the script'
  );
});

test('adoption probe foreign listener records conflict before clearing state', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);

  // Find the FOREIGN=1 block: conflict record must come before rm -f.
  const foreignBlockStart = ensureFn.indexOf('if [ "$FOREIGN" -eq 1 ]');
  const foreignBlockEnd = ensureFn.indexOf('else', foreignBlockStart);
  const foreignBlock = ensureFn.slice(foreignBlockStart, foreignBlockEnd);

  const conflictIdx = foreignBlock.indexOf('server.conflicts');
  const rmIdx = foreignBlock.indexOf('rm -f');
  assert.ok(conflictIdx >= 0, 'conflict recording must exist in FOREIGN=1 block');
  assert.ok(rmIdx >= 0, 'rm -f must exist in FOREIGN=1 block');
  assert.ok(
    conflictIdx < rmIdx,
    'conflict recording must come before rm -f so the stale handle is preserved in the conflict file'
  );
});

test('server stop reports conflict file after stop_server', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const serverHandler = script.slice(script.indexOf('server)\n'));
  const stopHandler = serverHandler.slice(serverHandler.indexOf('stop)\n'));

  // server stop calls stop_server, then checks for conflicts.
  assert.match(stopHandler, /stop_server/);
  assert.match(stopHandler, /server\.conflicts/);
  assert.match(stopHandler, /cat.*server\.conflicts/);
  assert.match(stopHandler, /foreign-listener conflicts/);
});

// No conflict guard is needed after the owned-child stop_server call in the
// start loop because the PID is freshly spawned and stop_server's
// APPIUM_CLEANUP_OWNED=1 path always kills our PID and cleans state.  The port
// bump loop handles any failure gracefully.  This test confirms there is no
// "refusing to overwrite" guard after the owned-child stop_server call — the
// absence of a guard is intentional because the path is always recoverable.
test('conflict-state guards appear before ensure_drivers so start loop is unreachable from a conflict', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const ensureStart = script.indexOf('ensure_server()');
  const ensureEnd = script.indexOf('\n}\n\nstop_server', ensureStart);
  const ensureFn = script.slice(ensureStart, ensureEnd);

  // Both guards must come before ensure_drivers (the first start-loop step).
  const driversIdx = ensureFn.indexOf('ensure_drivers');
  assert.ok(driversIdx >= 0, 'ensure_drivers must exist');

  const guardIdxs = [...ensureFn.matchAll(/refusing to overwrite/g)];
  assert.equal(guardIdxs.length, 2, 'both guards must exist');

  for (const m of guardIdxs) {
    assert.ok(
      typeof m.index === 'number' && m.index < driversIdx,
      'conflict guard must appear before ensure_drivers so state is not overwritten'
    );
  }
});
