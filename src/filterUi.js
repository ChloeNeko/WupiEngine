/**
 * WupiFilter settings panel, shown in a popup from the wand extensions menu
 * (this used to be a drawer inside #extensions_settings). Pure DOM, no
 * template engine. Plain language, short sentences, no em-dashes.
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
    return el('div', { class: 'wupi-fl-block' },
        el('div', { class: 'wupi-fl-block-title', text: title }),
        ...children,
    );
}

/** Small helper text under a control. */
function hint(text) {
    return el('div', { class: 'wupi-fl-hint', text });
}

/** A pill that shows one blocked word. */
function chip(text, empty = false) {
    return el('span', { class: `wupi-fl-chip${empty ? ' wupi-fl-chip-empty' : ''}`, text });
}

/** Modern on/off switch built on a real checkbox, so it stays accessible. */
function switchToggle(labelText, checked, onChange) {
    const input = el('input', { type: 'checkbox', class: 'wupi-fl-switch-input' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'wupi-fl-switch' },
        input,
        el('span', { class: 'wupi-fl-switch-track' }, el('span', { class: 'wupi-fl-switch-knob' })),
        el('span', { class: 'wupi-fl-switch-label', text: labelText }),
    );
}

/** A slider with its live value on the right of the heading. */
function sliderField(labelText, value, { min, max, step = 1, format, onChange }) {
    const valueLabel = el('span', { class: 'wupi-fl-slider-value', text: format(value) });
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    input.value = String(value);
    input.addEventListener('input', () => {
        valueLabel.textContent = format(Number(input.value));
    });
    input.addEventListener('change', () => onChange(Number(input.value)));
    return el('div', { class: 'wupi-fl-slider' },
        el('div', { class: 'wupi-fl-slider-head' },
            el('span', { class: 'wupi-fl-slider-name', text: labelText }),
            valueLabel,
        ),
        input,
    );
}

/** Text input with a floating label line above it. */
function field(labelText, node) {
    return el('label', { class: 'wupi-fl-field' },
        el('span', { class: 'wupi-fl-field-label', text: labelText }),
        node,
    );
}

/** Text area with a label line above it. */
function area(labelText, node) {
    return el('label', { class: 'wupi-fl-field' },
        el('span', { class: 'wupi-fl-field-label', text: labelText }),
        node,
    );
}

function button(text, onClick, kind = '') {
    return el('div', {
        class: `menu_button wupi-fl-btn ${kind}`,
        text,
        onclick: (e) => { e.preventDefault(); onClick(); },
    });
}

function statTile(label) {
    const num = el('div', { class: 'wupi-fl-tile-num', text: '0' });
    const node = el('div', { class: 'wupi-fl-tile' }, num, el('div', { class: 'wupi-fl-tile-label', text: label }));
    return { node, set: (v) => { num.textContent = String(v); } };
}

/**
 * Build the Filter panel shown in the wand menu popup.
 * @param {object} ctx SillyTavern context
 * @param {object} settings live settings object (mutated in place)
 * @param {object} api callbacks:
 *   - save(): void
 *   - getStats(): {blocked, retried, lastBlocked, enabled}
 *   - resetStats(): void
 *   - test(text): {blocked, phrase}
 * @returns {{node: HTMLElement, refreshStats: () => void}}
 */
