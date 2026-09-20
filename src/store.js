/**
 * Persistence: IndexedDB object store: the in-webview stand-in for WUPI's
 * SQLite three-table layout (memories + FTS5 mirror + vec0 virtual table).
 *
 * One object store with one id space carries everything a row needs:
 * the vector lives inline on the row (structured clone handles
 * Float32Array), the BM25 index is rebuilt from `text` on demand, and the
 * unique `dedupeKey` index plays the role of the archival dedupe the Rust
 * side got from its single-insert transaction. Brute-force cosine over the
 * cached vectors replaces the vec0 scan (vec0 0.1.x is a linear scan too).
 *
 * Schema mirrors memory.rs `MemoryEntry` + `superseded_by`.
 */

import { DB_NAME, DB_VERSION, STORE_MEMORIES, STORE_META } from './constants.js';
import { planChatRename, planPerChatMigration } from './lifecycle.js';

export class MemoryStore {
    /** @param {IDBDatabase} db */
    constructor(db) {
        this.db = db;
    }

    /** @returns {Promise<MemoryStore>} */
    static open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (ev) => {
                const db = req.result;
                if (ev.oldVersion < 1) {
                    const memories = db.createObjectStore(STORE_MEMORIES, {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    memories.createIndex('partition', 'partition', { unique: false });
                    memories.createIndex('dedupeKey', 'dedupeKey', { unique: true });
                    memories.createIndex('partition_ts', ['partition', 'timestamp'], { unique: false });
                    memories.createIndex('partition_turn', ['partition', 'turnUuid'], { unique: false });
                    db.createObjectStore(STORE_META);
                }
            };
            req.onsuccess = () => resolve(new MemoryStore(req.result));
            req.onerror = () => reject(req.error);
        });
    }

    /** Insert a row (no id); resolves to the assigned id. */
    addRow(row) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const req = tx.objectStore(STORE_MEMORIES).add(row);
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /** Update a row by its id. */
    putRow(row) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            tx.objectStore(STORE_MEMORIES).put(row);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /** All rows of one partition (full rows incl. embeddings). */
    getAll(partition) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readonly');
            const req = tx.objectStore(STORE_MEMORIES).index('partition').getAll(partition);
            req.onsuccess = () => resolve(req.result ?? []);
            req.onerror = () => reject(req.error);
        });
    }

    /** Delete rows by id list in one transaction. */
    deleteIds(ids) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const store = tx.objectStore(STORE_MEMORIES);
            for (const id of ids) {
                store.delete(id);
            }
            tx.oncomplete = () => resolve(ids.length);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /** Wipe the DB entirely (every partition). */
    clearAll() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const req = tx.objectStore(STORE_MEMORIES).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(req.error);
            tx.onabort = () => reject(req.error);
        });
    }

    /**
     * Data migration: delete rows left behind by the removed Codex feature
     * (rows whose metadata.kind === 'codex'). Cheap cursor scan; resolves
     * to the number of rows deleted.
     * @returns {Promise<number>}
     */
    purgeLegacyCodexRows() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const req = tx.objectStore(STORE_MEMORIES).openCursor();
            let deleted = 0;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                if (cursor.value?.metadata?.kind === 'codex') {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
            tx.oncomplete = () => resolve(deleted);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // -----------------------------------------------------------------
    // Chat lifecycle: memories die with their chat (any partition)
    // -----------------------------------------------------------------

    /** Every memory row in the store, regardless of partition. */
    _allRows() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readonly');
            const req = tx.objectStore(STORE_MEMORIES).getAll();
            req.onsuccess = () => resolve(req.result ?? []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Delete every row archived from one chat, in any partition. The
     * CHAT_DELETED / GROUP_CHAT_DELETED payloads are the chat id exactly as
     * addMessage stored it in `chatId`.
     * @param {string} chatId
     * @returns {Promise<number>} rows deleted
     */
    deleteRowsByChatId(chatId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const req = tx.objectStore(STORE_MEMORIES).openCursor();
            let deleted = 0;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                if (cursor.value?.chatId === chatId) {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
            tx.oncomplete = () => resolve(deleted);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /**
     * One-time data repair: delete rows that were archived without a chat id
     * tag. On hosts that never exposed a chat id (empty context.chatId on
     * some TauriTavern builds), every chat of a character collapsed into one
     * shared pool and chat deletion could never match those rows, so they
     * lingered forever. Untagged rows are unattributable: no deletion or
     * rename can ever target them, so removing them is the only repair.
     * @returns {Promise<number>} rows deleted
     */
    purgeRowsWithEmptyChatId() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const req = tx.objectStore(STORE_MEMORIES).openCursor();
            let deleted = 0;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                if (!cursor.value?.chatId) {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
            tx.oncomplete = () => resolve(deleted);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /**
     * Apply a lifecycle plan (puts + deletes in one transaction). The plans
     * pre-resolve dedupeKey collisions, so no put can hit the unique index.
     * @param {{updates: object[], drops: number[]}} plan
     * @returns {Promise<number>} rows touched
     */
    _applyPlan(plan) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_MEMORIES, 'readwrite');
            const store = tx.objectStore(STORE_MEMORIES);
            for (const row of plan.updates) store.put(row);
            for (const id of plan.drops) store.delete(id);
            tx.oncomplete = () => resolve(plan.updates.length + plan.drops.length);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    /**
     * A chat was renamed: retag its rows and move its per-chat partitions.
     * @param {string} oldName chat id before the rename (no .jsonl)
     * @param {string} newName chat id after the rename (no .jsonl)
     * @returns {Promise<number>} rows touched
     */
    async renameChat(oldName, newName) {
        const plan = planChatRename(await this._allRows(), oldName, newName);
        return plan.updates.length + plan.drops.length > 0
            ? this._applyPlan(plan)
            : 0;
    }

    /**
     * One-time migration to per-chat scoping: character-level partitions
     * that know their chat id are re-keyed under that chat.
     * @returns {Promise<number>} rows touched
     */
    async migrateToPerChatPartitions() {
        const plan = planPerChatMigration(await this._allRows());
        return plan.updates.length + plan.drops.length > 0
            ? this._applyPlan(plan)
            : 0;
    }

    /** @returns {Promise<any>} */
    getMeta(key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_META, 'readonly');
            const req = tx.objectStore(STORE_META).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** @returns {Promise<void>} */
    setMeta(key, value) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_META, 'readwrite');
            tx.objectStore(STORE_META).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
}
