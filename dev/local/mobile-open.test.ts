import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDevSessionUrl,
  MOBILE_OPEN_ROUTES,
  parseMobileOpenArgs,
  resolveMobileOpenRoute,
} from './mobile-open-routes';

test('parseMobileOpenArgs lists usage when called without arguments', () => {
  assert.equal(parseMobileOpenArgs([]), null);
  assert.equal(parseMobileOpenArgs(['--help']), null);
});

test('parseMobileOpenArgs reads email and a named route', () => {
  assert.deepEqual(parseMobileOpenArgs(['--email', 'ada@example.com', 'home']), {
    email: 'ada@example.com',
    route: 'home',
    sessionId: null,
    platform: null,
    udid: null,
    serial: null,
  });
});

test('resolveMobileOpenRoute maps names and raw paths', () => {
  assert.equal(resolveMobileOpenRoute('home', null), '/home');
  assert.equal(resolveMobileOpenRoute('sessions', null), '/cloud/sessions');
  assert.equal(resolveMobileOpenRoute('settings', null), '/profile/preferences');
  assert.equal(resolveMobileOpenRoute('/profile', null), '/profile');
  assert.equal(resolveMobileOpenRoute('session', 'ses_1'), '/cloud/sessions/ses_1');
});

test('resolveMobileOpenRoute rejects an unknown name and a missing session id', () => {
  assert.throws(() => resolveMobileOpenRoute('unknown', null), /Unknown route/);
  assert.throws(() => resolveMobileOpenRoute('session', null), /session requires --session-id/);
});

test('buildDevSessionUrl puts credentials on the kiloapp URL', () => {
  const url = buildDevSessionUrl('/home', {
    token: 'tok',
    refreshToken: 'ref',
    expiresIn: 3600,
  });
  assert.equal(
    url,
    'kiloapp:///home?dev_session_token=tok&dev_session_refresh=ref&dev_session_expires_in=3600'
  );
});

test('route list includes the E2E screens', () => {
  const names = MOBILE_OPEN_ROUTES.map(route => route.name);
  assert.deepEqual(names, ['home', 'sessions', 'session-list', 'session', 'settings', 'profile']);
});
