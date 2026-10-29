// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Runs the speech models. Lives in a module worker started by the engine page,
// which feeds it 16 kHz mono audio and relays Cross-Origin Storage calls.

import {
  env,
  pipeline,
  BaseStreamer,
  Tensor,
  TextStreamer,
  VoxtralRealtimeForConditionalGeneration,
  VoxtralRealtimeProcessor,
} from '../vendor/transformers.min.js';
import { MODELS, WHISPER_LANGUAGES } from './shared.js';

const SAMPLE_RATE = 16000;
// Where Transformers.js keeps the URL-to-hash map for Cross-Origin Storage.
const HASH_CACHE = 'experimental_transformers-hash-cache';

env.allowLocalModels = false;
// Extensions may not load code from a CDN, so point ONNX Runtime at the copy
// that ships in `vendor/`. That copy needs no caching, and the cache would
// import it from a `blob:` URL, which the extension's CSP blocks.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../vendor/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url)
    .href,
  wasm: new URL(
    '../vendor/ort-wasm-simd-threaded.asyncify.wasm',
    import.meta.url,
  ).href,
};

// The WhatsApp page, reached through the engine and `main-world.js`. It
// stores the models (see "Model storage" below) and hosts Cross-Origin
// Storage.

const pagePending = new Map();
let pageNextId = 1;

// A call that never settles would stall the model load for good, while a
// rejected one only makes Transformers.js fall back to the network. Writes get
// time in proportion to their size.
// WebKit's Cache Storage can take many seconds to list or open entries right
// after storing a gigabyte-sized one, so cache operations get two minutes.
function pageTimeout(op, data) {
  if (op === 'write') return 60_000 + data.blob.size / 10_000;
  return op === 'ping' || op === 'getFileHandle' ? 30_000 : 120_000;
}

function pageRequest(op, data = {}, transfer = []) {
  const id = pageNextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pagePending.delete(id);
        reject(
          new DOMException(
            `The WhatsApp page did not answer (${op}).`,
            'TimeoutError',
          ),
        );
      },
      pageTimeout(op, data),
    );
    pagePending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    postMessage({ type: 'page', id, op, ...data }, transfer);
  });
}

function pageReply({ id, error, ...data }) {
  const pending = pagePending.get(id);
  if (!pending) return;
  pagePending.delete(id);
  if (error) {
    pending.reject(new DOMException(error.message, error.name));
  } else {
    pending.resolve(data);
  }
}

// Cross-Origin Storage. The COS extension only defines
// `navigator.crossOriginStorage` in web pages, never in another extension's
// pages or workers, so this shim forwards each call to the WhatsApp page,
// where the polyfill (or a native implementation) lives. It covers the subset
// that Transformers.js uses: `requestFileHandle()`, `getFile()`, and
// `createWritable()`.

