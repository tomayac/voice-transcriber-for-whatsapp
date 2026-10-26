// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Wraps `extension/` in a macOS app for Safari and builds it. The Xcode
// project references the extension files in place, so Safari runs the same
// code as Chrome. It is regenerated on every run because it bakes in the
// list of files.
//
// Usage: node scripts/safari.mjs [--team TEAMID]
// Without a team (or `DEVELOPMENT_TEAM`), the app is signed ad hoc, and Safari
// only loads it with Develop › Developer Settings › Allow unsigned extensions.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const { values } = parseArgs({ options: { team: { type: 'string' } } });
const team = values.team ?? process.env.DEVELOPMENT_TEAM;
const appName = 'Voice Transcriber';
const bundleId = 'com.tomayac.voicetranscriber';

const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });

if (!existsSync(join(root, 'extension', 'vendor', 'transformers.min.js'))) {
  run('node', ['scripts/vendor.mjs']);
}

run('xcrun', [
  'safari-web-extension-converter',
  'extension',
  '--project-location',
  'safari',
  '--app-name',
  appName,
  '--bundle-identifier',
  bundleId,
  '--swift',
  '--macos-only',
  '--no-open',
  '--no-prompt',
  '--force',
]);

// The converter derives the app's bundle identifier from its name, which then
// no longer prefixes the extension's, and it targets macOS versions Xcode no
// longer builds for.
const pbxproj = join(
  root,
  `safari/${appName}/${appName}.xcodeproj/project.pbxproj`,
);
writeFileSync(
  pbxproj,
  readFileSync(pbxproj, 'utf8')
    .replace(/PRODUCT_BUNDLE_IDENTIFIER = "?[^";]+"?;/g, (line) =>
      line.includes('.Extension')
        ? line
        : `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`,
    )
    .replace(
      /MACOSX_DEPLOYMENT_TARGET = (10|11)\.\d+;/g,
      'MACOSX_DEPLOYMENT_TARGET = 12.0;',
    ),
);

run('xcodebuild', [
  '-project',
  `safari/${appName}/${appName}.xcodeproj`,
  '-scheme',
  appName,
  '-configuration',
  'Release',
  '-derivedDataPath',
  'build/safari',
  ...(team
    ? [
        `DEVELOPMENT_TEAM=${team}`,
        'CODE_SIGN_STYLE=Automatic',
        '-allowProvisioningUpdates',
      ]
    : ['CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=NO']),
  '-quiet',
  'build',
]);

const app = join(root, 'build/safari/Build/Products/Release', `${appName}.app`);
// Launching the app once registers the extension with Safari.
run('open', [app]);
console.log(`\nBuilt ${app}`);
console.log(
  'Enable it in Safari › Settings › Extensions, and in the settings of the ' +
    'WhatsApp web app (Safari › Settings › Extensions there too).',
);
