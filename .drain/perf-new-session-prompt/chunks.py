#!/usr/bin/env python3
"""Per-chunk typing cost at growing draft lengths on the new-session prompt.

Focuses the prompt, then types fixed chunks and prints each chunk's wall time,
so a cost that grows with the draft's length shows up as a rising column.
Also records the uiautomator dump latency before and after, and gfxinfo jank.

Usage: python3 /tmp/promptperf/chunks.py <label> <chunk-chars> <chunks>
"""
import re
import subprocess
import sys
import time

PKG = 'com.kilocode.kiloapp'
OUT = '/tmp/promptperf'


def sh(*args, timeout=1200):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def dump():
    started = time.time()
    sh('adb', 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml', timeout=180)
    xml = sh('adb', 'exec-out', 'cat', '/sdcard/ui.xml', timeout=120).stdout
    return xml, time.time() - started


def prompt_center(xml):
    for raw in re.findall(r'<node[^>]*>', xml):
        get = lambda key: (re.search(key + r'="([^"]*)"', raw) or [None, ''])[1]
        label = get('text') or get('content-desc') or get('hint')
        box = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', get('bounds'))
        if box and re.search(r'work on|woran|prompt|aufgabe', label, re.I):
            left, top, right, bottom = (int(v) for v in box.groups())
            return (left + right) // 2, (top + bottom) // 2
    return None


def gfx():
    out = sh('adb', 'shell', 'dumpsys', 'gfxinfo', PKG).stdout
    keep = (
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
    return [line.strip() for line in out.splitlines() if any(key in line for key in keep)]


def main():
    label = sys.argv[1]
    chunk = int(sys.argv[2])
    chunks = int(sys.argv[3])

    xml, dump_before = dump()
    spot = prompt_center(xml)
    if not spot:
        print('prompt not found')
        for raw in re.findall(r'<node[^>]*>', xml)[:10]:
            print(raw[:120])
        sys.exit(1)
    sh('adb', 'shell', 'input', 'tap', str(spot[0]), str(spot[1]))
    time.sleep(1.5)
    sh('adb', 'shell', 'dumpsys', 'gfxinfo', PKG, 'reset')

    rows = []
    typed = 0
    for index in range(chunks):
        payload = ''.join('abcdefghij'[(index * chunk + i) % 10] for i in range(chunk))
        started = time.time()
        sh('adb', 'shell', 'input', 'text', payload)
        wall = time.time() - started
        typed += chunk
        rows.append((typed, wall))
        print(f'chunk {index + 1}: draft={typed} chars typed={chunk} wall={wall:.2f}s '
              f'per_char={1000 * wall / chunk:.1f}ms', flush=True)

    xml, dump_after = dump()
    stats = gfx()
    with open(f'{OUT}/{label}.txt', 'w') as handle:
        handle.write(f'label={label} chunk={chunk} chunks={chunks}\n')
        for typed_chars, wall in rows:
            handle.write(f'draft={typed_chars} wall={wall:.3f} per_char_ms={1000 * wall / chunk:.2f}\n')
        handle.write(f'dump_before={dump_before:.2f}s dump_after={dump_after:.2f}s\n')
        handle.write('\n'.join(stats) + '\n')
        handle.write('visible_texts=' + ' | '.join(
            dict.fromkeys(
                text for text in (
                    (re.search(r'text="([^"]*)"', raw) or [None, ''])[1]
                    for raw in re.findall(r'<node[^>]*>', xml)
                ) if text and len(text) < 40
            )
        ) + '\n')
    print(f'dump_before={dump_before:.2f}s dump_after={dump_after:.2f}s')
    print('\n'.join(stats))
    print(f'written {OUT}/{label}.txt')


if __name__ == '__main__':
    main()
