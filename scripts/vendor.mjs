// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Copies Transformers.js and the ONNX Runtime WebAssembly build it loads into
// `extension/vendor/`. Extensions may not load code from a CDN.

import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const vendor = join(root, 'extension', 'vendor');

// Node's own resolution refuses paths a package's `exports` do not list, so
// walk the `node_modules` folders by hand.
function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === dirname(dir)) throw new Error(`${name} is not installed.`);
  }
}

const transformers = findPackage('@huggingface/transformers', root);
// Resolve ONNX Runtime from Transformers.js, so the versions always match.
const ort = findPackage('onnxruntime-web', transformers);

const files = [
  [join(transformers, 'dist', 'transformers.min.js'), 'transformers.min.js'],
  ...['mjs', 'wasm'].map((extension) => [
    join(ort, 'dist', `ort-wasm-simd-threaded.asyncify.${extension}`),
    `ort-wasm-simd-threaded.asyncify.${extension}`,
  ]),
];

await mkdir(vendor, { recursive: true });
for (const [from, to] of files) {
  await copyFile(from, join(vendor, to));
  console.log(`vendor/${to}`);
}