function installCrossOriginStorageShim() {
  const fileHandle = (handleId) => ({
    kind: 'file',
    async getFile() {
      const { file } = await pageRequest('getFile', { handleId });
      return file;
    },
    async createWritable() {
      // Buffered locally and sent as one `Blob` on `close()`: posting a `Blob`
      // between frames passes a reference, so this costs no extra copy.
      const parts = [];
      return {
        async write(data) {
          parts.push(data);
        },
        async close() {
          await pageRequest('write', { handleId, blob: new Blob(parts) });
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
  });
  const getFileHandle = async (hash, options = {}) => {
    const { handleId } = await pageRequest('getFileHandle', {
      hash,
      options,
    });
    return fileHandle(handleId);
  };
  Object.defineProperty(navigator, 'crossOriginStorage', {
    configurable: true,
    value: { getFileHandle, requestFileHandle: getFileHandle },
  });
}

// Model storage. Safari gives the extension a new origin with every launch
// (https://bugs.webkit.org/show_bug.cgi?id=259637) and leaves its Cache
// Storage behind, so models cached in this worker's origin would download
// again after every restart or update. The WhatsApp page's origin stays put,
// so models go there when the page can be reached, and Cross-Origin Storage
// takes precedence over both.

const MODEL_FILES = 'voice-transcriber-models';
const MARKERS = 'voice-transcriber-downloads';

const localStore = (name) => ({
  async match(url) {
    return (await caches.open(name)).match(url);
  },
  async put(url, response) {
    await (await caches.open(name)).put(url, response);
  },
  async delete(url) {
    return (await caches.open(name)).delete(url);
  },
  async list(prefix, { sizes = false } = {}) {
    const cache = await caches.open(name);
    const entries = [];
    for (const request of await cache.keys()) {
      if (!request.url.includes(prefix)) continue;
      // Only the headers: the bodies run to gigabytes.
      const response = sizes ? await cache.match(request) : null;
      const size = Number(response?.headers.get('content-length')) || 0;
      entries.push({ url: request.url, size });
    }
    return entries;
  },
});

// Files cross over to the page and back in chunks of this size, as transferred
// `ArrayBuffer`s, and the page streams them into and out of the cache. Safari
// fails to store a `Blob` body of more than some 100 MB ("Blob loading
// failed"), and holding a whole model file in a `Blob` would double its
// memory, too.
const CHUNK_SIZE = 16 * 1024 * 1024;

const pageStore = (name) => ({
  async match(url) {
    const { readId, headers } = await pageRequest('cache-match', {
      cache: name,
      url,
    });
    if (!readId) return undefined;
    const body = new ReadableStream({
      async pull(controller) {
        const { chunk } = await pageRequest('cache-read', { readId });
        if (chunk) controller.enqueue(new Uint8Array(chunk));
        else controller.close();
      },
      cancel() {
        pageRequest('cache-read-cancel', { readId }).catch(() => {});
      },
    });
    return new Response(body, { headers });
  },
  async put(url, response) {
    const { writeId } = await pageRequest('cache-write', {
      cache: name,
      url,
      headers: [...response.headers],
    });
    let chunk = new Uint8Array(CHUNK_SIZE);
    let filled = 0;
    const send = async () => {
      const buffer = chunk.buffer.slice(0, filled);
      chunk = new Uint8Array(CHUNK_SIZE);
      filled = 0;
      await pageRequest('cache-write-chunk', { writeId, chunk: buffer }, [
        buffer,
      ]);
    };
    // A body made from a whole model file may arrive as one huge piece.
    const reader = response.body?.getReader();
    for (;;) {
      const { value: piece, done } = (await reader?.read()) ?? { done: true };
      if (done) break;
      for (let offset = 0; offset < piece.length;) {
        const length = Math.min(CHUNK_SIZE - filled, piece.length - offset);
        chunk.set(piece.subarray(offset, offset + length), filled);
        filled += length;
        offset += length;
        if (filled === CHUNK_SIZE) await send();
      }
    }
    if (filled) await send();
    await pageRequest('cache-write-end', { writeId });
  },
  async delete(url) {
    return (await pageRequest('cache-delete', { cache: name, url })).deleted;
  },
  async list(prefix, { sizes = false } = {}) {
    return (await pageRequest('cache-list', { cache: name, prefix, sizes }))
      .entries;
  },
});

// Where Transformers.js caches by default, and where earlier versions of this
// extension kept the models.
const workerFiles = localStore(env.cacheKey);
let modelFiles = workerFiles;
let markers = localStore(MARKERS);

function usePageStorage() {
  modelFiles = pageStore(MODEL_FILES);
  markers = pageStore(MARKERS);
  env.useCustomCache = true;
  env.customCache = {
    async match(url) {
      const stored = await modelFiles.match(url);
      if (stored) return stored;
      // Move a file an earlier version cached in this worker's origin. That
      // helps in Chrome; in Safari, the origin has usually changed since.
      const old = await workerFiles.match(url);
      if (!old) return undefined;
      await modelFiles.put(url, old);
      await workerFiles.delete(url);
      return modelFiles.match(url);
    },
    put: (url, response) => modelFiles.put(url, response),
  };
}

// Device selection.

let devicePromise = null;

function resolveDevice(preference) {
  devicePromise ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return 'wasm';
    return adapter.features.has('shader-f16') ? 'webgpu-f16' : 'webgpu';
  })();
  return devicePromise.then((best) => {
    if (preference === 'wasm') return 'wasm';
    if (preference === 'webgpu' && best === 'wasm') {
      throw new Error('WebGPU is not available in this browser.');
    }
    return best;
  });
}

// Model loading. Loaded models stay around until the settings stop asking for
// them; the engine terminates the whole worker when idle to free memory.

const loaded = new Map();

// Requests waiting on the worker, active or queued. Downloading or loading a
// model holds up all of them, so they all see its progress.
const waiting = new Set();
// What the worker is downloading or loading, for the settings to show.
let busy = null;

function broadcast(progress) {
  busy = progress;
  for (const reqId of waiting)
    postMessage({ type: 'progress', reqId, ...progress });
}

function progressReporter(modelId, label, files) {
  const sizes = new Map();
  let last = 0;
  return (info) => {
    if (info.status === 'progress' && info.total) {
      sizes.set(info.file, [info.loaded, info.total]);
      const now = performance.now();
      if (now - last < 250 && info.loaded < info.total) return;
      last = now;
      let done = 0;
      let total = 0;
      for (const [l, t] of sizes.values()) {
        done += l;
        total += t;
      }
      broadcast({
        stage: 'download',
        model: modelId,
        label,
        loaded: done,
        total,
      });
    } else if (info.status === 'done' || info.status === 'ready') {
      if (info.status === 'done' && info.file) files.add(info.file);
      broadcast({ stage: 'load', model: modelId, label });
    }
  };
}

// Transformers.js only logs a warning when the browser refuses to store a
// file (for example, past the storage quota), so check that the weights it
// fetched are really there. (With Cross-Origin Storage, it records small
// files like `config.json` in the background, so those may not show yet.)
async function missingFiles(spec, files) {
  const store = env.experimental_useCrossOriginStorage
    ? localStore(HASH_CACHE)
    : modelFiles;
  const stored = new Set(
    (await store.list(`/${spec.repo}/`)).map((entry) => entry.url),
  );
  return [...files]
    .filter((file) => file.startsWith('onnx/'))
    .filter(
      (file) =>
        !stored.has(`${env.remoteHost}${spec.repo}/resolve/main/${file}`),
    );
}

async function loadModel(modelId, preference) {
  const spec = MODELS[modelId];
  if (!spec) throw new Error(`Unknown model “${modelId}”.`);
  const deviceKey = await resolveDevice(preference);
  const dtype = spec.dtype[deviceKey];
  if (!dtype) {
    throw new Error(`${spec.label} needs WebGPU, which is not available.`);
  }
  const key = `${modelId}|${deviceKey}`;
  if (!loaded.has(key)) {
    const device = deviceKey === 'wasm' ? 'wasm' : 'webgpu';
    const files = new Set();
    const progress_callback = progressReporter(modelId, spec.label, files);
    broadcast({ stage: 'load', model: modelId, label: spec.label });
    const promise = (async () => {
      const bundle = await createModel();
      bundle.missing = await missingFiles(spec, files);
      if (!bundle.missing.length) await markDownloaded(modelId, deviceKey);
      return bundle;
    })();
    async function createModel() {
      if (spec.family === 'whisper') {
        const asr = await pipeline('automatic-speech-recognition', spec.repo, {
          device,
          dtype,
          progress_callback,
        });
        return { spec, files, asr, dispose: () => asr.dispose() };
      }
      const [model, processor] = await Promise.all([
        VoxtralRealtimeForConditionalGeneration.from_pretrained(spec.repo, {
          device,
          dtype,
          progress_callback,
        }),
        VoxtralRealtimeProcessor.from_pretrained(spec.repo),
      ]);
      return {
        spec,
        files,
        model,
        processor,
        dispose: () => model.dispose(),
      };
    }
    loaded.set(key, promise);
    promise.catch(() => loaded.delete(key));
  }
  const bundle = await loaded.get(key);
  busy = null;
  return bundle;
}

// Downloads. Transformers.js keeps files in Cache Storage (or, through the
// shim, Cross-Origin Storage) without saying whether a model is complete, so a
// marker records each model that loaded successfully.

const markerUrl = (modelId, deviceKey) =>
  `https://voice-transcriber.invalid/${modelId}/${deviceKey}`;

async function markDownloaded(modelId, deviceKey) {
  await markers.put(markerUrl(modelId, deviceKey), new Response(''));
}

async function modelsStatus(preference) {
  const deviceKey = await resolveDevice(preference).catch(() => 'wasm');
  const [files, hashes, marked] = await Promise.all([
    // Sizes cost a lookup per file, which WebKit makes slow for big ones.
    modelFiles.list('/', { sizes: true }),
    localStore(HASH_CACHE).list('/'),
    markers.list('/'),
  ]);
  const status = {};
  for (const [id, spec] of Object.entries(MODELS)) {
    const prefix = `/${spec.repo}/`;
    status[id] = {
      bytes: files
        .filter((entry) => entry.url.includes(prefix))
        .reduce((sum, entry) => sum + entry.size, 0),
      inCrossOriginStorage: hashes.some((entry) => entry.url.includes(prefix)),
      complete: marked.some((entry) => entry.url === markerUrl(id, deviceKey)),
      available: !!spec.dtype[deviceKey],
    };
  }
  return { deviceKey, status, busy };
}

async function downloadModel({ model, settings }) {
  const bundle = await loadModel(model, settings.device);
  if (bundle.missing.length) {
    throw new Error(
      `The browser did not keep ${bundle.missing.length} of the model’s ` +
        `${bundle.files.size} files, so it will download them again next ` +
        'time. It may be out of storage space for this site.',
    );
  }
  // Keep it loaded only if transcription is about to need it.
  const inUse = [settings.model];
  if (MODELS[settings.model].family !== 'whisper') {
    inUse.push(settings.fallbackModel);
  }
  if (!inUse.includes(model)) {
    await retainOnly(inUse);
  }
}

// Cross-Origin Storage has no delete operation, so for files stored there
// this removes the URL-to-hash entries Transformers.js looks them up by; the
// files themselves stay for other sites to use, until the COS extension
// removes them.
async function deleteModel({ model }) {
  await retainOnly(
    [...loaded.keys()]
      .map((key) => key.split('|')[0])
      .filter((id) => id !== model),
  );
  const prefix = `/${MODELS[model].repo}/`;
  // Also any copy left in this worker's origin by an earlier version.
  for (const store of new Set([
    modelFiles,
    workerFiles,
    localStore(HASH_CACHE),
  ])) {
    for (const { url } of await store.list(prefix)) await store.delete(url);
  }
  for (const { url } of await markers.list(`/${model}/`)) {
    await markers.delete(url);
  }
}

async function retainOnly(modelIds) {
  for (const [key, promise] of loaded) {
    if (modelIds.includes(key.split('|')[0])) continue;
    loaded.delete(key);
    try {
      await (await promise).dispose();
    } catch {
      // Failed loads have nothing to free.
    }
  }
}

// Whisper.

// Scores the language tokens Whisper predicts right after
// `<|startoftranscript|>`, restricted to `allowed`. Transformers.js has no
// language detection of its own and falls back to English.
async function detectLanguage({ asr }, audio, allowed) {
  const { tokenizer, processor, model } = asr;
  const sot = tokenizer.convert_tokens_to_ids('<|startoftranscript|>');
  const candidates = (allowed.length ? allowed : WHISPER_LANGUAGES)
    .map((code) => [code, tokenizer.convert_tokens_to_ids(`<|${code}|>`)])
    .filter(([, id]) => Number.isInteger(id) && id > sot);
  if (!candidates.length) return { language: null, probability: 0 };
  if (candidates.length === 1) {
    return { language: candidates[0][0], probability: 1 };
  }

  const { input_features } = await processor(
    audio.subarray(0, 30 * SAMPLE_RATE),
  );
  const output = await model({
    input_features,
    decoder_input_ids: new Tensor('int64', [BigInt(sot)], [1, 1]),
  });
  const vocabSize = output.logits.dims.at(-1);
  const logits = output.logits.data.subarray(-vocabSize);
  // On WebGPU the KV cache comes back as GPU buffers that nothing else frees.
  for (const [name, tensor] of Object.entries(output)) {
    if (name !== 'logits' && tensor?.location === 'gpu-buffer') {
      tensor.dispose();
    }
  }

  const scores = candidates.map(([, id]) => logits[id]);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const best = scores.indexOf(max);
  return { language: candidates[best][0], probability: exps[best] / sum };
}

async function transcribeWhisper({ asr }, audio, language, onText) {
  let partial = '';
  const streamer = new TextStreamer(asr.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => {
      partial += text;
      onText(partial);
    },
  });
  const { text } = await asr(audio, {
    language,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    streamer,
  });
  return text.trim();
}

