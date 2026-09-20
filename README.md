# WUPI Engine

WUPI Engine bundles the two WUPI extensions in one package:

- **WupiFilter** (🛡️): the WUPI "Sorry" gate for AI replies.
- **WupiMemory** (🧠): the WUPI hybrid long-term memory engine.

It is a self-contained TauriTavern / SillyTavern extension. Both settings
panels live in the **wand extensions menu**: click the magic wand next to the
send bar and pick **WupiFilter** or **WupiMemory**. (They used to be drawers
inside the Extensions settings panel; they were merged and moved to the wand
menu in v1.0.0.)

Nothing is lost from the standalone extensions: the settings keys
(`wupiFilter`, `wupiMemory`), the IndexedDB memory store (`wupi_memory`) and
all slash commands are unchanged, so saved settings, memories and scripts
carry over as they are.

## WupiFilter

A filter gate for AI replies. While a reply streams in, WupiFilter watches
the very first words (5 by default). If it sees a blocked word such as
"sorry", it:

1. Cuts the stream off at once.
2. Deletes the stopped attempt from the chat, so the retry is built from a
   clean slate and is never influenced by the discarded reply. This is the
   full message cache reset.
3. Adds a hidden one time note with a random marker, only for the retry.
   Providers with prompt caching cannot replay the exact same refusal, and
   the model gets a clear nudge not to apologize.
4. Regenerates the reply.

All of this happens automatically, in a fraction of a second. The retry
budget is capped (3 by default). When the cap is reached, the reply is let
through and you get a small notice, so a stubborn model can never loop
forever. Replies that arrive all at once (non streaming connections) are
checked too, then regenerated the same way.

Settings: blocked words and phrases (comma separated), opening window size,
retry limit, whole words only, case sensitive, fresh start on retry, the non
streaming fallback, and cut notices.

Commands: `/wupifilter-status`, `/wupifilter-test <text>`,
`/wupifilter-toggle`.

## WupiMemory

WupiMemory gives each chat a long-term memory. It remembers your past
conversations and quietly reminds the AI of the relevant parts right before
it replies, so nothing important gets forgotten. No server and no API keys:
the embedding model (bge-small-en-v1.5) runs locally inside the app window,
and all memory lives in IndexedDB. Retrieval constants are WUPI v2's tested
values (`C:/WUPI/scripts/memory.cs`).

- **Before each generation**, the user's latest message is used as a search
  query against that chat's memory. Two searches run at once: meaning search
  (true-cosine over local bge-small vectors) and keyword search (BM25). The
  keyword list is checked against the same similarity floor as the meaning
  list, then both are merged with weighted Reciprocal Rank Fusion (K=60,
  1-based ranks). The top hits are rendered as a framed `<retrieved_memory>`
  block and injected via `setExtensionPrompt` (default: in-chat, depth 0).
- **After each reply**, the turn (user + assistant messages) is saved:
  chunked (1300-byte budget, then paragraphs, then sentences, then hard
  cuts), embedded, and stored with a shared turn id. Identical content is
  skipped automatically, so regens and swipes are harmless.
- **Retention**: each memory scope keeps up to 2000 memory chunks. When the
  limit is passed, whole oldest turns are evicted down to 1800. Pinned rows
  never evict.
- **Chat lifetime**: memory is scoped per chat by default and dies with the
  chat. `CHAT_DELETED` / `GROUP_CHAT_DELETED` delete that chat's rows from
  every partition; `CHAT_RENAMED` re-keys them so nothing orphans behind the
  new name.

### Host compatibility notes (v1.1.0)

- **Chat id resolution**: this TauriTavern build never exposes
  `context.chatId`, which made the standalone extension tag every row with
  an empty chat id: all chats of a character collapsed into one shared
  memory pool and no chat deletion could ever match those rows. WUPI Engine
  now resolves the chat id from three sources, best first: the context
  property, the `CHAT_CHANGED` event payload, and a fingerprint derived
  from the chat itself (first message `send_date`, millisecond precision).
  Archival refuses to run when no id can be resolved at all, so untagged
  orphan rows can never be created again.
- **One-time repair**: on first load after the update, rows with an empty
  chat id are purged (they are unattributable: no deletion or rename could
  ever target them). Expect the memory count to drop to zero once, then
  rebuild per chat.
- **Model auto-load**: whenever memory is enabled, the embedding model
  loads by itself, at startup, when the Enable memory switch is flipped
  on, and when the settings panel is opened. The Load model button remains
  as an explicit retry.

Commands: `/wupi-search [query]` (per-hit diagnostics), `/wupi-sync`,
`/wupi-status`, `/wupi-selftest`, `/wupi-wipe`.

### Architecture map (WUPI Rust to this extension)

