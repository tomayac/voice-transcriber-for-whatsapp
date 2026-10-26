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

// Cross-Origin Storage bridge. The COS extension only defines
// `navigator.crossOriginStorage` in web pages, never in another extension's
// pages or workers, so this shim forwards each call to the WhatsApp page, where
// the polyfill (or a native implementation) lives. It covers the subset that
// Transformers.js uses: `requestFileHandle()`, `getFile()`, and
// `createWritable()`.

const cosPending = new Map();
let cosNextId = 1;

// A COS call that never settles would stall the model load for good, while a
// rejected one only makes Transformers.js fall back to the network. Writes get
// time in proportion to their size, since the page hashes what it stores.
function cosTimeout(op, data) {
  if (op === 'write') return 60_000 + data.blob.size / 10_000;
  return op === 'getFile' ? 120_000 : 30_000;
}

function cosRequest(op, data = {}) {
  const id = cosNextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        cosPending.delete(id);
        reject(
          new DOMException(
            `Cross-Origin Storage ${op} timed out.`,
            'TimeoutError',
          ),
        );
      },
      cosTimeout(op, data),
    );
    cosPending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    postMessage({ type: 'cos', id, op, ...data });
  });
}

function cosReply({ id, error, ...data }) {
  const pending = cosPending.get(id);
  if (!pending) return;
  cosPending.delete(id);
  if (error) {
    pending.reject(new DOMException(error.message, error.name));
  } else {
    pending.resolve(data);
  }
}

function installCrossOriginStorageShim() {
  const fileHandle = (handleId) => ({
    kind: 'file',
    async getFile() {
      const { file } = await cosRequest('getFile', { handleId });
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
          await cosRequest('write', { handleId, blob: new Blob(parts) });
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
  });
  const getFileHandle = async (hash, options = {}) => {
    const { handleId } = await cosRequest('getFileHandle', {
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

function progressReporter(reqId, label) {
  const files = new Map();
  let last = 0;
  return (info) => {
    if (info.status === 'progress' && info.total) {
      files.set(info.file, [info.loaded, info.total]);
      const now = performance.now();
      if (now - last < 250 && info.loaded < info.total) return;
      last = now;
      let done = 0;
      let total = 0;
      for (const [l, t] of files.values()) {
        done += l;
        total += t;
      }
      postMessage({
        type: 'progress',
        reqId,
        stage: 'download',
        label,
        loaded: done,
        total,
      });
    } else if (info.status === 'done' || info.status === 'ready') {
      postMessage({ type: 'progress', reqId, stage: 'load', label });
    }
  };
}

async function loadModel(modelId, preference, reqId) {
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
    const progress_callback = progressReporter(reqId, spec.label);
    postMessage({ type: 'progress', reqId, stage: 'load', label: spec.label });
    const promise = (async () => {
      if (spec.family === 'whisper') {
        const asr = await pipeline('automatic-speech-recognition', spec.repo, {
          device,
          dtype,
          progress_callback,
        });
        return { spec, asr, dispose: () => asr.dispose() };
      }
      const [model, processor] = await Promise.all([
        VoxtralRealtimeForConditionalGeneration.from_pretrained(spec.repo, {
          device,
          dtype,
          progress_callback,
        }),
        VoxtralRealtimeProcessor.from_pretrained(spec.repo),
      ]);
      return { spec, model, processor, dispose: () => model.dispose() };
    })();
    loaded.set(key, promise);
    promise.then(
      () => markDownloaded(modelId, deviceKey),
      () => loaded.delete(key),
    );
  }
  return loaded.get(key);
}

// Downloads. Transformers.js keeps files in Cache Storage (or, through the
// shim, Cross-Origin Storage) without saying whether a model is complete, so a
// marker records each model that loaded successfully.

const MARKERS = 'voice-transcriber-downloads';
const markerUrl = (modelId, deviceKey) =>
  `https://voice-transcriber.invalid/${modelId}/${deviceKey}`;

async function markDownloaded(modelId, deviceKey) {
  const markers = await caches.open(MARKERS);
  await markers.put(markerUrl(modelId, deviceKey), new Response(''));
}

async function modelsStatus(preference) {
  const deviceKey = await resolveDevice(preference).catch(() => 'wasm');
  const [files, hashes, markers] = await Promise.all(
    [env.cacheKey, HASH_CACHE, MARKERS].map((name) => caches.open(name)),
  );
  const [fileKeys, hashKeys] = await Promise.all([files.keys(), hashes.keys()]);
  const status = {};
  for (const [id, spec] of Object.entries(MODELS)) {
    const prefix = `/${spec.repo}/`;
    let bytes = 0;
    for (const key of fileKeys.filter((k) => k.url.includes(prefix))) {
      // Only the headers: the bodies run to gigabytes.
      const response = await files.match(key);
      bytes += Number(response?.headers.get('content-length')) || 0;
    }
    status[id] = {
      bytes,
      inCrossOriginStorage: hashKeys.some((k) => k.url.includes(prefix)),
      complete: !!(await markers.match(markerUrl(id, deviceKey))),
      available: !!spec.dtype[deviceKey],
    };
  }
  return { deviceKey, status };
}

async function downloadModel({ reqId, model, settings }) {
  await loadModel(model, settings.device, reqId);
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
  for (const name of [env.cacheKey, HASH_CACHE]) {
    const cache = await caches.open(name);
    for (const key of await cache.keys()) {
      if (key.url.includes(prefix)) await cache.delete(key);
    }
  }
  const markers = await caches.open(MARKERS);
  for (const key of await markers.keys()) {
    if (key.url.includes(`/${model}/`)) await markers.delete(key);
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
    const bundle = await loadModel(settings.model, settings.device, reqId);
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
    const fallback = await loadModel(
      settings.fallbackModel,
      settings.device,
      reqId,
    );
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
  const bundle = await loadModel(settings.model, settings.device, reqId);
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

function enqueue(data, task) {
  queue = queue.then(() => respond(data, task));
}

addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'init':
      if (data.crossOriginStorage) {
        installCrossOriginStorageShim();
        env.experimental_useCrossOriginStorage = true;
      }
      break;
    case 'cos-reply':
      cosReply(data);
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
