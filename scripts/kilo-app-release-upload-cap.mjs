#!/usr/bin/env node
/**
 * Hold a kilo-app release run when App Store Connect would refuse the upload.
 *
 * Apple refuses an upload once a per-app rolling limit is reached. The
 * kilo-app Release workflow's upload was refused at run 35825897712 on
 * 2026-09-23T06:44:56Z with 21 successful App Store Connect uploads in the
 * preceding rolling 24h - the 22nd attempt in the window. It refused again at
 * 07:18:33Z, 08:37:03Z and at 11:05:56Z / 11:41:25Z (run 35849820597, the
 * failure this gate answers), while a submission at 10:03:22Z was accepted
 * with 20 in the window.
 *
 * The count source is the App Store Connect uploads themselves, not the release
 * tags. A release tag is written only after Submit iOS *and* Submit Android, so
 * a run that uploads the IPA and then fails at Submit Android is a real upload
 * that no release tag records; with the hourly schedule it re-uploads iOS every
 * hour while the tag count still reads low. The workflow therefore pushes one
 * annotated `kilo-app-upload/<date>-<run>` marker immediately after Submit iOS
 * succeeds, and this gate counts that prefix. `kilo-app-release/*` tags stay
 * release detection only (the workflow's change detection reads them). The
 * marker is annotated, so its creatordate is the upload moment: a hold resumed
 * hours later still counts at the time of the upload, not the commit.
 *
 * The chosen cap is 10, 52 percent under the 21 that were refused, so the
 * margin absorbs the gate's granularity.
 *
 * A hold is a green run, never a failure: nothing is built, and the next push
 * or the hourly schedule resumes the same unreleased change.
 *
 * Usage:
 *   node scripts/kilo-app-release-upload-cap.mjs [--cap 10] [--window-hours 24]
 *     [--now <ISO8601>] [--prefix kilo-app-upload/]
 *
 * Exit codes:
 *   0 - a decision was made: allowed=true or allowed=false (a hold is green)
 *   1 - git could not list the upload markers; no count is guessed
 *   2 - usage error
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_CAP = 10;
const DEFAULT_WINDOW_HOURS = 24;
// One tag per App Store Connect upload, pushed right after Submit iOS succeeds.
// The release tags (`kilo-app-release/`) are release detection only: a partial
// run never writes one, so they cannot be the upload count.
const DEFAULT_PREFIX = 'kilo-app-upload/';
const MS_PER_HOUR = 3_600_000;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function reasonOf(error) {
  const stderr = error && error.stderr ? String(error.stderr).trim() : '';
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? (error && error.message) ?? 'unknown error';
}

/** An ISO8601 UTC timestamp without fractional seconds, e.g. 2026-09-23T06:44:56Z. */
export function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A marker counts when its creatordate lies in (now - windowHours, now]. */
export function withinWindow(unix, nowMs, windowHours) {
  const tagMs = unix * 1000;
  return tagMs > nowMs - windowHours * MS_PER_HOUR && tagMs <= nowMs;
}

/** The upload markers inside the window, oldest first. */
export function selectWindow(tags, nowMs, windowHours) {
  return tags
    .filter(tag => withinWindow(tag.unix, nowMs, windowHours))
    .sort((a, b) => a.unix - b.unix);
}

function parseMarkers(raw) {
  const tags = [];
  for (const line of raw.split('\n')) {
    if (!line) {
      continue;
    }
    const separator = line.lastIndexOf(' ');
    if (separator < 0) {
      continue;
    }
    const unix = Number(line.slice(separator + 1));
    if (Number.isFinite(unix)) {
      tags.push({ name: line.slice(0, separator), unix });
    }
  }
  return tags;
}

function usage(message) {
  if (message) {
    console.error(`kilo-app release upload cap: ${message}`);
  }
  console.error('Usage:');
  console.error(
    '  node scripts/kilo-app-release-upload-cap.mjs [--cap 10] [--window-hours 24] [--now <ISO8601>] [--prefix kilo-app-upload/]'
  );
  return 2;
}

function main() {
  const argv = process.argv.slice(2);
  let cap = DEFAULT_CAP;
  let windowHours = DEFAULT_WINDOW_HOURS;
  let prefix = DEFAULT_PREFIX;
  let now;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cap') {
      cap = Number(argv[(index += 1)]);
    } else if (arg === '--window-hours') {
      windowHours = Number(argv[(index += 1)]);
    } else if (arg === '--now') {
      now = argv[(index += 1)];
      if (now === undefined) {
        return usage('--now requires an ISO8601 timestamp');
      }
    } else if (arg === '--prefix') {
      prefix = argv[(index += 1)];
      if (prefix === undefined) {
        return usage('--prefix requires a value');
      }
    } else {
      return usage(`unknown argument: ${arg}`);
    }
  }
  // The cap counts uploads, so a fractional cap is a usage error: with
  // `--cap 10.5` ten markers satisfy `count < cap` and the next upload raises
  // the count to eleven, above the count the caller asked to hold.
  if (!Number.isInteger(cap) || cap <= 0) {
    return usage('--cap must be a positive whole number');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    return usage('--window-hours must be a positive number');
  }

  let nowMs;
  if (now === undefined) {
    nowMs = Date.now();
  } else {
    nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) {
      return usage(`--now is not an ISO8601 timestamp: ${now}`);
    }
  }

  let raw;
  try {
    raw = git([
      'for-each-ref',
      '--format=%(refname:short) %(creatordate:unix)',
      `refs/tags/${prefix}*`,
    ]);
  } catch (error) {
    console.error(
      `kilo-app release upload cap: cannot list the upload markers (${reasonOf(error)}); no count is guessed`
    );
    return 1;
  }

  const window = selectWindow(parseMarkers(raw), nowMs, windowHours);
  const count = window.length;
  const fromIso = isoSeconds(nowMs - windowHours * MS_PER_HOUR);
  const toIso = isoSeconds(nowMs);
  console.log(
    `kilo-app release upload cap: ${count} App Store Connect uploads in the last ${windowHours}h (cap ${cap}, window ${fromIso}..${toIso})`
  );

  const allowed = count < cap;
  if (allowed) {
    console.log(`kilo-app release upload cap: ${count} of ${cap} slots used - proceeding`);
  } else {
    const oldest = window[0];
    const freeAt = isoSeconds(oldest.unix * 1000 + windowHours * MS_PER_HOUR);
    console.log(
      `kilo-app release upload cap: HOLD - nothing is built; the oldest upload in the window (${oldest.name}, ${isoSeconds(oldest.unix * 1000)}) frees a slot at ${freeAt}; the next run (a push, or the hourly schedule) picks the release up`
    );
  }
  console.log(`allowed=${allowed ? 'true' : 'false'}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
