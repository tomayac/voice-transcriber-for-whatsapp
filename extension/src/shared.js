// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Model catalog and settings, shared by the options page, the engine page, and
// the inference worker.

export const ext = globalThis.browser ?? globalThis.chrome;

// Every language code Whisper has a language token for.
export const WHISPER_LANGUAGES = [
  'en',
  'zh',
  'de',
  'es',
  'ru',
  'ko',
  'fr',
  'ja',
  'pt',
  'tr',
  'pl',
  'ca',
  'nl',
  'ar',
  'sv',
  'it',
  'id',
  'hi',
  'fi',
  'vi',
  'he',
  'uk',
  'el',
  'ms',
  'cs',
  'ro',
  'da',
  'hu',
  'ta',
  'no',
  'th',
  'ur',
  'hr',
  'bg',
  'lt',
  'la',
  'mi',
  'ml',
  'cy',
  'sk',
  'te',
  'fa',
  'lv',
  'bn',
  'sr',
  'az',
  'sl',
  'kn',
  'et',
  'mk',
  'br',
  'eu',
  'is',
  'hy',
  'ne',
  'mn',
  'bs',
  'kk',
  'sq',
  'sw',
  'gl',
  'mr',
  'pa',
  'si',
  'km',
  'sn',
  'yo',
  'so',
  'af',
  'oc',
  'ka',
  'be',
  'tg',
  'sd',
  'gu',
  'am',
  'yi',
  'lo',
  'uz',
  'fo',
  'ht',
  'ps',
  'tk',
  'nn',
  'mt',
  'sa',
  'lb',
  'my',
  'bo',
  'tl',
  'mg',
  'as',
  'tt',
  'haw',
  'ln',
  'ha',
  'ba',
  'jw',
  'su',
  'yue',
];

// Per-device `dtype` maps follow what the Transformers.js WebGPU demos ship:
// a full-precision encoder (accuracy is sensitive there) with a 4-bit decoder.
// `f16` variants apply when the adapter supports `shader-f16`.
export const MODELS = {
  'whisper-large-v3-turbo': {
    family: 'whisper',
    label: 'Whisper large-v3 turbo',
    description:
      'Most accurate Whisper. Covers about 100 languages, including Catalan.',
    repo: 'onnx-community/whisper-large-v3-turbo',
    languages: WHISPER_LANGUAGES,
    dtype: {
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    size: { webgpu: '2.9 GB', 'webgpu-f16': '1.6 GB', wasm: '1.1 GB' },
  },
  'whisper-small': {
    family: 'whisper',
    label: 'Whisper small',
    description: 'Fast and light. Good enough for clear speech.',
    repo: 'onnx-community/whisper-small',
    languages: WHISPER_LANGUAGES,
    dtype: {
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    size: { webgpu: '590 MB', 'webgpu-f16': '410 MB', wasm: '250 MB' },
  },
  'whisper-base': {
    family: 'whisper',
    label: 'Whisper base',
    description: 'Smallest download. Noticeably less accurate.',
    repo: 'onnx-community/whisper-base',
    languages: WHISPER_LANGUAGES,
    dtype: {
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      'webgpu-f16': { encoder_model: 'fp16', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    },
    size: { webgpu: '210 MB', 'webgpu-f16': '170 MB', wasm: '80 MB' },
  },
  'voxtral-mini-4b-realtime': {
    family: 'voxtral-realtime',
    label: 'Voxtral Mini 4B Realtime',
    description:
      'Mistral’s streaming model. 13 languages, which excludes Catalan: ' +
      'messages in other languages go to the fallback model. Needs WebGPU.',
    repo: 'onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX',
    languages: [
      'en',
      'fr',
      'es',
      'de',
      'ru',
      'zh',
      'ja',
      'it',
      'pt',
      'nl',
      'ar',
      'hi',
      'ko',
    ],
    dtype: {
      webgpu: {
        audio_encoder: 'q4',
        embed_tokens: 'q4',
        decoder_model_merged: 'q4',
      },
      'webgpu-f16': {
        audio_encoder: 'q4f16',
        embed_tokens: 'q4f16',
        decoder_model_merged: 'q4f16',
      },
    },
    size: { webgpu: '3.2 GB', 'webgpu-f16': '2.8 GB' },
  },
};

export const DEFAULT_SETTINGS = {
  model: 'whisper-large-v3-turbo',
  // Used by Voxtral, which reports no language, to identify the language and
  // to transcribe the languages Voxtral does not cover.
  fallbackModel: 'whisper-small',
  // Language identification only considers these. Empty means all.
  languages: ['en', 'de', 'ca'],
  device: 'auto',
  autoTranscribeOnPlay: false,
  useCrossOriginStorage: true,
  idleUnloadMinutes: 10,
};

export async function getSettings() {
  const { settings } = await ext.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export function setSettings(settings) {
  return ext.storage.local.set({ settings });
}
