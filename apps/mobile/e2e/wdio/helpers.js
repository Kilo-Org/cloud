// Flow primitives mirroring the old YAML flow vocabulary: tapOn,
// assertVisible, extendedWaitUntil, inputText, eraseText, scrollUntilVisible,
// stopApp/launchApp. Text matching is a full-string regex against the
// element's visible text / accessibility label (iOS label/name/value,
// Android text/content-desc), exactly like the flows relied on before.
// Multiple matches are ordered topmost-first, then leftmost-first; pass
// { index } to pick a later one.

function regexSource(pattern) {
  return pattern instanceof RegExp ? pattern.source : String(pattern);
}

function regexFlags(pattern, ci) {
  if (ci) return 'i';
  return pattern instanceof RegExp ? pattern.flags : '';
}

// iOS NSPredicate string literal: escape backslashes first, then quotes.
function predicateEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Android UiSelector Java string literal: same escaping rules.
function javaEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// driver.findElements returns raw protocol references
// ({ 'element-6066-11e4-a52e-4f735466cecf': <id> }), not WDIO Element
// objects; normalize the id for element commands.
function elementIdOf(el) {
  return el.elementId ?? el['element-6066-11e4-a52e-4f735466cecf'] ?? el.ELEMENT;
}

function make(driver, platform) {
  async function findAll(pattern, { ci = false } = {}) {
    const source = regexSource(pattern);
    const flags = regexFlags(pattern, ci);
    const anchored = flags.includes('i') ? `(?i)(?:${source})` : `(?:${source})`;
    let elements;
    if (platform === 'ios') {
      const re = predicateEscape(anchored);
      elements = await driver.findElements(
        '-ios predicate string',
        `label MATCHES "${re}" OR name MATCHES "${re}" OR value MATCHES "${re}"`
      );
    } else {
      // UiSelector matches whole strings already; the (?:..) wrap keeps
      // alternation precedence identical to the iOS side. Backslash escapes
      // (\?, \., ...) are consumed by the selector parser and silently match
      // nothing — translate every escaped char into a character class.
      const classed = anchored.replace(/\\(.)/g, '[$1]');
      const re = javaEscape(classed);
      const byText = await driver.findElements(
        '-android uiautomator',
        `new UiSelector().textMatches("${re}")`
      );
      const byDesc = await driver.findElements(
        '-android uiautomator',
        `new UiSelector().descriptionMatches("${re}")`
      );
      const seen = new Set();
      elements = [];
      for (const el of [...byText, ...byDesc]) {
        const id = elementIdOf(el);
        if (!seen.has(id)) {
          seen.add(id);
          elements.push(el);
        }
      }
    }
    if (elements.length <= 1) return elements;
    const withRect = await Promise.all(
      elements.map(async el => ({ el, rect: await driver.getElementRect(elementIdOf(el)) }))
    );
    withRect.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    return withRect.map(({ el }) => el);
  }

  function describe(pattern) {
    return pattern instanceof RegExp ? `/${pattern.source}/` : `'${pattern}'`;
  }

  async function visible(pattern, opts) {
    try {
      return (await findAll(pattern, opts)).length > 0;
    } catch {
      return false;
    }
  }

  async function waitVisible(pattern, { timeout = 15000, optional = false, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const els = await findAll(pattern).catch(() => []);
      if (els.length > 0) return els[0];
      if (Date.now() >= deadline) break;
      await sleep(interval);
    }
    if (optional) return null;
    throw new Error(`timed out after ${timeout}ms waiting for visible: ${describe(pattern)}`);
  }

  async function tapOn(pattern, { index = 0, ci = false } = {}) {
    const els = await findAll(pattern, { ci });
    if (els.length === 0) throw new Error(`no element matching ${describe(pattern)}`);
    if (index >= els.length) {
      throw new Error(`index ${index} out of range (${els.length} matches) for ${describe(pattern)}`);
    }
    await driver.elementClick(elementIdOf(els[index]));
  }

  async function assertVisible(pattern, opts) {
    if (!(await visible(pattern, opts))) {
      throw new Error(`expected visible: ${describe(pattern)}`);
    }
  }

  // Types into the focused field via Element Send Keys — driver.keys uses
  // the W3C actions API, whose per-character key-downs XCUITest rejects.
  async function inputText(text) {
    try {
      const active = await driver.getActiveElement();
      await driver.elementSendKeys(elementIdOf(active), String(text));
      return;
    } catch {
      // No focused element — fall back to key events.
    }
    await driver.keys(String(text));
  }

  // Empties the focused field: a direct element clear, with a bounded
  // backspace loop as fallback. (Batches of BACKSPACE key actions are
  // rejected by XCUITest as unpaired key-downs, and the raw control
  // character is not typeable — the flows only ever erase to empty.)
  async function eraseText(count = 100) {
    try {
      const active = await driver.getActiveElement();
      await driver.elementClear(elementIdOf(active));
      return;
    } catch {
      // No clearable focused element — fall through to key events.
    }
    for (let i = 0; i < count; i++) {
      await driver.keys(['\uE003']);
    }
  }

  // One flick of the content; sign=1 scrolls DOWN (content moves up).
  async function swipeUp(sign = 1) {
    const { width, height } = await driver.getWindowSize();
    const x = Math.round(width / 2);
    const from = Math.round(height * (sign > 0 ? 0.7 : 0.3));
    const to = Math.round(height * (sign > 0 ? 0.3 : 0.7));
    await driver.performActions([
      {
        type: 'pointer',
        id: 'finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y: from },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 400, x, y: to },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await driver.releaseActions();
  }

  async function scrollUntilVisible(pattern, { direction = 'DOWN', maxScrolls = 10 } = {}) {
    for (let i = 0; i < maxScrolls; i++) {
      const els = await findAll(pattern).catch(() => []);
      if (els.length > 0) return els[0];
      await swipeUp(direction === 'UP' ? -1 : 1);
    }
    throw new Error(`scrolled ${maxScrolls} times without finding ${describe(pattern)}`);
  }

  async function stopApp(bundleId) {
    await driver.terminateApp(bundleId);
  }

  async function launchApp(bundleId) {
    await driver.activateApp(bundleId);
  }

  return {
    assertVisible,
    eraseText,
    findAll,
    inputText,
    launchApp,
    scrollUntilVisible,
    stopApp,
    swipeUp,
    tapOn,
    visible,
    waitVisible,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Conditional step, mirroring `runFlow: when: visible:`.
async function when(ctx, pattern, fn, opts) {
  if (await ctx.h.visible(pattern, opts)) return fn(ctx);
  return undefined;
}

// Conditional step, mirroring `runFlow: when: notVisible:`.
async function whenNot(ctx, pattern, fn, opts) {
  if (!(await ctx.h.visible(pattern, opts))) return fn(ctx);
  return undefined;
}

module.exports = { make, sleep, when, whenNot };
