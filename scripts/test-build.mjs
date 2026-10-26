// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Builds `build/test-extension/`: the extension, additionally matching
// `http://localhost`, so it runs on the mock WhatsApp page in `test/`.

import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const out = join(root, 'build', 'test-extension');

await rm(out, { recursive: true, force: true });
await cp(join(root, 'extension'), out, { recursive: true });

const manifestPath = join(out, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.name += ' (test)';
for (const entry of [
  ...manifest.content_scripts,
  ...manifest.web_accessible_resources,
]) {
  entry.matches.push('http://localhost:*/*');
}
// The options page finds the tab by URL, which needs host permissions.
manifest.host_permissions.push('http://localhost:*/*');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(out);
