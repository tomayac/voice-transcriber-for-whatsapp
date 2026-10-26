// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

import {
  ext,
  MODELS,
  WHISPER_LANGUAGES,
  getSettings,
  setSettings,
} from './shared.js';

const form = document.querySelector('#settings');
const modelsElement = document.querySelector('#models');
const fallbackFieldset = document.querySelector('#fallback-fieldset');
const fallbackSelect = document.querySelector('#fallback');
const languagesElement = document.querySelector('#languages');
const addLanguage = document.querySelector('#add-language');
const deviceHint = document.querySelector('#device-hint');
const downloadsElement = document.querySelector('#downloads');
const downloadsHint = document.querySelector('#downloads-hint');

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
const byName = (a, b) => languageName(a).localeCompare(languageName(b));

let settings = await getSettings();

async function detectDevice() {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) return 'wasm';
  return adapter.features.has('shader-f16') ? 'webgpu-f16' : 'webgpu';
}
const bestDevice = await detectDevice();

function deviceKey() {
  if (settings.device === 'wasm') return 'wasm';
  return bestDevice;
}

async function save(changes) {
  settings = { ...settings, ...changes };
  render();
  await setSettings(settings);
  // The compute device decides which model files count as downloaded.
  refreshDownloads();
}

function renderModels() {
  const key = deviceKey();
  modelsElement.replaceChildren(
    ...Object.entries(MODELS).map(([id, model]) => {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'model';
      input.value = id;
      input.checked = settings.model === id;
      const size = model.size[key];
      input.disabled = !size;
      const title = document.createElement('strong');
      title.textContent = model.label;
      const details = document.createElement('span');
      details.textContent = `${model.description} ${
        size ? `Download: ${size}.` : 'Not available without WebGPU.'
      }`;
      const missing = settings.languages.filter(
        (l) => !model.languages.includes(l),
      );
      if (missing.length && model.family !== 'whisper') {
        const note = document.createElement('em');
        note.textContent = ` Handled by the fallback model: ${missing
          .map(languageName)
          .join(', ')}.`;
        details.append(note);
      }
      label.append(input, title, details);
      return label;
    }),
  );
  deviceHint.textContent = {
    'webgpu-f16': 'Runs on the GPU, with half-precision weights.',
    webgpu: 'Runs on the GPU.',
    wasm: 'Runs on the CPU, which is several times slower than the GPU.',
  }[key];
}

function renderFallback() {
  const voxtral = MODELS[settings.model].family !== 'whisper';
  fallbackFieldset.hidden = !voxtral;
  fallbackSelect.replaceChildren(
    ...Object.entries(MODELS)
      .filter(([, model]) => model.family === 'whisper')
      .map(([id, model]) => {
        const option = new Option(
          `${model.label} (${model.size[deviceKey()]})`,
          id,
        );
        option.selected = settings.fallbackModel === id;
        return option;
      }),
  );
}

function renderLanguages() {
  languagesElement.replaceChildren(
    ...[...settings.languages].sort(byName).map((code) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = languageName(code);
      chip.title = `Remove ${languageName(code)}`;
      chip.addEventListener('click', () =>
        save({ languages: settings.languages.filter((l) => l !== code) }),
      );
      return chip;
    }),
  );
  addLanguage.replaceChildren(
    new Option('Choose…', ''),
    ...WHISPER_LANGUAGES.filter((code) => !settings.languages.includes(code))
      .sort(byName)
      .map((code) => new Option(languageName(code), code)),
  );
}

// Downloads. They run in an open WhatsApp tab, in the engine that transcribes
// there, so the files land in the storage it reads from (see `content.js`).

const contentMatches = ext.runtime
  .getManifest()
  .content_scripts.find((script) =>
    script.js.includes('src/content.js'),
  ).matches;
// Request id → { command, model }.
const requests = new Map();
// Model id → download progress or `'delete'`, while busy.
const activity = new Map();
const errors = new Map();
let downloads = null;
let tabProblem = null;

const formatBytes = (bytes) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

let nextRequestId = 1;

// Opened from WhatsApp's page (the gear button), these settings run in the
// same context as the transcriber and talk to it through the page. Opened on
// their own, they look for a WhatsApp tab.
const embedded = window.top !== window;

function expectAnswer(reqId, model) {
  // The first event normally arrives within a second or two; downloads keep
  // reporting progress after that.
  setTimeout(() => {
    const request = requests.get(reqId);
    if (!request || request.answered) return;
    requests.delete(reqId);
    activity.delete(model);
    tabProblem = embedded
      ? 'The transcriber did not answer. Reload WhatsApp, then try again.'
      : 'WhatsApp did not answer. In a WhatsApp web app made with Add to ' +
        'Dock, open these settings from WhatsApp itself: the gear button ' +
        'below any voice message.';
    renderDownloads();
  }, 15_000);
}

async function sendCommand(command, model) {
  const reqId = `o${Date.now()}-${nextRequestId++}`;
  if (embedded) {
    requests.set(reqId, { command, model, answered: false });
    parent.postMessage({ vtw: 'settings', command, model, reqId }, '*');
    expectAnswer(reqId, model);
    renderDownloads();
    return;
  }
  const tabs = await ext.tabs.query({ url: contentMatches });
  if (!tabs.length) {
    tabProblem =
      'Open WhatsApp Web in this browser to download or delete models.';
    activity.delete(model);
    renderDownloads();
    return;
  }
  requests.set(reqId, { command, model, answered: false });
  const errors = [];
  // Each WhatsApp tab in turn, until one takes the command. The request id
  // travels with it, since Safari may not pass a content script's reply back.
  for (const tab of tabs) {
    try {
      await ext.tabs.sendMessage(tab.id, {
        type: 'vtw-models',
        command,
        model,
        reqId,
      });
      tabProblem = null;
      expectAnswer(reqId, model);
      renderDownloads();
      return;
    } catch (error) {
      errors.push(error?.message ?? String(error));
    }
  }
  // Typically a tab that was open when the extension was installed or
  // updated, which runs no content script yet.
  requests.delete(reqId);
  activity.delete(model);
  tabProblem =
    `Could not reach WhatsApp Web (${[...new Set(errors)].join('; ')}). ` +
    'Reload it, then come back here.';
  renderDownloads();
}

