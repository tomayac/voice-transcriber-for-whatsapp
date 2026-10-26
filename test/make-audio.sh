#!/bin/sh
# SPDX-FileCopyrightText: 2026 Thomas Steiner
# SPDX-License-Identifier: Apache-2.0

# Synthesizes the test voice messages with macOS voices, encoded the way
# WhatsApp encodes voice messages: Ogg Opus, mono.
set -e
cd "$(dirname "$0")/audio"
say -v Samantha -o en.aiff "Hi Thomas, I'm running a bit late today. Can we move our meeting to four o'clock? Thanks a lot."
say -v Anna -o de.aiff "Hallo Thomas, ich komme heute etwas später. Können wir unser Treffen auf vier Uhr verschieben? Vielen Dank."
say -v Montse -o ca.aiff "Hola Thomas, avui arribaré una mica tard. Podem moure la reunió a les quatre? Moltes gràcies."
for l in en de ca; do
  ffmpeg -loglevel error -y -i $l.aiff -c:a libopus -b:a 24k -ar 48000 -ac 1 $l.ogg
  rm $l.aiff
done
