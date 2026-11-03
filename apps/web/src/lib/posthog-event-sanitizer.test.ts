import { DEFAULT_EDITOR, EDITOR_OPTIONS } from '@/lib/editorOptions';
import { buildOpenInEditorUrl } from '@/app/share/[shareId]/open-in-editor-url';
import { sanitizePostHogEvent } from './posthog-event-sanitizer';

const SENTINEL = 'sentinel.share.capability.7f3a9c';
const SHARE_URL = `https://app.kilo.ai/s/${SENTINEL}`;
const LEGACY_SHARE_URL = `https://app.kilo.ai/share/${SENTINEL}`;

function autocaptureEvent(href: string) {
  return {
    uuid: 'test-event',
    event: '$autocapture',
    properties: {
      $event_type: 'click',
      $current_url: `${SHARE_URL}?utm_source=copy`,
      $pathname: `/s/${SENTINEL}`,
      $referrer: `${SHARE_URL}?utm_source=copy`,
      $referring_domain: 'app.kilo.ai',
      $initial_current_url: SHARE_URL,
      $initial_pathname: `/s/${SENTINEL}`,
      $initial_referrer: SHARE_URL,
      $session_entry_url: SHARE_URL,
      $session_entry_pathname: `/s/${SENTINEL}`,
      $session_entry_referrer: SHARE_URL,
      $prev_pageview_pathname: `/s/${SENTINEL}`,
      $external_click_url: href,
      $el_text: `Open in editor: ${href}`,
      $elements_chain: `a:attr__href="${href}"`,
      $elements: [
        {
          tag_name: 'a',
          $el_text: `Open in editor: ${href}`,
          attr__href: href,
          attributes: { attr__href: href, attr__class: 'inline-flex items-center gap-2' },
        },
      ],
    },
  };
}

