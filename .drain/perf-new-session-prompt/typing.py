#!/usr/bin/env python3
"""Typing cost at growing draft lengths, with per-chunk proof that the text landed.

Opens the new-session composer, focuses the prompt, then types fixed chunks. After
each chunk it reads the field's own text length out of the accessibility dump, so a
chunk that did not land (app reload, lost focus) is visible instead of silently
counted.

Usage: python3 /tmp/promptperf/typing.py <label> <chunk-chars> <chunks> [--keep]
"""
import re
import subprocess
import sys
import time

PKG = 'com.kilocode.kiloapp'
OUT = '/tmp/promptperf'
NEW_SESSION = 'kiloapp:///(app)/agent-chat/new'


def sh(*args, timeout=1800):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def dump():
    started = time.time()
    sh('adb', 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml', timeout=240)
    xml = sh('adb', 'exec-out', 'cat', '/sdcard/ui.xml', timeout=180).stdout
    return xml, time.time() - started


def field_state(xml):
    """The prompt EditText's centre and its current text length, when present."""
    for raw in re.findall(r'<node[^>]*>', xml):
        get = lambda key: (re.search(key + r'="([^"]*)"', raw) or [None, ''])[1]
        box = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', get('bounds'))
        if not box:
            continue
        label = get('text') or get('hint') or get('content-desc')
        klass = get('class')
        if 'EditText' in klass:
            left, top, right, bottom = (int(v) for v in box.groups())
            return ((left + right) // 2, (top + bottom) // 2), len(get('text')), label[:40]
    return None, None, None


def focused():
    out = sh('adb', 'shell', 'dumpsys', 'window').stdout
    return PKG in out.split('mCurrentFocus=')[-1][:120]


def open_new_session():
    sh('adb', 'shell', 'am', 'start', '-n', f'{PKG}/.MainActivity', '-a', 'android.intent.action.VIEW', '-d', NEW_SESSION)
    deadline = time.time() + 120
    while time.time() < deadline:
        xml, _ = dump()
        spot, length, label = field_state(xml)
        if spot:
            return spot, length, label
        time.sleep(5)
    return None, None, None


def main():
    label = sys.argv[1]
    chunk = int(sys.argv[2])
    chunks = int(sys.argv[3])

    spot, length, hint = open_new_session()
    if not spot:
        print('prompt field not found')
        sys.exit(1)
    print(f'prompt at {spot} current_length={length} hint={hint!r}')
    sh('adb', 'shell', 'input', 'tap', str(spot[0]), str(spot[1]))
    time.sleep(2)
    sh('adb', 'shell', 'dumpsys', 'gfxinfo', PKG, 'reset')

    rows = []
    for index in range(chunks):
        payload = ''.join('abcdefghij'[(index * chunk + i) % 10] for i in range(chunk))
        before = time.time()
        sh('adb', 'shell', 'input', 'text', payload)
        typed_seconds = time.time() - before
        xml, dump_seconds = dump()
        _, after_length, _ = field_state(xml)
        if not focused():
            print(f'chunk {index + 1}: app lost focus, stopping')
            break
        rows.append((after_length, typed_seconds, dump_seconds))
        print(
            f'chunk {index + 1}: field_len={after_length} typed={chunk} '
            f'wall={typed_seconds:.2f}s per_char={1000 * typed_seconds / chunk:.2f}ms '
            f'dump={dump_seconds:.2f}s focused={focused()}',
            flush=True,
        )

    gfx = sh('adb', 'shell', 'dumpsys', 'gfxinfo', PKG).stdout
    stats = [
        line.strip()
        for line in gfx.splitlines()
        if any(
            key in line
            for key in (
                'Total frames rendered',
                'Janky frames',
                '50th percentile',
                '90th percentile',
                '95th percentile',
                '99th percentile',
                'Number Slow UI thread',
                'Number Slow issue draw commands',
                'Number Frame deadline missed',
            )
        )
    ]
    with open(f'{OUT}/{label}.txt', 'w') as handle:
        handle.write(f'label={label} chunk={chunk} chunks={chunks}\n')
        for field_len, typed_seconds, dump_seconds in rows:
            handle.write(
                f'field_len={field_len} wall={typed_seconds:.3f} '
                f'per_char_ms={1000 * typed_seconds / chunk:.2f} dump={dump_seconds:.2f}\n'
            )
        handle.write('\n'.join(stats) + '\n')
    print('\n'.join(stats))
    print(f'written {OUT}/{label}.txt')


if __name__ == '__main__':
    main()
