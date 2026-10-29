// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Runs in WhatsApp's own JavaScript world, for three jobs.
//
// 1. Capturing voice messages. WhatsApp downloads and decrypts a voice message
//    when its play button is pressed, then plays the result from a `blob:` URL
//    through a media element. Wrapping `HTMLMediaElement.prototype.play()`
//    hands over those bytes without reimplementing any of WhatsApp's media
//    handling. To transcribe a message that has not been played, the content
//    script arms a capture and presses the message's play button; the
//    captured playback is muted and stopped right away.
//
// 2. Storing the models. Safari gives the extension a new origin with every
//    launch and leaves that origin's Cache Storage behind, so the engine keeps
//    models in this page's origin, which stays put, through this script.
//
// 3. Bridging Cross-Origin Storage. The engine iframe has an extension origin,
//    where the COS extension's `navigator.crossOriginStorage` does not exist,
//    so it asks this page to make the calls on its behalf.

(() => {
  // Some browsers run this file in the isolated world in spite of
  // `"world": "MAIN"`. Patches made there would never reach WhatsApp, so bail
  // and let the content script inject it as a page script.
  if (globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id) {
    return;
  }
  if (document.documentElement.dataset.vtwMain) return;
  document.documentElement.dataset.vtwMain = '1';

  const toContent = (message) =>
    window.postMessage({ vtw: 'main', ...message }, location.origin);

  // Voice message capture.

  let armed = null;

  function arm(reqId) {
    let settled = false;
    const capture = { blob: null, reqId };
    const finish = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (armed === capture) armed = null;
      toContent({ reqId, ...message });
    };
    capture.resolve = (blob) => finish({ type: 'captured', blob });
    capture.reject = (error) =>
      finish({ type: 'capture-failed', message: error.message });
    // Long enough for WhatsApp to download a message it does not have yet.
    const timeout = setTimeout(() => {
      if (capture.blob) {
        capture.resolve(capture.blob);
      } else {
        capture.reject(
          new Error('WhatsApp did not start playing the voice message.'),
        );
      }
    }, 60_000);
    armed = capture;
  }

  function silence(media) {
    const { muted } = media;
    media.muted = true;
    media.addEventListener(
      'playing',
      () => {
        media.pause();
        media.currentTime = 0;
        media.muted = muted;
      },
      { once: true },
    );
  }

  async function sourceBlob(media) {
    let src = media.currentSrc || media.src;
    if (!src) {
      await new Promise((resolve) =>
        media.addEventListener('loadstart', resolve, { once: true }),
      );
      src = media.currentSrc || media.src;
    }
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Fetching the audio failed.`);
    return response.blob();
  }

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    if (armed && object instanceof Blob && object.type.startsWith('audio/')) {
      armed.blob ??= object;
    }
    return originalCreateObjectURL.apply(this, arguments);
  };

  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const capture = armed;
    if (capture) {
      armed = null;
      silence(this);
      // Tells the content script that pressing play worked.
      toContent({ type: 'capture-started', reqId: capture.reqId });
      (capture.blob ? Promise.resolve(capture.blob) : sourceBlob(this)).then(
        capture.resolve,
        capture.reject,
      );
    } else if (this instanceof HTMLAudioElement) {
      // The user pressed play. Hand the audio over too, so that transcribing
      // a message that already played needs no second round.
      const src = this.currentSrc || this.src;
      if (src.startsWith('blob:')) {
        sourceBlob(this).then(
          (blob) => toContent({ type: 'played', blob }),
          () => {},
        );
      }
    }
    return originalPlay.apply(this, arguments);
  };

  // In case WhatsApp ever plays voice messages through Web Audio. Playback
  // cannot be silenced on this path.
  const originalDecodeAudioData = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (data) {
    const capture = armed;
    if (capture && data instanceof ArrayBuffer) {
      armed = null;
      capture.resolve(new Blob([data.slice(0)]));
    }
    return originalDecodeAudioData.apply(this, arguments);
  };

  // Storage bridge. Only the extension's own caches can be reached through
  // it, never the ones WhatsApp keeps.

  const CACHES = new Set([
    'voice-transcriber-models',
    'voice-transcriber-downloads',
  ]);
  const pageCaches = window.caches;

  function openCache(name) {
    if (!CACHES.has(name)) throw new Error(`Unknown cache “${name}”.`);
    return pageCaches.open(name);
  }

  const handles = new Map();
  let nextHandleId = 1;

  // Model files travel in transferred `ArrayBuffer` chunks of 16 MB, and each
  // chunk is a cache entry of its own, next to an index entry under the file's
  // URL. WebKit loads a whole cache entry into the reading process, so one
  // gigabyte-sized entry could take down the WhatsApp tab, and it fails to
  // store large `Blob` bodies at all. The index goes in last, so a write that
  // never finished leaves nothing to find.
  const CHUNK_SIZE = 16 * 1024 * 1024;
  const PART = '?vtw-part=';
  const partUrl = (url, index) => `${url}${PART}${index}`;
  const reads = new Map();
  const writes = new Map();
  let nextStreamId = 1;

  async function deleteEntry(cache, url) {
    // Also parts of a write that never finished, which have no index.
    for (const request of await cache.keys()) {
      if (request.url.startsWith(`${url}${PART}`)) await cache.delete(request);
    }
    return cache.delete(url);
  }

  // The index's own size header, or, for a file an earlier version stored
  // whole, its body's.
  const entrySize = (response) =>
    Number(
      response?.headers.get('x-vtw-size') ??
        response?.headers.get('content-length'),
    ) || 0;

  async function pageOperation(op, message) {
    const cos = navigator.crossOriginStorage;
    switch (op) {
      case 'ping':
        return { crossOriginStorage: !!cos, caches: !!pageCaches };
      case 'cache-match': {
        const cache = await openCache(message.cache);
        const response = await cache.match(message.url);
        if (!response) return {};
        const readId = nextStreamId++;
        if (response.headers.has('x-vtw-parts')) {
          const { headers } = await response.json();
          const parts = Number(response.headers.get('x-vtw-parts'));
          reads.set(readId, { cache, url: message.url, parts, next: 0 });
          return { readId, headers };
        }
        // Stored whole, by an earlier version.
        reads.set(readId, { reader: response.body.getReader() });
        return { readId, headers: [...response.headers] };
      }
      case 'cache-read': {
        const read = reads.get(message.readId);
        if (read.reader) {
          const { value, done } = await read.reader.read();
          if (done) reads.delete(message.readId);
          return { chunk: done ? null : value.slice().buffer };
        }
        if (read.next >= read.parts) {
          reads.delete(message.readId);
          return { chunk: null };
        }
        const part = await read.cache.match(partUrl(read.url, read.next++));
        if (!part) throw new Error('A stored model file is incomplete.');
        return { chunk: await part.arrayBuffer() };
      }
      case 'cache-read-cancel':
        reads.get(message.readId)?.reader?.cancel();
        reads.delete(message.readId);
        return {};
      case 'cache-write': {
        const cache = await openCache(message.cache);
        await deleteEntry(cache, message.url);
        const writeId = nextStreamId++;
        writes.set(writeId, {
          cache,
          url: message.url,
          headers: message.headers,
          parts: 0,
          size: 0,
        });
        return { writeId };
      }
      case 'cache-write-chunk': {
        const write = writes.get(message.writeId);
        await write.cache.put(
          partUrl(write.url, write.parts++),
          new Response(message.chunk),
        );
        write.size += message.chunk.byteLength;
        return {};
      }
      case 'cache-write-end': {
        const write = writes.get(message.writeId);
        writes.delete(message.writeId);
        const headers = write.headers.filter(
          ([name]) => name.toLowerCase() !== 'content-length',
        );
        headers.push(['content-length', String(write.size)]);
        await write.cache.put(
          write.url,
          new Response(JSON.stringify({ headers }), {
            headers: {
              'content-type': 'application/json',
              'x-vtw-parts': String(write.parts),
              'x-vtw-size': String(write.size),
            },
          }),
        );
        return {};
      }
      case 'cache-delete': {
        const cache = await openCache(message.cache);
        return { deleted: await deleteEntry(cache, message.url) };
      }
      case 'cache-list': {
        const cache = await openCache(message.cache);
        const entries = [];
        for (const request of await cache.keys()) {
          if (request.url.includes(PART)) continue;
          if (!request.url.includes(message.prefix)) continue;
          const response = message.sizes ? await cache.match(request) : null;
          entries.push({ url: request.url, size: entrySize(response) });
        }
        return { entries };
      }
      case 'getFileHandle': {
        // `requestFileHandle()` is the older name of the same method.
        const getFileHandle = cos.getFileHandle ?? cos.requestFileHandle;
        const handle = await getFileHandle.call(
          cos,
          message.hash,
          message.options,
        );
        const handleId = nextHandleId++;
        handles.set(handleId, handle);
        return { handleId };
      }
      case 'getFile': {
        const handle = handles.get(message.handleId);
        handles.delete(message.handleId);
        return { file: await handle.getFile() };
      }
      case 'write': {
        const handle = handles.get(message.handleId);
        handles.delete(message.handleId);
        const writable = await handle.createWritable();
        await writable.write(message.blob);
        await writable.close();
        return {};
      }
      default:
        throw new Error(`Unknown operation “${op}”.`);
    }
  }

  window.addEventListener('message', async (event) => {
    const message = event.data;
    if (message?.vtw === 'content' && event.source === window) {
      if (message.type === 'arm') arm(message.reqId);
      if (message.type === 'disarm') armed = null;
      return;
    }
    if (message?.vtw !== 'engine-page') return;
    const engine = document.querySelector('iframe[data-vtw-engine]');
    if (!engine || event.source !== engine.contentWindow) return;
    let reply;
    try {
      reply = await pageOperation(message.op, message);
    } catch (error) {
      reply = { error: { name: error.name, message: error.message } };
    }
    // Not `event.origin`: Safari can report the extension's origin in a form
    // `postMessage()` rejects as a target. `event.source` was checked above.
    event.source.postMessage(
      { vtw: 'page-reply', id: message.id, ...reply },
      '*',
      reply.chunk ? [reply.chunk] : [],
    );
  });
})();