const refreshDownloads = () => sendCommand('models-status');

function onModelEvent({ type, reqId, ...data }) {
  const request = requests.get(reqId);
  if (!request) return;
  request.answered = true;
  tabProblem = null;
  if (type === 'progress') {
    activity.set(request.model, data);
  } else {
    requests.delete(reqId);
    if (type === 'models-status') {
      downloads = data;
      // Follow a download started elsewhere, such as by an earlier copy of
      // these settings, or by a transcription.
      if (data.busy) setTimeout(refreshDownloads, 2000);
    } else {
      activity.delete(request.model);
      if (type === 'error') errors.set(request.model, data.message);
      refreshDownloads();
    }
  }
  renderDownloads();
}

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === 'vtw-model-event') onModelEvent(message.event);
});

addEventListener('message', (event) => {
  if (
    embedded &&
    event.source === parent &&
    event.data?.vtw === 'model-event'
  ) {
    onModelEvent(event.data.event);
  }
});

function downloadStatus(id, model) {
  const busy =
    activity.get(id) ??
    (downloads?.busy?.model === id ? downloads.busy : undefined);
  if (busy === 'delete') return 'Deleting…';
  if (busy?.stage === 'download') {
    return `Downloading… ${Math.floor((100 * busy.loaded) / busy.total)} % of ${formatBytes(busy.total)}`;
  }
  if (busy) return 'Loading…';
  if (!downloads) return tabProblem ? '' : 'Checking…';
  const status = downloads.status[id];
  if (!status.available) return 'Needs WebGPU.';
  const where = [
    status.bytes && formatBytes(status.bytes),
    status.inCrossOriginStorage && 'in Cross-Origin Storage',
  ].filter(Boolean);
  if (status.complete) return ['Downloaded', ...where].join(' · ');
  if (where.length) return ['Partly downloaded', ...where].join(' · ');
  return `Not downloaded · ${model.size[downloads.deviceKey]}`;
}

function renderDownloads() {
  const anyInCrossOriginStorage =
    downloads &&
    Object.values(downloads.status).some((s) => s.inCrossOriginStorage);
  downloadsHint.textContent =
    tabProblem ??
    (embedded
      ? 'Models are stored for this WhatsApp window, where the transcriber ' +
        'looks for them.'
      : 'Downloads happen in your open WhatsApp Web tab, so that they go ' +
        'where the transcriber looks for them.') +
      (anyInCrossOriginStorage
        ? ' Deleting a model that is in Cross-Origin Storage removes it here; ' +
          'the files stay available to other sites until you remove them in ' +
          'the Cross-Origin Storage extension.'
        : '');
  downloadsElement.replaceChildren(
    ...Object.entries(MODELS).map(([id, model]) => {
      const row = document.createElement('div');
      row.className = 'download';
      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = model.label;
      const status = document.createElement('span');
      status.textContent = downloadStatus(id, model);
      text.append(name, status);
      if (errors.has(id)) {
        const error = document.createElement('span');
        error.className = 'error';
        error.textContent = errors.get(id);
        text.append(error);
      }
      row.append(text);
      const state = downloads?.status[id];
      const working = activity.has(id) || downloads?.busy?.model === id;
      if (state && !working && !tabProblem) {
        const stored =
          state.complete || state.bytes || state.inCrossOriginStorage;
        if (state.available && !state.complete) {
          row.append(
            actionButton('Download', 'primary', () => {
              errors.delete(id);
              activity.set(id, { stage: 'load' });
              sendCommand('download', id);
            }),
          );
        }
        if (stored) {
          row.append(
            actionButton('Delete', '', () => {
              errors.delete(id);
              activity.set(id, 'delete');
              sendCommand('delete', id);
            }),
          );
        }
      }
      return row;
    }),
  );
}

function actionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// Pick up a WhatsApp tab opened, or a download finished, while this page was
// in the background.
addEventListener('focus', refreshDownloads);

function render() {
  renderModels();
  renderFallback();
  renderLanguages();
  for (const name of ['autoTranscribeOnPlay', 'useCrossOriginStorage']) {
    form.elements[name].checked = settings[name];
  }
  form.elements.device.value = settings.device;
  form.elements.idleUnloadMinutes.value = String(settings.idleUnloadMinutes);
}

form.addEventListener('change', (event) => {
  const { name, value, checked, type } = event.target;
  if (event.target === addLanguage) {
    if (value) save({ languages: [...settings.languages, value] });
    return;
  }
  if (!name) return;
  if (type === 'checkbox') save({ [name]: checked });
  else if (name === 'idleUnloadMinutes') save({ [name]: Number(value) });
  else save({ [name]: value });
});

document.querySelector('#clear').addEventListener('click', async () => {
  await ext.storage.local.remove('transcripts');
  document.querySelector('#clear-status').textContent =
    'Deleted. Reload WhatsApp to clear transcripts that are on screen.';
});

render();
renderDownloads();
refreshDownloads();
