#!/usr/bin/env python3
"""Sign the Kilo dev client in on this VM with the fake account.

Device-code path (new address): tap "More sign-in options", read the code, approve it
through the local web app's fake-login session, then consent + skip tour.
"""
import re
import subprocess
import sys
import time

ROOT = '/home/kwf/work/cloud'
EMAIL = 'gk@example.com'
APP_URL_DEFAULT = 'http://10.128.0.65:3000'


def sh(*args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def app_url():
    value = sh('grep', '-E', '^APP_URL_OVERRIDE=|^NEXTAUTH_URL=', f'{ROOT}/.env.local').stdout
    match = re.search(r'"?(http://[0-9.]+:3000|\S+)"?', value.split('=')[-1] if '=' in value else '')
    for line in value.splitlines():
        if line.startswith('APP_URL_OVERRIDE='):
            return line.split('=', 1)[1].strip('"')
    for line in value.splitlines():
        if line.startswith('NEXTAUTH_URL='):
            return line.split('=', 1)[1].strip('"')
    return APP_URL_DEFAULT


def nodes():
    sh('adb', 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml', timeout=180)
    xml = sh('adb', 'exec-out', 'cat', '/sdcard/ui.xml', timeout=120).stdout
    out = []
    for raw in re.findall(r'<node[^>]*>', xml):
        get = lambda key: (re.search(key + r'="([^"]*)"', raw) or [None, ''])[1]
        box = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', get('bounds'))
        out.append(
            {
                'text': get('text'),
                'desc': get('content-desc'),
                'hint': get('hint'),
                'checked': 'checked="true"' in raw,
                'bounds': tuple(int(v) for v in box.groups()) if box else None,
            }
        )
    return out


def texts():
    return [n['text'] or n['desc'] or n['hint'] for n in nodes() if (n['text'] or n['desc'] or n['hint'])]


def tap(label, exact=False):
    for node in nodes():
        label_text = node['text'] or node['desc'] or node['hint']
        if not label_text or not node['bounds']:
            continue
        hit = label_text == label if exact else label.lower() in label_text.lower()
        if hit:
            left, top, right, bottom = node['bounds']
            sh('adb', 'shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
            return True
    return False


def wait_for(pattern, seconds=120):
    deadline = time.time() + seconds
    while time.time() < deadline:
        for label in texts():
            if re.search(pattern, label, re.I):
                return label
        time.sleep(4)
    return None


def main():
    base = app_url()
    print('APP_URL', base)
    print('current:', texts()[:8])

    # "More sign-in options" -> device code.
    if not wait_for(r'Sign in code', 10):
        if not tap('More sign-in options', exact=True):
            print('no "More sign-in options"')
            return
        found = wait_for(r'Sign in code|Sign in with|device', 60)
        print('after more-options:', found)
        sh('adb', 'shell', 'am', 'force-stop', 'com.android.chrome')
        sh('adb', 'shell', 'am', 'start', '-n', 'com.kilocode.kiloapp/.MainActivity')
        time.sleep(8)

    code = None
    deadline = time.time() + 90
    while time.time() < deadline and not code:
        for label in texts():
            match = re.search(r'Sign in code:?\s*([A-Z0-9]{4}\s*[- ]?\s*[A-Z0-9]{4})', label)
            if match:
                raw = re.sub(r'[^A-Z0-9]', '', match.group(1))
                code = f'{raw[:4]}-{raw[4:]}'
                break
        if not code:
            time.sleep(4)
    if not code:
        print('no device code; screen:', texts()[:12])
        return
    print('code', code)

    jar = '/tmp/cj.txt'
    sh('rm', '-f', jar)
    csrf = sh('curl', '-s', '-c', jar, f'{base}/api/auth/csrf').stdout
    token = re.search(r'"csrfToken":"([^"]+)"', csrf)
    if not token:
        print('no csrf', csrf[:200])
        return
    sh(
        'curl',
        '-s',
        '-b',
        jar,
        '-c',
        jar,
        '-o',
        '/dev/null',
        '-X',
        'POST',
        f'{base}/api/auth/callback/fake-login',
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '--data-urlencode',
        f'csrfToken={token.group(1)}',
        '--data-urlencode',
        f'email={EMAIL}',
        '--data-urlencode',
        f'callbackUrl={base}/',
        '--data-urlencode',
        'json=true',
    )
    approve = sh(
        'curl',
        '-s',
        '-b',
        jar,
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-X',
        'POST',
        f'{base}/api/device-auth/tokens',
        '-H',
        'Content-Type: application/json',
        '-H',
        f'Origin: {base}',
        '-H',
        f'Referer: {base}/device-auth',
        '--data',
        f'{{"code":"{code}"}}',
    )
    print('approve', approve.stdout)

    label = wait_for(r'Before we get started|Help improve Kilo|Accept and continue', 180)
    print('consent screen:', label)
    for _ in range(3):
        for node in nodes():
            if node['text'] == 'Help improve Kilo' and node['checked']:
                tap('Help improve Kilo', exact=True)
                time.sleep(1)
        break
    time.sleep(1)
    tap('Accept and continue', exact=True)
    if wait_for(r'Skip tour', 120):
        tap('Skip tour', exact=True)
    time.sleep(5)
    print('after onboarding:', texts()[:12])
    user = sh(
        'docker',
        'exec',
        'dev-postgres-1',
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-tAc',
        f"select id from kilocode_users where google_user_email='{EMAIL}'",
    )
    print('user id', user.stdout.strip())


if __name__ == '__main__':
    main()
