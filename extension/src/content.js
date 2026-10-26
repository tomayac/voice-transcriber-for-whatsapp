// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Finds voice messages in WhatsApp Web, adds a Transcribe control below each,
// fetches the audio through the main-world script, and hands it to the engine
// iframe.

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;

  // WhatsApp's class names are obfuscated and change with every release, so
  // detection relies on attributes that have stayed put: the `data-id` of each
  // message, the progress slider of audio players, and the play icons.
  const MESSAGE = '[data-id]';
  const VOICE_MARKER = [
    '[role="slider"][aria-valuetext]',
    '[data-icon="audio-play"]',
    '[data-icon="audio-pause"]',
    '[data-icon="ptt-play"]',
    '[data-icon="ptt-pause"]',
    'button[aria-label="Play voice message"]',
    'button[aria-label="Pause voice message"]',
  ].join(',');
  const BUTTON = 'button,[role="button"]';
  // Icon names change between WhatsApp releases (`audio-play`, `ptt-play`,
  // `ic-play-arrow`, …), so match the word in icon names and labels.
  // WhatsApp's own labels for the voice message player's button.
  const PLAYER_BUTTON =
    'button[aria-label="Play voice message"],' +
    'button[aria-label="Pause voice message"]';
  // Other UI languages and older releases: whole words only, so names like
  // `playback-speed` do not count.
  const PLAY_WORD = /(^|[\s_-])play($|[\s_-])/i;
  const PAUSE_WORD = /(^|[\s_-])pause($|[\s_-])/i;
  const MAX_TRANSCRIPTS = 1000;
  const MAX_PLAYED = 20;

  const languageNames = new Intl.DisplayNames([navigator.language], {
    type: 'language',
  });
  const languageName = (code) => {
    try {
      return languageNames.of(code);
    } catch {
      return code;
    }
  };
  const formatBytes = (bytes) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
  };

  // State.

  // Message id → { status, stage, text, language, modelLabel, … }.
  const states = new Map();
  // Message id → audio `Blob`, for messages the user played.
  const played = new Map();
  // Request id → message id.
  const requests = new Map();
  let nextRequestId = 1;
  let lastClicked = null;
  let settings = {};

  const transcriptsReady = ext.storage.local
    .get(['transcripts', 'settings'])
    .then(({ transcripts = {}, settings: stored = {} }) => {
      settings = stored;
      for (const [id, transcript] of Object.entries(transcripts)) {
        states.set(id, { status: 'done', ...transcript });
      }
    });

  ext.storage.onChanged.addListener((changes) => {
    if (changes.settings) settings = changes.settings.newValue ?? {};
  });

  async function saveTranscript(id, transcript) {
    const { transcripts = {} } = await ext.storage.local.get('transcripts');
    delete transcripts[id];
    transcripts[id] = transcript;
    const ids = Object.keys(transcripts);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_TRANSCRIPTS))) {
      delete transcripts[old];
    }
    await ext.storage.local.set({ transcripts });
  }

  // Main world.

  const hasMainWorld = () => !!document.documentElement.dataset.wvtMain;

  // Safari ignores `"world": "MAIN"` in the manifest. Ask the background
  // script to inject the file with `scripting.executeScript()` instead, and
  // as a last resort, add it as a script element, which the page's content
  // security policy may block.
  async function ensureMainWorld() {
    if (hasMainWorld()) return true;
    try {
      await ext.runtime.sendMessage({ type: 'inject-main-world' });
    } catch {
      // Handled by the fallback.
    }
    if (hasMainWorld()) return true;
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = ext.runtime.getURL('src/main-world.js');
      script.onload = script.onerror = () => {
        script.remove();
        resolve();
      };
      (document.head ?? document.documentElement).append(script);
    });
    return hasMainWorld();
  }
  const mainWorldReady = ensureMainWorld();

  const toMain = (message) =>
    window.postMessage({ wvt: 'content', ...message }, location.origin);

  const captures = new Map();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function dispatchPointerPress(target) {
    const { left, top, width, height } = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: left + width / 2,
      clientY: top + height / 2,
      button: 0,
    };
    const pointer = {
      ...init,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    target.dispatchEvent(
      new PointerEvent('pointerdown', { ...pointer, buttons: 1 }),
    );
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', pointer));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
  }

  function dispatchKeyPress(target) {
    target.focus();
    const init = {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // Which events WhatsApp's player reacts to is up to its UI framework, and a
  // bare `click()` is not always among them. Try one input style at a time,
  // and stop at the first the player reacts to, so playback never toggles
  // twice.
  const PRESSES = [
    (target) => target.click(),
    dispatchPointerPress,
    dispatchKeyPress,
  ];

  const describe = (element) =>
    [
      element.getAttribute('aria-label'),
      element.title,
      ...[element, ...element.querySelectorAll('[data-icon]')].map(
        (e) => e.dataset.icon,
      ),
    ]
      .filter(Boolean)
      .join(' ');

  // The voice message's play/pause button: by WhatsApp's English labels, by
  // icon name or label where those say "play" or "pause", else the button
  // right before the progress slider, which is where it sits in every WhatsApp
  // layout so far, whatever the UI language.
  function findPlayButton(message) {
    const labeled = message.querySelector(PLAYER_BUTTON);
    if (labeled) return labeled;
    const icon = [...message.querySelectorAll('[data-icon]')].find(
      (e) => PLAY_WORD.test(e.dataset.icon) || PAUSE_WORD.test(e.dataset.icon),
    );
    if (icon) return icon.closest(BUTTON) ?? icon;
    const buttons = [...message.querySelectorAll(BUTTON)];
    const named = buttons.find((b) => PLAY_WORD.test(describe(b)));
    if (named) return named;
    const slider = message.querySelector('[role="slider"]');
    if (!slider) return null;
    const before = buttons.filter(
      (b) =>
        !b.contains(slider) &&
        b.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return before.at(-1) ?? null;
  }

  const isPlaying = (button) => {
    const description = describe(button);
    return PAUSE_WORD.test(description) && !PLAY_WORD.test(description);
  };

  async function capture(id, onWaitingForUser) {
    if (!(await mainWorldReady)) {
      throw new Error(
        'The audio capture script could not be added to the WhatsApp page.',
      );
    }
    const message = findMessage(id);
    const button = message && findPlayButton(message);
    if (!button) {
      throw new Error('Could not find the play button of this voice message.');
    }
    if (isPlaying(button)) {
      throw new Error('Pause the voice message, then try again.');
    }
    const reqId = `c${nextRequestId++}`;
    const pending = { started: false, settled: false };
    const result = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    captures.set(reqId, pending);
    toMain({ type: 'arm', reqId });
    lastClicked = null;
    // The player swaps its play icon for a pause icon or a spinner as soon as
    // it reacts, well before a message that still needs downloading plays.
    const before = button.innerHTML;
    const done = () => pending.started || pending.settled;
    const reacted = () =>
      done() || !button.isConnected || button.innerHTML !== before;
    let pressed = false;
    for (const press of PRESSES) {
      press(button);
      await wait(700);
      if (reacted()) {
        pressed = true;
        break;
      }
    }
    // Without a reaction, ask right away. After one, give WhatsApp time to
    // download the message before suggesting a manual press.
    setTimeout(
      () => {
        if (!done()) onWaitingForUser(pressed);
      },
      pressed ? 10_000 : 0,
    );
    return result;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.wvt !== 'main') return;
    const { type, reqId, blob, message } = event.data;
    if (type === 'capture-started') {
      const pending = captures.get(reqId);
      if (pending) pending.started = true;
    } else if (type === 'captured' || type === 'capture-failed') {
      const pending = captures.get(reqId);
      captures.delete(reqId);
      if (pending) pending.settled = true;
      if (type === 'captured') pending?.resolve(blob);
      else pending?.reject(new Error(message));
    } else if (type === 'played') {
      if (!lastClicked || Date.now() - lastClicked.at > 60_000) return;
      const { id } = lastClicked;
      lastClicked = null;
      played.delete(id);
      played.set(id, blob);
      if (played.size > MAX_PLAYED) played.delete(played.keys().next().value);
      if (settings.autoTranscribeOnPlay && !states.has(id)) transcribe(id);
    }
  });

  // Remembers which voice message the user last pressed play on, to pair it
  // with the audio the main world reports.
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      const message = event.target.closest?.(MESSAGE);
      if (message?.querySelector(VOICE_MARKER)) {
        lastClicked = { id: message.dataset.id, at: Date.now() };
      }
    },
    true,
  );

  // Engine.

  let engine = null;

  function getEngine() {
    engine ??= new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.src = ext.runtime.getURL('src/engine.html');
      iframe.dataset.wvtEngine = '';
      iframe.className = 'wvt-engine';
      iframe.tabIndex = -1;
      iframe.setAttribute('aria-hidden', 'true');
      const onReady = (event) => {
        if (
          event.source === iframe.contentWindow &&
          event.data?.wvt === 'engine' &&
          event.data.type === 'ready'
        ) {
          window.removeEventListener('message', onReady);
          resolve(iframe);
        }
      };
      window.addEventListener('message', onReady);
      // Outside of `<body>`, which WhatsApp's UI framework owns.
      document.documentElement.append(iframe);
    });
    return engine;
  }

  window.addEventListener('message', async (event) => {
    if (event.data?.wvt !== 'engine' || !engine) return;
    const iframe = await engine;
    if (event.source !== iframe.contentWindow) return;
    const { type, reqId, ...data } = event.data;
    if (managing.has(reqId)) {
      if (type !== 'progress') managing.delete(reqId);
      ext.runtime
        .sendMessage({
          type: 'wvt-model-event',
          event: { type, reqId, ...data },
        })
        .catch(() => {
          // The options page was closed.
        });
      return;
    }
    const id = requests.get(reqId);
    if (!id) return;
    if (type === 'progress') {
      const state = states.get(id) ?? {};
      update(id, {
        ...state,
        ...data,
        text: data.text ?? (data.stage === 'transcribe' ? '' : state.text),
      });
    } else if (type === 'result') {
      requests.delete(reqId);
      const transcript = {
        text: data.text,
        language: data.language,
        modelLabel: data.modelLabel,
        at: Date.now(),
      };
      update(id, { status: 'done', ...transcript });
      saveTranscript(id, transcript);
    } else if (type === 'error') {
      requests.delete(reqId);
      update(id, { status: 'error', message: data.message });
    }
  });

  // Model downloads and deletions requested from the options page run in this
  // tab's engine, so that they land in the storage it reads from: the options
  // page may see a different one (a Safari web app keeps its own website
  // data), and only this page has Cross-Origin Storage.
  const managing = new Set();

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'wvt-models') return;
    const reqId = `m${nextRequestId++}`;
    managing.add(reqId);
    getEngine().then((iframe) =>
      iframe.contentWindow.postMessage(
        { wvt: 'content', type: message.command, reqId, model: message.model },
        '*',
      ),
    );
    sendResponse({ reqId });
  });

  async function transcribe(id) {
    update(id, { status: 'working', stage: 'capture' });
    try {
      const blob =
        played.get(id) ??
        (await capture(id, (pressed) =>
          update(id, {
            status: 'working',
            stage: pressed ? 'waiting-play' : 'press-play',
          }),
        ));
      played.delete(id);
      const iframe = await getEngine();
      const reqId = nextRequestId++;
      requests.set(reqId, id);
      // Safari can serialize the extension's origin in a form `postMessage()`
      // rejects ("The string did not match the expected pattern"). The
      // target is this specific window, and the engine checks the sender.
      iframe.contentWindow.postMessage(
        { wvt: 'content', type: 'transcribe', reqId, blob },
        '*',
      );
    } catch (error) {
      update(id, { status: 'error', message: error.message });
    }
  }

  // UI.

  const ICONS = {
    transcribe:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>',
  };

  function findMessage(id) {
    return document.querySelector(`${MESSAGE}[data-id="${CSS.escape(id)}"]`);
  }

  function statusText(state) {
    switch (state.stage) {
      case 'capture':
        return 'Getting the audio…';
      case 'press-play':
        return 'Press play on the voice message to transcribe it.';
      case 'waiting-play':
        return 'Waiting for WhatsApp to play the voice message. If it does not start, press play.';
      case 'decode':
        return 'Decoding…';
      case 'download':
        return `Downloading ${state.label}… ${Math.floor(
          (100 * state.loaded) / state.total,
        )} % of ${formatBytes(state.total)}`;
      case 'load':
        return `Loading ${state.label}…`;
      case 'detect':
        return 'Detecting the language…';
      case 'transcribe':
        return 'Transcribing…';
      default:
        return 'Working…';
    }
  }

  function button(className, icon, label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.innerHTML = ICONS[icon];
    element.title = label;
    element.setAttribute('aria-label', label);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick(element);
    });
    return element;
  }

  function render(container, id) {
    const state = states.get(id);
    const card = document.createElement('div');
    card.className = 'wvt-card';

    if (!state || state.status === 'error') {
      const start = button('wvt-start', 'transcribe', 'Transcribe', () =>
        transcribe(id),
      );
      start.append(state ? 'Try again' : 'Transcribe');
      card.append(start);
      if (state) {
        const error = document.createElement('p');
        error.className = 'wvt-error';
        error.textContent = state.message;
        card.append(error);
      }
    } else if (state.status === 'working') {
      const status = document.createElement('p');
      status.className = 'wvt-status';
      status.setAttribute('role', 'status');
      status.textContent = statusText(state);
      card.append(status);
      if (state.text) {
        const text = document.createElement('p');
        text.className = 'wvt-text';
        text.dir = 'auto';
        text.textContent = state.text;
        card.append(text);
      }
    } else {
      const text = document.createElement('p');
      text.className = 'wvt-text';
      text.dir = 'auto';
      text.textContent = state.text || '(No speech recognized.)';
      const meta = document.createElement('div');
      meta.className = 'wvt-meta';
      const label = document.createElement('span');
      label.textContent = [
        state.language && languageName(state.language),
        state.modelLabel,
      ]
        .filter(Boolean)
        .join(' · ');
      meta.append(
        label,
        button('wvt-icon', 'copy', 'Copy transcript', async (element) => {
          await navigator.clipboard.writeText(state.text);
          element.classList.add('wvt-done');
          setTimeout(() => element.classList.remove('wvt-done'), 1000);
        }),
        button('wvt-icon', 'redo', 'Transcribe again', () => transcribe(id)),
      );
      card.append(text, meta);
    }
    container.replaceChildren(card);
  }

  function update(id, state) {
    states.set(id, state);
    const container = document.querySelector(
      `.wvt[data-wvt-id="${CSS.escape(id)}"]`,
    );
    if (container) render(container, id);
  }

  function attach(message) {
    const id = message.dataset.id;
    // Below the message's whole row, outside of WhatsApp's own bubble markup.
    const anchor = message.closest('[role="row"]') ?? message;
    const next = anchor.nextElementSibling;
    if (next?.classList.contains('wvt') && next.dataset.wvtId === id) return;
    const container = document.createElement('div');
    container.className = 'wvt';
    container.dataset.wvtId = id;
    container.dataset.direction = id.startsWith('true_') ? 'out' : 'in';
    render(container, id);
    anchor.after(container);
  }

  function scan() {
    const root = document.querySelector('#main') ?? document.body;
    const seen = new Set();
    for (const marker of root.querySelectorAll(VOICE_MARKER)) {
      const message = marker.closest(MESSAGE);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      attach(message);
    }
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  });

  transcriptsReady.then(() => {
    scan();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
