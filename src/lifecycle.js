/**
 * Pure chat-lifecycle helpers: how a memory row reacts to chat events.
 *
 * Everything here is synchronous and side-effect free so the deletion /
 * rename / migration plans are unit-testable without IndexedDB; the store
 * applies them with cursor passes.
 *
 * Row invariants kept by every helper:
 *   - `dedupeKey` is `${partition}|${sourceHash}` (chunk rows carry a `#cN`
 *     suffix), so a partition change must re-splice the prefix;
 *   - the `dedupeKey` unique index means a row may only be rescoped to a
 *     partition whose survivors don't already own the target key.
 */

/** The per-chat partition suffix used when scoping is per-chat. */
export const CHAT_PARTITION_SUFFIX = ':chat:';

/**
 * Re-key a row into another partition, splicing the dedupeKey prefix and
 * applying extra field overrides (e.g. the new chatId).
 * @param {object} row
 * @param {string} newPartition
 * @param {object} [extra] fields to override on the result
 * @returns {object} new row object (input untouched)
 */
export function rescopeRow(row, newPartition, extra = {}) {
    const next = { ...row, ...extra, partition: newPartition };
    if (typeof row.dedupeKey === 'string' && row.dedupeKey.startsWith(row.partition + '|')) {
        next.dedupeKey = newPartition + row.dedupeKey.slice(row.partition.length);
    }
    return next;
}

/**
 * Plan the rename of a chat: rows tagged with the old chat id get the new
 * id, and per-chat partitions move with them.
 * @param {object[]} rows full store contents
 * @param {string} oldName chat id before the rename
 * @param {string} newName chat id after the rename
 * @returns {{updates: object[], drops: number[]}} rows to put / ids that
 *   would collide with a surviving dedupeKey and must be deleted instead
 */
export function planChatRename(rows, oldName, newName) {
    /** dedupeKeys that stay in place or were already claimed by a move. */
    const survivors = new Set(
        rows.filter((r) => r.chatId !== oldName).map((r) => r.dedupeKey),
    );
    const updates = [];
    const drops = [];
    for (const row of rows) {
        if (row.chatId !== oldName) continue;
        const suffix = CHAT_PARTITION_SUFFIX + oldName;
        const partition = row.partition.endsWith(suffix)
            ? row.partition.slice(0, row.partition.length - suffix.length)
                + CHAT_PARTITION_SUFFIX + newName
            : row.partition;
        const next = rescopeRow(row, partition, { chatId: newName });
        if (survivors.has(next.dedupeKey)) {
            drops.push(row.id);
        } else {
            survivors.add(next.dedupeKey);
            updates.push(next);
        }
    }
    return { updates, drops };
}

/**
 * Plan the one-time move of character-level partitions to per-chat ones:
 * `char:X` rows that know their chat id become `char:X:chat:<id>` rows, so
 * memories follow the chat they were archived in.
 * @param {object[]} rows full store contents
 * @returns {{updates: object[], drops: number[]}} as above
 */
export function planPerChatMigration(rows) {
    const movers = rows.filter((r) =>
        r.chatId && !String(r.partition).includes(CHAT_PARTITION_SUFFIX));
    const moverSet = new Set(movers);
    const survivors = new Set(
        rows.filter((r) => !moverSet.has(r)).map((r) => r.dedupeKey),
    );
    const updates = [];
    const drops = [];
    for (const row of movers) {
        const next = rescopeRow(row, row.partition + CHAT_PARTITION_SUFFIX + row.chatId);
        if (survivors.has(next.dedupeKey)) {
            drops.push(row.id);
        } else {
            survivors.add(next.dedupeKey);
            updates.push(next);
        }
    }
    return { updates, drops };
}
