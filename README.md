<!--
  SPDX-FileCopyrightText: 2026 Thomas Steiner
  SPDX-License-Identifier: Apache-2.0
-->

# Voice Transcriber for WhatsApp

A browser extension for Chrome and Safari that adds a **Transcribe** control
below every voice message in [WhatsApp Web](https://web.whatsapp.com). The
speech model runs on your device with
[Transformers.js](https://huggingface.co/docs/transformers.js), on the GPU
through WebGPU where available. Audio never leaves the computer.

The extension identifies the spoken language on its own. You can restrict
detection to the languages you actually receive (English, German, and Catalan by
default), which keeps it from confusing close languages such as Catalan and
Spanish.

> [!NOTE] Voice Transcriber for WhatsApp is an independent project. It is not
> affiliated with, endorsed by, or sponsored by WhatsApp or Meta. WhatsApp is a
> trademark of WhatsApp LLC.

## Models

Choose the model in the extension's settings (see
[Settings and downloads](#settings-and-downloads)).

| Model                    | Languages                    | Download (WebGPU, f16) |
| ------------------------ | ---------------------------- | ---------------------- |
| Whisper large-v3 turbo   | about 100, including Catalan | 1.6 GB                 |
| Whisper small            | about 100                    | 410 MB                 |
| Whisper base             | about 100                    | 170 MB                 |
| Voxtral Mini 4B Realtime | 13, excluding Catalan        | 2.8 GB                 |

[Voxtral Mini 4B Realtime](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602)
covers English, German, French, Spanish, Italian, Portuguese, Dutch, Russian,
Chinese, Japanese, Korean, Arabic, and Hindi. It does not report which language
it heard. So when one of your languages is outside that list, a Whisper
_fallback model_ identifies the language of each message first, and transcribes
the messages Voxtral cannot handle. Voxtral needs WebGPU; Whisper also runs on
the CPU, more slowly.

### Settings and downloads

Open the settings with the gear button next to any voice message's
**Transcribe** control, or, in Chrome, with the extension's toolbar button. In a
WhatsApp web app made with Safari's **Add to Dock**, use the gear button: the
app keeps its own storage and extension messaging, apart from Safari's windows,
so settings opened from Safari do not reach it.

The **Downloads** section shows which models are stored, and downloads or
deletes them. Both run in WhatsApp's page, in the same engine that transcribes
there, so the files land in the storage it reads from (only that page can reach
Cross-Origin Storage, too). Deleting a model removes it from the browser's
cache. Files in Cross-Origin Storage stay available to other sites until you
remove them in the Cross-Origin Storage extension, since the API has no delete
operation.

### Language detection

Transformers.js has no Whisper language detection (it falls back to English), so
the extension does it: it runs Whisper's encoder on the first 30 seconds, scores
the language tokens the decoder would emit after `<|startoftranscript|>`,
considers only your selected languages, and then transcribes with the winner
forced.

## How it works

```
web.whatsapp.com
├── main-world.js   wraps HTMLMediaElement.prototype.play() to capture the
│                   decrypted blob: audio; bridges Cross-Origin Storage
├── content.js      finds voice messages, renders the UI, stores transcripts
└── <iframe> engine.html (extension origin, hidden)
    ├── engine.js   decodes Ogg Opus to 16 kHz mono with OfflineAudioContext
    └── worker.js   Transformers.js: Whisper or Voxtral on WebGPU or Wasm
```

- **Getting the audio.** WhatsApp downloads and decrypts a voice message when
  you press play, then plays it from a `blob:` URL. To transcribe a message you
  have not played, the extension arms a capture and presses the message's play
  button; the playback is muted and stopped at once. Messages you already played
  are transcribed from the captured audio without replaying them.
- **Finding voice messages.** WhatsApp's class names change with every release,
  so the extension relies on attributes that have stayed stable: the `data-id`
  of each message, the `[role="slider"][aria-valuetext]` progress slider of
  audio players, and the `audio-play`/`audio-pause` icons. If WhatsApp changes
  these, adjust `VOICE_MARKER` in
  [`extension/src/content.js`](extension/src/content.js).
- **The engine iframe.** Running the model in an extension frame embedded in
  WhatsApp gives it the extension's permissions and its own process (a GPU
  out-of-memory error cannot take down WhatsApp), and the same code works in
  Chrome and Safari, which has no offscreen documents. The model unloads after a
  configurable idle time.
- **Transcripts** are kept in `storage.local`, keyed by message ID, so they
  reappear when you scroll back or reload.

### Model storage

Models are stored in Cache Storage of the WhatsApp page's origin
(`web.whatsapp.com`), in caches named `voice-transcriber-models` and
`voice-transcriber-downloads`, which `main-world.js` reads and writes for the
engine. The extension's own origin would be the obvious place, but Safari gives
an extension a new origin with every launch and leaves that origin's Cache
Storage behind
([WebKit bug 259637](https://bugs.webkit.org/show_bug.cgi?id=259637)), so the
models would download again after every restart or update. The `storage`
extension API, which Apple suggests for extension data
([WECG minutes, 2023-05-11](https://github.com/w3c/webextensions/blob/main/_minutes/2023-05-11-wecg.md)),
only holds JSON, a poor fit for gigabytes of weights. The bridge only reaches
those two caches, never the ones WhatsApp keeps. Models that an earlier version
cached in the extension's origin move over when first used. Clearing WhatsApp's
site data removes the models, too.

### Cross-Origin Storage

With **Store models with Cross-Origin Storage** on (the default), the worker
sets Transformers.js's `env.experimental_useCrossOriginStorage` flag, so model
files are stored by content hash in
[Cross-Origin Storage](https://github.com/WICG/cross-origin-storage) and shared
with any other site that uses the same files.

The [COS extension](https://goo.gle/cos-extension) only defines
`navigator.crossOriginStorage` in web pages, never in another extension's pages
or workers. So the worker installs a small shim of the API, and the shim
forwards each call (`requestFileHandle()`, `getFile()`, and `createWritable()`)
through the engine iframe to `main-world.js`, which makes the real call in the
WhatsApp page. Files travel as `Blob` references, without copies. Without COS,
Transformers.js uses the Cache API as usual.

## Setup

```sh
npm install   # also copies Transformers.js and ONNX Runtime into extension/vendor/
```

### Chrome

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**,
and select the `extension/` folder.

### Safari

```sh
npm run safari -- --team <your Apple developer team ID>
```

This generates an Xcode project in `safari/` that references the files in
`extension/`, builds
`build/safari/Build/Products/Release/Voice Transcriber for WhatsApp.app`, and
launches it once, which registers the extension. Then enable **Voice Transcriber
for WhatsApp** in Safari › Settings › Extensions, and allow it on
web.whatsapp.com. A WhatsApp web app made with **Add to Dock** has its own
extension settings: open the web app, then its app menu › Settings › Extensions.
Without a team ID, the app is signed ad hoc, and Safari only loads it after
Develop › Developer Settings › **Allow unsigned extensions**.

After changing extension files, rerun `npm run safari` (the project bakes in the
file list).

## Testing without WhatsApp

`test/` holds a mock chat page that mimics WhatsApp Web's markup, its
`blob:`-based playback, and its isolation and content security headers, with
English, German, and Catalan voice messages (`test/make-audio.sh` regenerates
them with macOS voices).

```sh
npm run test:build   # build/test-extension/: the extension, also matching localhost
npm run test:serve   # http://localhost:8123/
```

Load `build/test-extension/` unpacked in Chrome and open the page. Serving the
page on a second port (`node test/serve.mjs 8124`) is a quick way to check
Cross-Origin Storage reuse: the model should load without downloading again.

`test/worker.html` runs only the audio decoding and the inference worker, with
no extension around them, which helps debug the model side in a browser where
loading the extension is inconvenient. Serve the repository root
(`python3 -m http.server`) and open
`/test/worker.html?model=whisper-base&lang=ca`.

## License

[Apache 2.0](LICENSE)
