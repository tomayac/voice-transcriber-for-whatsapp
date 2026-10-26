// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// The engine page. The content script embeds it as a hidden iframe in
// WhatsApp, so it runs with the extension's origin and permissions (model
// downloads, WebGPU in its own process) while staying alive exactly as long as
// the WhatsApp tab. It decodes audio, which workers cannot do, and owns the
// inference worker.

import { ext, getSettings } from './shared.js';

const SAMPLE_RATE = 16000;

// `web_accessible_resources` already limits who can embed this page; only talk
// to that embedder. Should neither source name it (Safari may withhold the
// referrer), fall back to `'*'`: the target is `parent` either way.
const pageOrigin = (() => {
  try {
    const { origin } = new URL(
      location.ancestorOrigins?.[0] || document.referrer,
    );
    return origin.startsWith('http') ? origin : '*';
  } catch {
    return '*';
  }
})();

const toPage = (message) =>
  parent.postMessage({ wvt: 'engine', ...message }, pageOrigin);

// Cross-Origin Storage requests travel worker → here → page main world.
const cosPending = new Map();
let cosNextId = -1;

function cosToPage(message) {
  parent.postMessage({ wvt: 'engine-cos', ...message }, pageOrigin);
}

function pingCrossOriginStorage() {
  const id = cosNextId--;
  return new Promise((resolve) => {
    cosPending.set(id, ({ available }) => resolve(!!available));
    cosToPage({ id, op: 'ping' });
    // The main-world script is missing if injection failed: no bridge then.
    setTimeout(() => {
      if (cosPending.delete(id)) resolve(false);
    }, 2000);
  });
}

let worker = null;
let workerReady = null;
let idleTimer = null;
const inFlight = new Set();
// The worker messages that complete a request.
const FINAL = new Set([
  'result',
  'error',
  'models-status',
  'downloaded',
  'deleted',
]);

function stopWorker() {
  worker?.terminate();
  worker = null;
  workerReady = null;
}

function getWorker(settings) {
  workerReady ??= startWorker(settings);
  return workerReady;
}

async function startWorker(settings) {
  worker = new Worker(new URL('./worker.js', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', ({ data }) => {
    if (data.type === 'cos') {
      const { type, ...request } = data;
      cosToPage(request);
      return;
    }
    if (FINAL.has(data.type)) {
      inFlight.delete(data.reqId);
      scheduleIdleUnload(settings);
    }
    const { type, ...rest } = data;
    toPage({ type, ...rest });
  });
  worker.addEventListener('error', (event) => {
    // A module that fails to load, or a worker the browser killed, typically
    // for running out of memory.
    const message = event.message || 'The transcription worker crashed.';
    for (const reqId of inFlight) toPage({ type: 'error', reqId, message });
    inFlight.clear();
    stopWorker();
  });
  const crossOriginStorage =
    settings.useCrossOriginStorage && (await pingCrossOriginStorage());
  worker.postMessage({ type: 'init', crossOriginStorage });
  return worker;
}

function scheduleIdleUnload(settings) {
  clearTimeout(idleTimer);
  if (inFlight.size || !settings.idleUnloadMinutes) return;
  idleTimer = setTimeout(stopWorker, settings.idleUnloadMinutes * 60 * 1000);
}

async function decode(blob) {
  // Resamples to 16 kHz as part of decoding.
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) {
      mono[i] += channel[i] / buffer.numberOfChannels;
    }
  }
  return mono;
}

async function transcribe(reqId, blob) {
  clearTimeout(idleTimer);
  inFlight.add(reqId);
  try {
    toPage({ type: 'progress', reqId, stage: 'decode' });
    const [audio, settings] = await Promise.all([decode(blob), getSettings()]);
    const target = await getWorker(settings);
    target.postMessage({ type: 'transcribe', reqId, audio, settings }, [
      audio.buffer,
    ]);
  } catch (error) {
    inFlight.delete(reqId);
    toPage({
      type: 'error',
      reqId,
      message:
        error?.name === 'EncodingError'
          ? 'The browser could not decode this voice message.'
          : (error?.message ?? String(error)),
    });
  }
}

// Model downloads, deletions, and status, requested from the options page.
async function manage(message) {
  clearTimeout(idleTimer);
  inFlight.add(message.reqId);
  try {
    const settings = await getSettings();
    const target = await getWorker(settings);
    target.postMessage({ ...message, settings });
  } catch (error) {
    inFlight.delete(message.reqId);
    toPage({ type: 'error', reqId: message.reqId, message: error.message });
  }
}

addEventListener('message', (event) => {
  if (event.source !== parent) return;
  if (pageOrigin !== '*' && event.origin !== pageOrigin) return;
  const message = event.data;
  if (message?.wvt === 'cos-reply') {
    const { wvt, ...reply } = message;
    if (reply.id < 0) {
      cosPending.get(reply.id)?.(reply);
      cosPending.delete(reply.id);
    } else {
      worker?.postMessage({ type: 'cos-reply', ...reply });
    }
  } else if (message?.wvt === 'content') {
    const { wvt, ...request } = message;
    if (request.type === 'transcribe') {
      transcribe(request.reqId, request.blob);
    } else if (['models-status', 'download', 'delete'].includes(request.type)) {
      manage(request);
    }
  }
});

// Settings changes take effect with the next message; the worker swaps models
// lazily. A changed storage preference needs a fresh worker, though.
ext.storage.onChanged.addListener((changes) => {
  const { oldValue, newValue } = changes.settings ?? {};
  if (
    oldValue?.useCrossOriginStorage !== newValue?.useCrossOriginStorage &&
    !inFlight.size
  ) {
    stopWorker();
  }
});

toPage({ type: 'ready' });
