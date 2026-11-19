import {
  classifyDeviceSessionClient,
  type DeviceSessionClient,
} from '@/lib/auth/device-session-client';

type Case = [label: string, userAgent: string | null | undefined, expected: DeviceSessionClient];

const cases: Case[] = [
  [
    'an Android app header',
    'Kilo-Code/1.2.3 (android)',
    { kind: 'app', platform: 'android', clientName: null },
  ],
  [
    'an iOS app header',
    'Kilo-Code/1.0.4 (ios)',
    { kind: 'app', platform: 'ios', clientName: null },
  ],
  [
    'an app header with an empty version',
    'Kilo-Code/ (android)',
    { kind: 'app', platform: 'android', clientName: null },
  ],
  ['an OkHttp header', 'okhttp/4.9.2', { kind: 'app', platform: 'android', clientName: null }],
  ['a bare OkHttp header', 'okhttp', { kind: 'app', platform: 'android', clientName: null }],
  [
    'a CLI header carrying a platform word that names no app platform',
    'Kilo-Code/1.2.3 (darwin; arm64)',
    { kind: 'cli', platform: null, clientName: null },
  ],
  ['a CLI header', 'Kilo-Code/1.4.0', { kind: 'cli', platform: null, clientName: null }],
  [
    'a browser header',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    { kind: 'browser', platform: null, clientName: null },
  ],
  [
    'an unclassified library header',
    'axios/1.7.0',
    { kind: 'other', platform: null, clientName: 'axios' },
  ],
  [
    'an unclassified agent with no version token',
    'Strange Agent 2.0',
    { kind: 'other', platform: null, clientName: 'Strange' },
  ],
  ['a missing header', null, { kind: 'other', platform: null, clientName: null }],
  ['an undefined header', undefined, { kind: 'other', platform: null, clientName: null }],
  ['a blank header', '   ', { kind: 'other', platform: null, clientName: null }],
];

describe('classifyDeviceSessionClient', () => {
  it.each(cases)('classifies %s', (_label, userAgent, expected) => {
    expect(classifyDeviceSessionClient(userAgent)).toEqual(expected);
  });
});