// Voxtral Realtime. The model is built for live streams, so a finished voice
// message is fed to it as if it were arriving live, the way Mistral's WebGPU
// demo feeds microphone audio, with trailing silence so it flushes the last
// words.
async function transcribeVoxtral({ model, processor }, audio, onText) {
  const rawPerToken = processor.raw_audio_length_per_tok;
  const padded = new Float32Array(
    Math.max(
      audio.length + processor.num_right_pad_tokens * rawPerToken,
      processor.num_samples_first_audio_chunk,
    ),
  );
  padded.set(audio);

  const first = await processor(
    padded.subarray(0, processor.num_samples_first_audio_chunk),
    { is_streaming: true, is_first_audio_chunk: true },
  );
  const { hop_length, n_fft } = processor.feature_extractor.config;
  const halfWindow = Math.floor(n_fft / 2);
  // Encoder calls take up to two seconds of audio at a time.
  const maxChunk = 2 * SAMPLE_RATE;

  async function* features() {
    yield first.input_features;
    let melFrame = processor.num_mel_frames_first_audio_chunk;
    let start = melFrame * hop_length - halfWindow;
    while (start + processor.num_samples_per_audio_chunk <= padded.length) {
      let end = start + processor.num_samples_per_audio_chunk;
      while (end + rawPerToken <= padded.length && end - start < maxChunk) {
        end += rawPerToken;
      }
      const { input_features } = await processor(padded.slice(start, end), {
        is_streaming: true,
        is_first_audio_chunk: false,
      });
      yield input_features;
      melFrame += input_features.dims[2];
      start = melFrame * hop_length - halfWindow;
    }
  }

  const { tokenizer } = processor;
  const tokens = [];
  let isPrompt = true;
  const streamer = new (class extends BaseStreamer {
    put(value) {
      if (isPrompt) {
        isPrompt = false;
        return;
      }
      tokens.push(...value[0]);
      onText(tokenizer.decode(tokens, { skip_special_tokens: true }));
    }
    end() {}
  })();

  await model.generate({
    input_ids: first.input_ids,
    input_features: features(),
    max_new_tokens: Math.ceil(padded.length / rawPerToken) + 64,
    streamer,
  });
  // The trailing silence sometimes makes it repeat the final punctuation.
  return tokenizer
    .decode(tokens, { skip_special_tokens: true })
    .trim()
    .replace(/([.!?])\1+$/, '$1');
}