describe('sanitizePostHogEvent', () => {
  it('removes a share capability from autocapture payloads using the real editor href', () => {
    const editorHref = buildOpenInEditorUrl(DEFAULT_EDITOR, SENTINEL, `/s/${SENTINEL}`);
    expect(editorHref).toBe(`vscode://kilocode.kilo-code/kilocode/s/${SENTINEL}`);
    const sanitized = sanitizePostHogEvent(autocaptureEvent(editorHref));

    expect(JSON.stringify(sanitized)).not.toContain(SENTINEL);
    expect(sanitized.properties.$current_url).toBe(
      'https://app.kilo.ai/s/:share_token?utm_source=copy'
    );
    expect(sanitized.properties.$pathname).toBe('/s/:share_token');
    expect(sanitized.properties.$referrer).toBe(
      'https://app.kilo.ai/s/:share_token?utm_source=copy'
    );
    expect(sanitized.properties.$initial_current_url).toBe('https://app.kilo.ai/s/:share_token');
    expect(sanitized.properties.$session_entry_url).toBe('https://app.kilo.ai/s/:share_token');
    expect(sanitized.properties.$prev_pageview_pathname).toBe('/s/:share_token');
    expect(sanitized.properties.$external_click_url).toBe(
      'vscode://kilocode.kilo-code/kilocode/s/:share_token'
    );
    expect(sanitized.properties.$elements_chain).toBe(
      'a:attr__href="vscode://kilocode.kilo-code/kilocode/s/:share_token"'
    );
    expect(sanitized.properties.$el_text).toBe(
      'Open in editor: vscode://kilocode.kilo-code/kilocode/s/:share_token'
    );
    expect(sanitized.properties.$elements).toEqual([
      {
        tag_name: 'a',
        $el_text: 'Open in editor: vscode://kilocode.kilo-code/kilocode/s/:share_token',
        attr__href: 'vscode://kilocode.kilo-code/kilocode/s/:share_token',
        attributes: {
          attr__href: 'vscode://kilocode.kilo-code/kilocode/s/:share_token',
          attr__class: 'inline-flex items-center gap-2',
        },
      },
    ]);
  });

  it.each(EDITOR_OPTIONS.slice(0, 4))('removes the capability from a $name editor href', editor => {
    const href = buildOpenInEditorUrl(editor, SENTINEL, `/s/${SENTINEL}`);
    const sanitized = sanitizePostHogEvent(autocaptureEvent(href));

    expect(JSON.stringify(sanitized)).not.toContain(SENTINEL);
    expect(sanitized.properties.$elements[0].attr__href).toContain('/s/:share_token');
  });

  it('covers a direct load and pageleave from a share page', () => {
    const directLoad = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$pageview',
      properties: {
        $current_url: SHARE_URL,
        $pathname: `/s/${SENTINEL}`,
        $referrer: 'https://www.google.com/search?q=kilo',
      },
    });
    expect(JSON.stringify(directLoad)).not.toContain(SENTINEL);

    const pageleave = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$pageleave',
      properties: {
        $current_url: SHARE_URL,
        $pathname: `/s/${SENTINEL}`,
        $prev_pageview_pathname: `/s/${SENTINEL}`,
      },
    });
    expect(JSON.stringify(pageleave)).not.toContain(SENTINEL);
  });

  it('covers client navigation into a share page', () => {
    const event = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$pageview',
      properties: {
        $current_url: SHARE_URL,
        $pathname: `/s/${SENTINEL}`,
        $referrer: 'https://app.kilo.ai/cloud/sessions',
      },
    });

    expect(JSON.stringify(event)).not.toContain(SENTINEL);
    expect(event.properties.$current_url).toBe('https://app.kilo.ai/s/:share_token');
    expect(event.properties.$pathname).toBe('/s/:share_token');
    expect(event.properties.$referrer).toBe('https://app.kilo.ai/cloud/sessions');
  });

  it('covers client navigation out of a share page', () => {
    const event = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$pageview',
      properties: {
        $current_url: 'https://app.kilo.ai/cloud/sessions?tab=recent',
        $pathname: '/cloud/sessions',
        $referrer: SHARE_URL,
        $prev_pageview_pathname: `/s/${SENTINEL}`,
      },
    });

    expect(JSON.stringify(event)).not.toContain(SENTINEL);
    expect(event.properties.$current_url).toBe('https://app.kilo.ai/cloud/sessions?tab=recent');
    expect(event.properties.$pathname).toBe('/cloud/sessions');
    expect(event.properties.$referrer).toBe('https://app.kilo.ai/s/:share_token');
  });

  it('covers legacy share routes', () => {
    const event = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$pageview',
      properties: {
        $current_url: `${LEGACY_SHARE_URL}?utm_source=copy`,
        $pathname: `/share/${SENTINEL}`,
        $referrer: LEGACY_SHARE_URL,
        $elements: [
          {
            attr__href: buildOpenInEditorUrl(DEFAULT_EDITOR, SENTINEL, `/share/${SENTINEL}`),
          },
        ],
      },
    });

    expect(JSON.stringify(event)).not.toContain(SENTINEL);
    expect(event.properties.$pathname).toBe('/share/:share_id');
    expect(event.properties.$referrer).toBe('https://app.kilo.ai/share/:share_id');
  });

  it('sanitizes person properties and encoded initial person info', () => {
    const encodedUrl = encodeURIComponent(SHARE_URL);
    const jsonInfo = JSON.stringify({ r: SHARE_URL, u: `${SHARE_URL}?utm_source=copy` });
    const encodedJsonInfo = encodeURIComponent(jsonInfo);

    const event = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$identify',
      properties: {
        $initial_person_info: { r: SHARE_URL, u: encodedUrl },
      },
      $set: {
        $initial_person_info: jsonInfo,
        $initial_current_url: SHARE_URL,
      },
      $set_once: {
        $initial_current_url: SHARE_URL,
        $initial_pathname: `/s/${SENTINEL}`,
        $initial_referrer: SHARE_URL,
        $initial_person_info: encodedJsonInfo,
      },
    });

    expect(JSON.stringify(event)).not.toContain(SENTINEL);
    expect(event.properties.$initial_person_info).toEqual({
      r: 'https://app.kilo.ai/s/:share_token',
      u: encodeURIComponent('https://app.kilo.ai/s/:share_token'),
    });
    expect(JSON.parse(String(event.$set?.$initial_person_info))).toEqual({
      r: 'https://app.kilo.ai/s/:share_token',
      u: 'https://app.kilo.ai/s/:share_token?utm_source=copy',
    });
    expect(event.$set?.$initial_current_url).toBe('https://app.kilo.ai/s/:share_token');
    expect(event.$set_once?.$initial_current_url).toBe('https://app.kilo.ai/s/:share_token');
    expect(event.$set_once?.$initial_pathname).toBe('/s/:share_token');
    expect(event.$set_once?.$initial_referrer).toBe('https://app.kilo.ai/s/:share_token');
    expect(JSON.parse(decodeURIComponent(String(event.$set_once?.$initial_person_info)))).toEqual({
      r: 'https://app.kilo.ai/s/:share_token',
      u: 'https://app.kilo.ai/s/:share_token?utm_source=copy',
    });
  });

  it('preserves unrelated route events with the existing query sanitization', () => {
    const event = sanitizePostHogEvent({
      uuid: 'test-event',
      event: '$pageview',
      properties: {
        $current_url: 'https://app.kilo.ai/credits?tab=usage&email=user%40example.com&token=secret',
        $pathname: '/credits',
        $referrer: 'https://app.kilo.ai/profile?state=secret&foo=bar',
        $elements: [
          {
            tag_name: 'a',
            attr__href: 'https://app.kilo.ai/cloud/sessions?email=user%40example.com',
          },
        ],
      },
    });

    expect(event.properties.$current_url).toBe('https://app.kilo.ai/credits?tab=usage');
    expect(event.properties.$pathname).toBe('/credits');
    expect(event.properties.$referrer).toBe('https://app.kilo.ai/profile?foo=bar');
    expect(event.properties.$elements[0].attr__href).toBe('https://app.kilo.ai/cloud/sessions');
  });

  it('passes through missing events', () => {
    expect(sanitizePostHogEvent(null)).toBeNull();
  });
});
