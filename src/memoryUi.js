/**
 * WupiMemory settings panel, shown in a popup from the wand extensions menu
 * (this used to be a drawer inside #extensions_settings). Pure DOM, no
 * templates.
 *
 * Everything here is written in plain language on purpose: no jargon, no
 * em-dashes, short sentences.
 */

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of children) {
        if (c == null) continue;
        node.append(c);
    }
    return node;
}

/** A rounded card with a small heading. */
function block(title, ...children) {
    return el('div', { class: 'wupi-mem-block' },
        el('div', { class: 'wupi-mem-block-title', text: title }),
        ...children,
    );
}

/** Small helper text under a control. */
function hint(text) {
    return el('div', { class: 'wupi-mem-hint', text });
}

function checkbox(labelText, checked, onChange) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    const label = el('label', { class: 'checkbox-label' }, input, el('span', { text: ` ${labelText}` }));
    return label;
}

function numberField(labelText, value, { min, max, step, onChange }) {
    const input = el('input', { type: 'number', min, max, step });
    input.value = value;
    input.addEventListener('change', () => onChange(Number(input.value)));
    return el('label', { class: 'wupi-mem-field' }, el('span', { class: 'wupi-mem-field-label', text: labelText }), input);
}

function selectField(labelText, value, options, onChange) {
    const select = el('select');
    for (const [v, label] of options) {
        const o = el('option', { value: String(v), text: label });
        select.append(o);
    }
    select.value = String(value);
    select.addEventListener('change', () => {
        const raw = select.value;
        onChange(Number.isNaN(Number(raw)) ? raw : Number(raw));
    });
    return el('label', { class: 'wupi-mem-field' }, el('span', { class: 'wupi-mem-field-label', text: labelText }), select);
}

function textField(labelText, value, onChange) {
    const input = el('input', { type: 'text' });
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
    return el('label', { class: 'wupi-mem-field' }, el('span', { class: 'wupi-mem-field-label', text: labelText }), input);
}

function button(text, onClick, kind = '') {
    return el('div', {
        class: `menu_button wupi-mem-btn ${kind}`,
        text,
        onclick: (e) => { e.preventDefault(); onClick(); },
    });
}

/**
 * Build the Memory panel shown in the wand menu popup.
 *
 * @param {object} ctx SillyTavern context
 * @param {object} settings live settings object (mutated in place)
 * @param {object} api engine-facing callbacks:
 *   - getModelStatus(): string
 *   - loadModel(): Promise<void>
 *   - selfTest(): Promise<{ok:boolean, reason?:string, high:number, low:number, gap:number}>
 *   - syncChat(): Promise<number>
 *   - wipeCharacter(): Promise<number>
 *   - purgeAll(): Promise<number>
 *   - refreshStats(): Promise<string>
 *   - save(): void
 * @returns {{node: HTMLElement, refreshStats: () => void}}
 */