// Requests.

async function transcribe({ reqId, audio, settings }) {
  const primary = MODELS[settings.model];
  if (!primary) throw new Error(`Unknown model “${settings.model}”.`);
  const allowed = settings.languages ?? [];
  const onText = (text) =>
    postMessage({ type: 'progress', reqId, stage: 'transcribe', text });
  const detect = async (bundle) => {
    postMessage({ type: 'progress', reqId, stage: 'detect' });
    return detectLanguage(bundle, audio, allowed);
  };

  if (primary.family === 'whisper') {
    await retainOnly([settings.model]);
    const bundle = await loadModel(settings.model, settings.device);
    const { language, probability } = await detect(bundle);
    onText('');
    const text = await transcribeWhisper(bundle, audio, language, onText);
    return { text, language, probability, model: settings.model };
  }

  // Voxtral reports no language. Identify it with the Whisper fallback only
  // when some allowed language is one Voxtral does not cover, so that those
  // messages can go to Whisper.
  const needsLanguageId =
    !allowed.length || allowed.some((l) => !primary.languages.includes(l));
  await retainOnly(
    needsLanguageId
      ? [settings.model, settings.fallbackModel]
      : [settings.model],
  );
  let detected = { language: null, probability: 0 };
  if (needsLanguageId) {
    const fallback = await loadModel(settings.fallbackModel, settings.device);
    detected = await detect(fallback);
    if (!primary.languages.includes(detected.language)) {
      onText('');
      const text = await transcribeWhisper(
        fallback,
        audio,
        detected.language,
        onText,
      );
      return { text, ...detected, model: settings.fallbackModel };
    }
  }
  const bundle = await loadModel(settings.model, settings.device);
  onText('');
  const text = await transcribeVoxtral(bundle, audio, onText);
  return { text, ...detected, model: settings.model };
}

