// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

const ext = globalThis.browser ?? globalThis.chrome;

// The toolbar button opens the settings.
ext.action.onClicked.addListener(() => ext.runtime.openOptionsPage());

// Safari ignores `"world": "MAIN"` on manifest content scripts, so the content
// script asks for `main-world.js` to be injected this way instead.
ext.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'inject-main-world' || !sender.tab) return;
  return ext.scripting
    .executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      files: ['src/main-world.js'],
      world: 'MAIN',
    })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: error.message }),
    );
});
