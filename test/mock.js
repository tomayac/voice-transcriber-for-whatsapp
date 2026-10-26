// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// A stand-in for WhatsApp Web's chat pane, with the attributes the extension
// relies on. Like WhatsApp, it only fetches a voice message when its play
// button is pressed, and plays it from a `blob:` URL.

const messages = [
  { id: 'false_491234@c.us_EN1', lang: 'en', duration: '0:06' },
  { id: 'true_491234@c.us_DE1', lang: 'de', duration: '0:07' },
  { id: 'false_491234@c.us_TXT', text: 'And a plain text message.' },
  { id: 'false_491234@c.us_CA1', lang: 'ca', duration: '0:07' },
];

// `?handler=` picks the input the play buttons respond to, to test how the
// extension presses them: `click` (default), `pointerdown`, `keydown`, or
// `trusted`, which only accepts real clicks, the way some players do.
const params = new URLSearchParams(location.search);
const handler = params.get('handler') ?? 'click';
// `?icons=none` drops icon names and uses a German label, leaving only the
// button's position next to the slider to find it by.
const plainIcons = params.get('icons') === 'none';

const players = new Map();

async function toggle(message, icon) {
  let audio = players.get(message.id);
  if (!audio) {
    const response = await fetch(`audio/${message.lang}.ogg`);
    const blob = new Blob([await response.arrayBuffer()], {
      type: 'audio/ogg; codecs=opus',
    });
    audio = new Audio(URL.createObjectURL(blob));
    players.set(message.id, audio);
  }
  const sync = () => {
    if (!plainIcons) {
      icon.dataset.icon = audio.paused ? 'audio-play' : 'audio-pause';
      icon.parentElement.setAttribute(
        'aria-label',
        audio.paused ? 'Play voice message' : 'Pause voice message',
      );
    }
    icon.textContent = audio.paused ? '▶' : '⏸';
  };
  audio.onplay = audio.onpause = audio.onended = sync;
  if (audio.paused) audio.play();
  else audio.pause();
}

function render() {
  const list = document.querySelector('#messages');
  list.replaceChildren(
    ...messages.map((message) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'row');
      const root = document.createElement('div');
      root.dataset.id = message.id;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (message.text) {
        bubble.textContent = message.text;
      } else {
        const button = document.createElement('button');
        button.setAttribute(
          'aria-label',
          plainIcons ? 'Sprachnachricht abspielen' : 'Play voice message',
        );
        const icon = document.createElement('span');
        if (!plainIcons) icon.dataset.icon = 'audio-play';
        icon.textContent = '▶';
        button.append(icon);
        button.addEventListener(
          handler === 'trusted' ? 'click' : handler,
          (event) => {
            if (handler === 'trusted' && !event.isTrusted) return;
            if (handler === 'keydown' && event.key !== 'Enter') return;
            toggle(message, icon);
          },
        );
        const slider = document.createElement('div');
        slider.setAttribute('role', 'slider');
        slider.setAttribute('aria-valuetext', `0:00/${message.duration}`);
        const duration = document.createElement('span');
        duration.textContent = message.duration;
        bubble.append(button, slider, duration);
      }
      root.append(bubble);
      row.append(root);
      return row;
    }),
  );
}

document.querySelector('#rerender').addEventListener('click', render);
render();