// One request at a time: the GPU is the bottleneck, and interleaving two
// generations would only slow both down.
let queue = Promise.resolve();

async function respond({ reqId }, task) {
  try {
    postMessage({ reqId, ...(await task()) });
  } catch (error) {
    console.error(error);
    postMessage({
      type: 'error',
      reqId,
      message: error?.message ?? String(error),
    });
  }
}

let queued = 0;

function enqueue(data, task) {
  waiting.add(data.reqId);
  if (queued++) {
    // Waiting behind a download shows that download's progress.
    postMessage({
      type: 'progress',
      reqId: data.reqId,
      stage: 'queued',
      ...busy,
    });
  }
  queue = queue.then(async () => {
    try {
      await respond(data, task);
    } finally {
      queued--;
      waiting.delete(data.reqId);
    }
  });
}

// Lets the engine tell a busy worker from one the browser killed without
// notice, which Safari does when a worker runs out of memory.
setInterval(() => postMessage({ type: 'alive' }), 5000);

addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'init':
      // Cross-Origin Storage wins; Transformers.js would otherwise prefer a
      // custom cache over it.
      if (data.crossOriginStorage) {
        installCrossOriginStorageShim();
        env.experimental_useCrossOriginStorage = true;
      } else if (data.pageStorage) {
        usePageStorage();
      }
      if (data.pageStorage) markers = pageStore(MARKERS);
      break;
    case 'page-reply':
      pageReply(data);
      break;
    case 'transcribe':
      enqueue(data, async () => {
        const result = await transcribe(data);
        return {
          type: 'result',
          modelLabel: MODELS[result.model].label,
          ...result,
        };
      });
      break;
    case 'models-status':
      // Read-only, so it need not wait for a download in progress.
      respond(data, async () => ({
        type: 'models-status',
        ...(await modelsStatus(data.settings.device)),
      }));
      break;
    case 'download':
      enqueue(data, async () => {
        await downloadModel(data);
        return { type: 'downloaded', model: data.model };
      });
      break;
    case 'delete':
      enqueue(data, async () => {
        await deleteModel(data);
        return { type: 'deleted', model: data.model };
      });
      break;
  }
});
