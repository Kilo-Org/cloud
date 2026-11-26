import {
  UTS_DEVICE_DECISION_PATH,
  UTS_PASSKEY_OPTIONS_PATH,
  UTS_PASSKEY_VERIFY_PATH,
} from '@kilocode/uts-contracts';

/**
 * The one script of the sign-in pages (src/signin/pages.ts), served from the issuer origin so the
 * pages' Content-Security-Policy allows only `script-src 'self'`. It converts WebAuthn options
 * and responses between JSON and the browser's binary form, and posts JSON to the passkey and
 * device endpoints with the session cookie. It runs in every browser that supports passkeys, so
 * it uses no newer JSON helpers of the WebAuthn API.
 *
 * The relying-party id (`data-rp-id`) is the app host. On another host a ceremony needs the
 * browser's related-origin support (WebAuthn Level 3, section 5.11; design 5.14). The script asks
 * `PublicKeyCredential.getClientCapabilities()` first (section 5.1.7): `relatedOrigins: false`, or
 * no WebAuthn at all, hides every `data-passkey` element and shows the page's
 * `passkey-unavailable` notice before any challenge is asked for. A missing key means "not known",
 * and older browsers lack the method; such a browser finds out at the ceremony: when rp.id is not
 * the page's host, `SecurityError` means that the browser has no related-origin support or the
 * related-origin check failed (sections 5.1.3.1 and 5.1.4.3), and the page then shows the same
 * notice. `NotAllowedError` stays an ordinary failure the user can retry, because the
 * specification also uses it for a cancelled ceremony. So a passkey sign-in or registration on
 * such a browser never fails without saying why.
 */
const SCRIPT = `'use strict';
(() => {
  const OPTIONS = ${JSON.stringify(UTS_PASSKEY_OPTIONS_PATH)};
  const VERIFY = ${JSON.stringify(UTS_PASSKEY_VERIFY_PATH)};
  const DECISION = ${JSON.stringify(UTS_DEVICE_DECISION_PATH)};
  const TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'usb', 'smart-card', 'cable'];

  const toBytes = value => {
    const text = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
    return Uint8Array.from(text, character => character.charCodeAt(0));
  };
  const fromBytes = buffer => {
    let text = '';
    for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const status = message => {
    const element = document.getElementById('status');
    if (element) element.textContent = message;
  };

  const RP_ID = document.body.dataset.rpId;
  const HOST = window.location.hostname;
  const RELATED = typeof RP_ID === 'string' && HOST !== RP_ID && !HOST.endsWith('.' + RP_ID);
  const UNAVAILABLE = 'passkey_unavailable';

  // 'available', 'unavailable', or 'unknown' when only a ceremony can tell.
  const support = (async () => {
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return 'unavailable';
    if (!RELATED) return 'available';
    if (typeof PublicKeyCredential.getClientCapabilities !== 'function') return 'unknown';
    try {
      const capabilities = await PublicKeyCredential.getClientCapabilities();
      if (capabilities.relatedOrigins === true) return 'available';
      if (capabilities.relatedOrigins === false) return 'unavailable';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  })();

  const showUnavailable = () => {
    for (const element of document.querySelectorAll('[data-passkey]')) element.hidden = true;
    const notice = document.getElementById('passkey-unavailable');
    if (notice) notice.hidden = false;
    status('');
  };
  if (RP_ID !== undefined) {
    support.then(state => {
      if (state === 'unavailable') showUnavailable();
    });
  }

  // Before a challenge is asked for: refuses at once where the browser said it cannot.
  const requireSupport = async () => {
    if ((await support) === 'unavailable') throw new Error(UNAVAILABLE);
  };
  // One WebAuthn call: a SecurityError on another host than the relying party means the browser
  // cannot use its passkeys here.
  const webauthn = async call => {
    try {
      return await call();
    } catch (error) {
      if (RELATED && error && error.name === 'SecurityError') throw new Error(UNAVAILABLE);
      throw error;
    }
  };

  const post = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  };
  const failure = data => new Error(typeof data.error === 'string' ? data.error : 'failed');

  const assertionJson = credential => ({
    id: credential.id,
    rawId: fromBytes(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: {},
    response: {
      clientDataJSON: fromBytes(credential.response.clientDataJSON),
      authenticatorData: fromBytes(credential.response.authenticatorData),
      signature: fromBytes(credential.response.signature),
      userHandle: credential.response.userHandle ? fromBytes(credential.response.userHandle) : undefined,
    },
  });
  const attestationJson = credential => ({
    id: credential.id,
    rawId: fromBytes(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: {},
    response: {
      clientDataJSON: fromBytes(credential.response.clientDataJSON),
      attestationObject: fromBytes(credential.response.attestationObject),
      transports: (credential.response.getTransports ? credential.response.getTransports() : [])
        .filter(transport => TRANSPORTS.includes(transport)),
    },
  });

  const assertion = async ceremony => {
    await requireSupport();
    const options = await post(OPTIONS, { ceremony });
    if (!options.ok) throw failure(options.data);
    const publicKey = options.data.options;
    const credential = await webauthn(() => navigator.credentials.get({
      publicKey: {
        ...publicKey,
        challenge: toBytes(publicKey.challenge),
        allowCredentials: (publicKey.allowCredentials || []).map(item => ({ ...item, id: toBytes(item.id) })),
      },
    }));
    const verified = await post(VERIFY, { ceremony, response: assertionJson(credential) });
    if (!verified.ok) throw failure(verified.data);
    return verified.data;
  };

  const register = async name => {
    await requireSupport();
    const options = await post(OPTIONS, { ceremony: 'registration' });
    if (!options.ok) throw failure(options.data);
    const publicKey = options.data.options;
    const credential = await webauthn(() => navigator.credentials.create({
      publicKey: {
        ...publicKey,
        challenge: toBytes(publicKey.challenge),
        user: { ...publicKey.user, id: toBytes(publicKey.user.id) },
        excludeCredentials: (publicKey.excludeCredentials || []).map(item => ({ ...item, id: toBytes(item.id) })),
      },
    }));
    const verified = await post(VERIFY, { ceremony: 'registration', response: attestationJson(credential), name });
    if (!verified.ok) throw failure(verified.data);
    return verified.data;
  };

  const decide = async approve => {
    const element = document.getElementById('device-user-code');
    const decision = { user_code: element.dataset.userCode, source: element.dataset.codeSource, approve };
    let result = await post(DECISION, decision);
    if (!result.ok && result.data.error === 'gate_required') {
      status('Confirm with your passkey.');
      await assertion('step_up');
      result = await post(DECISION, decision);
    }
    if (!result.ok) throw failure(result.data);
    return result.data.outcome;
  };

  const on = (id, handler) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('click', async () => {
      element.disabled = true;
      try {
        await handler();
      } catch (error) {
        if (error instanceof Error && error.message === UNAVAILABLE) {
          showUnavailable();
          return;
        }
        status('That did not work: ' + (error instanceof Error ? error.message : 'failed'));
        element.disabled = false;
      }
    });
  };

  on('passkey-sign-in', async () => {
    status('Waiting for your passkey.');
    await assertion('sign_in');
    status('Signed in.');
    window.location.reload();
  });
  on('passkey-register', async () => {
    const name = document.getElementById('passkey-name').value;
    status('Waiting for your passkey.');
    await register(name);
    status('Passkey added.');
  });
  on('device-approve', async () => {
    await decide(true);
    status('Device approved. You can return to your device.');
  });
  on('device-deny', async () => {
    await decide(false);
    status('Device sign-in denied.');
  });
})();
`;

export function signInScript(): Response {
  return new Response(SCRIPT, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