| WUPI (old), `src-tauri/src/` | Here |
|---|---|
| `memory_rrf.rs`: fuse, floors, sparse gate, proximity tie-break | `src/rrf.js` (unit tests ported 1:1) |
| `memory.rs`: engine, chunking, render, retention, gates | `src/engine.js`, `src/chunk.js`, `src/renderBlock.js` |
| FTS5 BM25 mirror table | `src/bm25.js` (FTS5 defaults k1=1.2 b=0.75, idf clamp >= 1e-6 like `fts5_aux.c`) |
| `memory_embedder_llama.rs`: llama.cpp bge-small, CLS pool, L2 norm, query instruction | `src/embedder.js`: transformers.js ONNX (`Xenova/bge-small-en-v1.5`), same pooling/normalization/instruction |
| SQLite `memories` + `memories_fts` + `memories_vec` | IndexedDB `wupi_memory` store (vectors inline; BM25 + brute-force cosine in-memory, like vec0's linear scan) |
| `chat_format.rs` `<retrieved_memory>` inter-turn injection | `setExtensionPrompt` (IN_CHAT, depth 0) |
| `model_downloader.rs` (Embed.gguf from HF) | transformers.js streams `onnx/model_quantized.onnx` from the HF CDN, then browser-cached |
| the "Sorry" gate | `index.js` (WupiFilter section) + `src/matcher.js` |
| — (no Rust counterpart: chat lifetime) | `src/lifecycle.js` pure plans + `store.js` cursor passes (`deleteRowsByChatId`, `renameChat`, `migrateToPerChatPartitions`) |

Deliberate deviations (documented):

- The vector store is brute-force cosine, identical in semantics to vec0
  0.1.x (also a linear scan), fine at the 2000-row cap.
- **Embedding model format**: WUPI ran `CompendiumLabs/bge-small-en-v1.5-gguf`
  (Q8) through llama.cpp. A webview cannot run GGUF/llama.cpp, so this
  extension runs the same network from its ONNX port
  (`Xenova/bge-small-en-v1.5`, dtype `q8`) via transformers.js. That is the
  same Q8 quantization level of the same upstream weights (BAAI
  bge-small-en-v1.5, 384-dim) in a different container format. v2's 0.58
  floor was calibrated on the GGUF Q8 and transfers directly.
- Turn identity anchors on the user message (`hash(chatId|send_date|mes)`)
  instead of a random uuid, so group-chat replies share one turn group and
  regens dedupe naturally.
- LLM-based memory consolidation (WUPI `consolidation.rs`) is not ported
  yet. The roadmap item is a quiet-prompt summarizer that supersedes old
  turns with `Role::Summary` rows; the `supersededBy` machinery is already
  in place and honored by retrieval.
- The Codex feature (authored reference lore, lorebook import, echo-skip
  gate) was removed in the standalone v0.3.0. A one-time migration deletes
  any Codex rows left in the database.

## Token limit and prompt-cache behavior

The token limiter (manifest `generate_interceptor`, the same mechanism as
the MessageLimit extension) keeps only the chat-history portion of the
prompt inside the slider budget:

- When the budget is exceeded, only the **oldest** chat messages are left
  out of the outgoing prompt. The system prompt, character description,
  persona, lore/world info and author's note are assembled by the host after
  interceptors run, so the limiter can never touch them.
- Counts come from the app's active tokenizer (`getTokenCountAsync`) with a
  small per-message wrapper overhead, memoized per message text.
- **Cache stability**: trimming is deterministic with hysteresis. A prompt
  that fits is sent whole (append-only prefix), and when a trim is forced it
  drops slightly deeper (to 90% of budget) so the window does not slide again
  on the next message. The memory block injects at the END (in-chat, depth 0)
  for the same reason: changing per-turn content must live in the uncached
  tail, never in the prefix.
- Quiet prompts are exempt unless opted in.

## Install

**From git (recommended):** open Extensions → Install extension, paste

```
https://github.com/ChloeNeko/WupiEngine
```

and install. Restart the app (or reload the UI), open the wand menu next to
the send bar, pick **WupiMemory**, tick **Enable memory**. The reading model
loads by itself (first load downloads about 35 MB once, then works
offline). The filter gate is on by default; its panel is the shield entry
in the same menu.

**Manual:** copy this folder into `data/extensions/third-party/` (global) or
`data/default-user/extensions/` (per-user).

Requires a SillyTavern-compatible host (SillyTavern or TauriTavern): the
extension uses the host's slash-command modules and popup/menu APIs. No
server, no API keys; the embedding model runs locally in the app window.

## Credits and licenses

- Embedding model: [BAAI bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)
  (MIT), run through its ONNX port
  [Xenova/bge-small-en-v1.5](https://huggingface.co/Xenova/bge-small-en-v1.5)
  in Q8.
- [transformers.js](https://github.com/huggingface/transformers.js)
  (Apache 2.0), vendored in `lib/transformers.min.mjs`.
- BM25 follows SQLite FTS5 defaults; RRF follows Cormack et al. (2009).

## Files

- `index.js` boot + glue: filter gate engine, memory orchestration, wand
  menu, slash commands, token limiter interceptor.
- `src/matcher.js` pure matching logic, shared by the gate, the tester and
  the tests.
- `src/filterUi.js` / `src/memoryUi.js` the two wand-menu settings panels.
- `src/wandMenu.js` wand extensions menu plumbing.
- `src/{store,embedder,engine,bm25,chunk,constants,lifecycle,renderBlock,rrf,tokenLimit,util}.js`
  the memory engine modules (unchanged from the standalone WupiMemory).
- `lib/transformers.min.mjs` vendored transformers.js for local embeddings.
- `style.css` panel styling, scoped under `.wupi-fl` / `.wupi-mem` /
  `.wupi-engine-`.
- `test/` offline tests, run with `npm test`.

## Verification

`npm test` (Node >= 20) runs the offline suites of both parts: the matcher
tests (WupiFilter) and the memory engine tests (WupiMemory, including the
complete Rust unit suite of `memory_rrf.rs` ported 1:1, chunking budgets,
BM25 behavior, render/escape, and engine orchestration over fake
store/embedder). The real bge-small model was validated out of band:
384-dim, unit L2 norm, self-test pass, query to relevant-doc 0.679 vs query
to irrelevant 0.412.
