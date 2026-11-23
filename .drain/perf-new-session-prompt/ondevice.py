#!/usr/bin/env python3
"""Device-side typing cost, measured inside one adb shell.

Each chunk is typed by the device's own `input text` and timed on the device with
`date +%s%N`, so the host round trip and adb startup cost are not counted. The
field's own text length is read before and after with one uiautomator dump.

Usage: python3 /tmp/promptperf/ondevice.py <label> <chunk-chars> <chunks>
"""
import re
import subprocess
import sys
import time

PKG = 'com.kilocode.kiloapp'
OUT = '/tmp/promptperf'


def sh(*args, timeout=1800):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def field_length():
    sh('adb', 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml', timeout=240)
    xml = sh('adb', 'exec-out', 'cat', '/sdcard/ui.xml', timeout=180).stdout
    for raw in re.findall(r'<node[^>]*>', xml):
        get = lambda key: (re.search(key + r'="([^"]*)"', raw) or [None, ''])[1]
        if 'EditText' in get('class'):
            box = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', get('bounds'))
            center = None
            if box:
                left, top, right, bottom = (int(v) for v in box.groups())
                center = ((left + right) // 2, (top + bottom) // 2)
            return center, len(get('text'))
    return None, None


def main():
    label = sys.argv[1]
    chunk = int(sys.argv[2])
    chunks = int(sys.argv[3])

    center, before = field_length()
    if not center:
        print('no EditText on screen')
        sys.exit(1)
    sh('adb', 'shell', 'input', 'tap', str(center[0]), str(center[1]))
    time.sleep(2)
    sh('adb', 'shell', 'dumpsys', 'gfxinfo', PKG, 'reset')
    print(f'start field_len={before} chunk={chunk} chunks={chunks}')

    payload = ''.join('abcdefghij'[i % 10] for i in range(chunk))
    script = (
        f'for i in $(seq 1 {chunks}); do '
        's=$(date +%s%N); input text "$PAYLOAD"; e=$(date +%s%N); '
        'echo "chunk $i $(( (e-s)/1000000 ))"; done'
    )
    started = time.time()
    result = sh('adb', 'shell', f'PAYLOAD={payload}; {script}', timeout=3600)
    host_seconds = time.time() - started
    timings = [int(value) for value in re.findall(r'chunk \d+ (\d+)', result.stdout)]
    print(result.stdout.strip()[:2000])
    _, after = field_length()

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
        handle.write(f'label={label} chunk={chunk} chunks={chunks} before={before} after={after}\n')
        for index, value in enumerate(timings):
            handle.write(
                f'chunk={index + 1} device_ms={value} per_char_ms={value / chunk:.2f}\n'
            )
        handle.write(f'host_seconds={host_seconds:.1f}\n')
        handle.write('\n'.join(stats) + '\n')
    print(f'before={before} after={after} host={host_seconds:.1f}s')
    print('\n'.join(stats))
    print(f'written {OUT}/{label}.txt')


if __name__ == '__main__':
    main()
