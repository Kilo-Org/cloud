#!/usr/bin/env python3
"""Calibrate `adb shell input text` overhead with a plain Android EditText.

Opens Settings' search field (a plain EditText with no React Native around it),
types the same payload the app probe types, and prints the wall time. The
difference between this and the in-app number is the app's own cost.

Usage: python3 /tmp/promptperf/calibrate.py [chars]
"""
import re
import subprocess
import sys
import time


def sh(*args, timeout=900):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def dump():
    sh('adb', 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml', timeout=120)
    return sh('adb', 'exec-out', 'cat', '/sdcard/ui.xml', timeout=120).stdout


def main():
    chars = int(sys.argv[1]) if len(sys.argv) > 1 else 6000
    sh('adb', 'shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
    time.sleep(4)
    xml = dump()
    spot = None
    for raw in re.findall(r'<node[^>]*>', xml):
        get = lambda key: (re.search(key + r'="([^"]*)"', raw) or [None, ''])[1]
        label = get('text') or get('content-desc')
        box = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', get('bounds'))
        if box and re.search(r'search', label, re.I):
            left, top, right, bottom = (int(v) for v in box.groups())
            spot = ((left + right) // 2, (top + bottom) // 2, label)
            break
    if not spot:
        print('no settings search field found')
        sys.exit(1)
    x, y, label = spot
    print(f'search field {label!r} at {x},{y}')
    sh('adb', 'shell', 'input', 'tap', str(x), str(y))
    time.sleep(2)
    payload = ''.join('abcdefghij'[i % 10] for i in range(chars))
    started = time.time()
    sh('adb', 'shell', 'input', 'text', payload)
    elapsed = time.time() - started
    print(f'plain EditText {chars} chars: wall={elapsed:.2f}s')
    sh('adb', 'shell', 'input', 'keyevent', '4')
    time.sleep(1)
    sh('adb', 'shell', 'input', 'keyevent', '4')


if __name__ == '__main__':
    main()