export function buildFilterPanel(ctx, settings, api) {
    // --- live status + activity ---
    const statusDot = el('span', { class: 'wupi-fl-dot' });
    const statusTextLine = el('span', { text: '' });
    const statusLine = el('div', { class: 'wupi-fl-status' }, statusDot, statusTextLine);

    const blockedTile = statTile('replies cut');
    const retriedTile = statTile('retries made');
    const lastLine = el('div', { class: 'wupi-fl-note', text: 'Nothing blocked yet.' });

    const refreshStats = () => {
        const st = api.getStats();
        blockedTile.set(st.blocked);
        retriedTile.set(st.retried);
        statusDot.classList.toggle('wupi-fl-dot-on', Boolean(st.enabled));
        statusTextLine.textContent = st.enabled ? 'Watching replies as they stream' : 'Paused';
        lastLine.textContent = st.lastBlocked ? `Last cut reply began: ${st.lastBlocked}` : 'Nothing blocked yet.';
    };

    // --- blocked words editor with live chips ---
    const wordsInput = el('input', { type: 'text', placeholder: 'sorry, i apologize' });
    wordsInput.value = settings.blockedWords;
    const chips = el('div', { class: 'wupi-fl-chips' });
    const renderChips = () => {
        chips.textContent = '';
        const list = wordsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!list.length) {
            chips.append(chip('No blocked words yet', true));
            return;
        }
        for (const w of list) chips.append(chip(w));
    };
    wordsInput.addEventListener('change', () => {
        settings.blockedWords = wordsInput.value;
        api.save();
        renderChips();
    });
    renderChips();

    // --- retry note template ---
    const noteInput = el('textarea', { class: 'wupi-fl-textarea', rows: '3' });
    noteInput.value = settings.retryNoteTemplate;
    noteInput.addEventListener('change', () => {
        settings.retryNoteTemplate = noteInput.value;
        api.save();
    });

    // --- assemble ---
    const content = el('div', { class: 'wupi-engine-content' },
        el('div', {
            class: 'wupi-fl-intro',
            text: 'WupiFilter watches each reply as it streams in. If the AI starts with a blocked word such as "sorry", the reply is cut off at once and regenerated. The stopped attempt is fully removed first, so the new reply starts from a clean slate and is never influenced by the discarded one.',
        }),

        block('Filter',
            switchToggle('Enable the filter gate', settings.enabled, (v) => { settings.enabled = v; api.save(); refreshStats(); }),
            field('Blocked words and phrases (comma separated)', wordsInput),
            chips,
            hint('Each entry can be one word or a short phrase. Only the opening words of a reply are checked, so words later in the reply are left alone.'),
            sliderField('Watch the first', settings.wordWindow, {
                min: 1, max: 12,
                format: (v) => `${v} ${v === 1 ? 'word' : 'words'}`,
                onChange: (v) => { settings.wordWindow = v; api.save(); },
            }),
            switchToggle('Match whole words only', settings.wholeWords, (v) => { settings.wholeWords = v; api.save(); }),
            hint('When on, "sorry" will not match inside "sorriest". Turn it off to catch fragments too.'),
            switchToggle('Case sensitive', settings.caseSensitive, (v) => { settings.caseSensitive = v; api.save(); }),
        ),

        block('Retry',
            sliderField('Retry limit per reply', settings.maxRetries, {
                min: 0, max: 6,
                format: (v) => (v === 0 ? 'cut only' : `${v} ${v === 1 ? 'try' : 'tries'}`),
                onChange: (v) => { settings.maxRetries = v; api.save(); },
            }),
            hint('When the limit is reached, the reply is let through and you get a notice. This keeps a stubborn model from looping forever.'),
            switchToggle('Fresh start on retry (recommended)', settings.freshStart, (v) => { settings.freshStart = v; api.save(); }),
            hint('The stopped reply is deleted before regenerating, so it never reaches the new prompt. A hidden one time note with a unique marker is also added, which stops the API from repeating the exact same refusal from its cache.'),
            switchToggle('Also check replies that arrive all at once', settings.checkNonStreaming, (v) => { settings.checkNonStreaming = v; api.save(); }),
            hint('Use this when your connection does not stream. The finished reply is checked the same way, then regenerated if needed.'),
            switchToggle('Show a notice when a reply is cut', settings.notify, (v) => { settings.notify = v; api.save(); }),
            el('details', { class: 'wupi-fl-advanced' },
                el('summary', { text: 'Advanced: retry note' }),
                area('Retry note template', noteInput),
                hint('Sent once, only for the retry, then removed. {{nonce}} is replaced with a random marker so the API treats it as a brand new request. Leave empty to send no note at all.'),
            ),
        ),

        block('Activity',
            statusLine,
            el('div', { class: 'wupi-fl-tiles' }, blockedTile.node, retriedTile.node),
            lastLine,
            el('div', { class: 'wupi-fl-row' },
                button('Reset counters', async () => {
                    const confirmed = await ctx.callGenericPopup('Reset the WupiFilter counters?', ctx.POPUP_TYPE?.CONFIRM ?? 2);
                    if (confirmed !== 1 && confirmed !== true) return;
                    api.resetStats();
                    refreshStats();
                }),
            ),
        ),

        block('Commands',
            el('div', { class: 'wupi-fl-note', html: 'Power-user commands: <code>/wupifilter-status</code> <code>/wupifilter-test</code> <code>/wupifilter-toggle</code>' }),
        ),
    );

    const node = el('div', { class: 'wupi-fl wupi-engine-panel' },
        el('div', { class: 'wupi-engine-head' }, el('b', { text: '🛡️ WupiFilter' })),
        content,
    );

    refreshStats();
    return { node, refreshStats };
}
