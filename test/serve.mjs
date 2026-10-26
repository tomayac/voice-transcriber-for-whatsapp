// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Serves the mock WhatsApp page with WhatsApp Web's isolation and content
// security headers, which decide whether the engine iframe may load at all.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const port = Number(process.argv[2] ?? 8123);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ogg': 'audio/ogg',
};

createServer(async (request, response) => {
  const path = normalize(new URL(request.url, 'http://x').pathname);
  const file = join(root, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-opener-policy': 'same-origin-allow-popups',
      'content-security-policy': [
        "default-src 'self' blob:",
        "script-src blob: 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' blob: data:",
        "media-src 'self' blob: mediastream: data:",
        "frame-src 'self' blob: data:",
        "worker-src 'self' blob: data:",
      ].join('; '),
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