export function buildMemoryPanel(ctx, settings, api) {
    const statusLine = el('div', { class: 'wupi-mem-status', text: api.getModelStatus() });
    const statsLine = el('div', { class: 'wupi-mem-status' });

    const refreshStats = async () => {
        statusLine.textContent = api.getModelStatus();
        statsLine.textContent = await api.refreshStats();
    };

    // --- token limit slider ---
    const tokenValueLabel = el('span', { class: 'wupi-mem-token-value', text: `${settings.tokenLimit} tokens` });
    const tokenSlider = el('input', { type: 'range', min: '256', max: '32768', step: '128' });
    tokenSlider.value = String(settings.tokenLimit);
    tokenSlider.addEventListener('input', () => {
        tokenValueLabel.textContent = `${tokenSlider.value} tokens`;
    });
    tokenSlider.addEventListener('change', () => {
        settings.tokenLimit = Number(tokenSlider.value);
        api.save();
        api.refreshStats();
    });

    // --- assemble ---
    const content = el('div', { class: 'wupi-engine-content' },
        el('div', { class: 'wupi-mem-intro', text: 'WupiMemory gives each chat a long-term memory. It remembers what happened and quietly reminds the AI of the relevant parts, so nothing important is forgotten. When you delete a chat, its memories are deleted too.' }),

        block('Memory',
            checkbox('Enable memory', settings.enabled, (v) => {
                settings.enabled = v;
                api.save();
                api.onEnabled?.(v);
            }),
            checkbox('Remember new messages automatically', settings.autoArchive, (v) => { settings.autoArchive = v; api.save(); }),
            checkbox('Recall memories automatically', settings.autoInject, (v) => { settings.autoInject = v; api.save(); }),
            hint('Remembering saves each turn after the AI replies. Recalling searches memory before each reply and shows the AI what matters. When this is on, the reading model loads by itself.'),
        ),

        block('AI model',
            el('div', { class: 'wupi-mem-note', text: 'The reading model (bge-small-en-v1.5) runs fully on your device. The first load downloads about 35 MB once, then it works offline.' }),
            el('div', { class: 'wupi-mem-row' },
                button('Load model', async () => {
                    try {
                        toastr.info('Loading the model. This can take a minute the first time.');
                        await api.loadModel();
                        statusLine.textContent = api.getModelStatus();
                        toastr.success('Model ready.');
                    } catch (err) {
                        console.error('WupiMemory loadModel', err);
                        statusLine.textContent = api.getModelStatus();
                        toastr.error(String(err?.message ?? err));
                    }
                }),
                button('Run self-test', async () => {
                    try {
                        const r = await api.selfTest();
                        statusLine.textContent = api.getModelStatus();
                        if (r.ok) {
                            toastr.success(`Self-test passed (self-similarity ${r.high.toFixed(3)}, separation ${r.gap.toFixed(3)})`);
                        } else {
                            toastr.warning(`Self-test failed: ${r.reason}`);
                        }
                    } catch (err) {
                        toastr.error(String(err?.message ?? err));
                    }
                }),
            ),
            statusLine,
            el('details', { class: 'wupi-mem-advanced' },
                el('summary', { text: 'Advanced model options' }),
                textField('Model id', settings.model, (v) => { settings.model = v; api.save(); }),
                el('div', { class: 'wupi-mem-row' },
                    selectField('Precision', settings.dtype, [['q8', 'q8 (small, recommended)'], ['fp32', 'fp32 (exact, larger)']], (v) => { settings.dtype = v; api.save(); }),
                    selectField('Device', settings.device, [['auto', 'auto'], ['wasm', 'wasm (CPU)'], ['webgpu', 'webgpu (GPU)']], (v) => { settings.device = v; api.save(); }),
                ),
            ),
        ),

        block('Fine tuning',
            el('div', { class: 'wupi-mem-row' },
                numberField('Memories per reply', settings.topK, { min: 1, max: 50, step: 1, onChange: (v) => { settings.topK = v; api.save(); } }),
                numberField('Match strictness', settings.denseFloor, { min: 0, max: 1, step: 0.01, onChange: (v) => { settings.denseFloor = v; api.save(); } }),
            ),
            hint('Memories per reply: how many memories to show the AI (default 5). Match strictness: how similar a memory must be to count as relevant. 0.58 is the default. Lower finds more but noisier memories, higher finds fewer but better ones.'),
            el('details', { class: 'wupi-mem-advanced' },
                el('summary', { text: 'Expert options' }),
                el('div', { class: 'wupi-mem-row' },
                    numberField('Candidate pool', settings.retrievalDepth, { min: 8, max: 256, step: 1, onChange: (v) => { settings.retrievalDepth = v; api.save(); } }),
                    numberField('Keyword weight', settings.weightSparse, { min: 0, max: 1, step: 0.05, onChange: (v) => { settings.weightSparse = v; api.save(); } }),
                    numberField('Meaning weight', settings.weightDense, { min: 0, max: 1, step: 0.05, onChange: (v) => { settings.weightDense = v; api.save(); } }),
                ),
                hint('Keyword weight vs meaning weight: the balance between exact word matching and meaning matching. 0.5 / 0.5 is balanced.'),
            ),
        ),

        block('Placement',
            el('div', { class: 'wupi-mem-row' },
                selectField('Position', settings.position, [['1', 'In chat (recommended)'], ['2', 'Before the system prompt'], ['0', 'In the system area']], (v) => { settings.position = v; api.save(); }),
                numberField('Depth', settings.depth, { min: 0, max: 32, step: 1, onChange: (v) => { settings.depth = v; api.save(); } }),
                selectField('Send as', settings.role, [['0', 'system'], ['1', 'user'], ['2', 'assistant']], (v) => { settings.role = v; api.save(); }),
            ),
            selectField('Memory scope', settings.perChat ? 'chat' : 'character', [['chat', 'Per chat (recommended: each chat remembers alone)'], ['character', 'Per character (all chats share memory)']], (v) => { settings.perChat = v === 'chat'; api.save(); refreshStats(); }),
            hint('In chat with depth 0 places the memory block at the end of the prompt, right before the AI answers. This is the recommended and most cache-friendly spot.'),
        ),

        block('Chat length limit',
            checkbox('Limit how much chat history is sent', settings.tokenLimitEnabled, (v) => { settings.tokenLimitEnabled = v; api.save(); api.refreshStats(); }),
            el('div', { class: 'wupi-mem-slider-row' },
                el('span', { text: '256' }),
                tokenSlider,
                el('span', { text: '32k' }),
                tokenValueLabel,
            ),
            checkbox('Also limit hidden tool prompts', settings.tokenLimitQuiet, (v) => { settings.tokenLimitQuiet = v; api.save(); }),
            el('div', { class: 'wupi-mem-note', text: 'If the chat grows past the budget, only the oldest messages are left out of the prompt. Your system prompt, character info, persona, lorebooks and author\'s note are never touched. When a trim happens it drops a little extra so it does not repeat on the very next message, which keeps caching effective.' }),
        ),

        block('Your data',
            statsLine,
            el('div', { class: 'wupi-mem-row' },
                button('Import current chat', async () => {
                    try {
                        const n = await api.syncChat();
                        toastr.success(`Saved ${n} message(s) to memory.`);
                        refreshStats();
                    } catch (err) {
                        console.error('WupiMemory syncChat', err);
                        toastr.error(String(err?.message ?? err));
                    }
                }),
                button('Delete all memories', async () => {
                    const scope = settings.perChat ? 'this chat' : 'this character (all its chats)';
                    const confirmed = await ctx.callGenericPopup(
                        `Delete ALL memories for ${scope}? This cannot be undone.`,
                        ctx.POPUP_TYPE?.CONFIRM ?? 2,
                    );
                    if (confirmed !== 1 && confirmed !== true) return;
                    try {
                        const n = await api.wipeCharacter();
                        toastr.success(`Deleted ${n} memor(ies).`);
                        refreshStats();
                    } catch (err) {
                        console.error('WupiMemory wipe', err);
                        toastr.error(String(err?.message ?? err));
                    }
                }, 'wupi-mem-danger'),
            ),
            hint('Import current chat saves the whole visible chat into memory. Handy when you turn this on for an existing chat.'),
        ),

        block('Commands',
            el('div', { class: 'wupi-mem-note', html: 'Power-user commands: <code>/wupi-search</code> <code>/wupi-sync</code> <code>/wupi-status</code> <code>/wupi-selftest</code> <code>/wupi-wipe</code>' }),
        ),
    );

    const node = el('div', { class: 'wupi-mem wupi-engine-panel' },
        el('div', { class: 'wupi-engine-head' }, el('b', { text: '🧠 WupiMemory' })),
        content,
    );

    refreshStats();
    return { node, refreshStats };
}
