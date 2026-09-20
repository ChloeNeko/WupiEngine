# WUPI Engine

Two tools in one extension for SillyTavern and TauriTavern:

- **WupiFilter** stops bad replies. If the AI starts a reply with a word like "sorry", the reply is cut off and a fresh one is generated right away.
- **WupiMemory** gives each chat a long memory. Before the AI replies, it quietly reminds the AI of the relevant parts of earlier chats.

Everything runs on your device. No server, no API keys.

## Install

1. In the app, open Extensions and click Install extension.
2. Paste this link: `https://github.com/ChloeNeko/WupiEngine`
3. Restart the app.

## Use

Click the magic wand next to the send bar. Two new entries show up:

- **WupiFilter**: turn the gate on or off and set the blocked words.
- **WupiMemory**: tick Enable memory. The reading model loads by itself the first time (about 35 MB, downloaded once, then offline).

Deleting a chat also deletes its memories.

## Commands

- `/wupifilter-status`, `/wupifilter-test <text>`, `/wupifilter-toggle`
- `/wupi-sync`, `/wupi-search`, `/wupi-status`, `/wupi-selftest`, `/wupi-wipe`

## Credits

- bge-small-en-v1.5 embedding model (MIT), ONNX port by Xenova
- transformers.js (Apache 2.0)
