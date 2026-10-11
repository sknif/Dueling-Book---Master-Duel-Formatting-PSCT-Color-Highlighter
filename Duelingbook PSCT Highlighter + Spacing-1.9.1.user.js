// ==UserScript==
// @name         Duelingbook PSCT Highlighter + Spacing
// @namespace    local.duelingbook.psct
// @version      1.9.1
// @description  PSCT color highlighting and optional Master Duel-style paragraph spacing.
// @match        https://www.duelingbook.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    // Add more selectors here if card text also appears in other places
    // (deck editor, tooltips, etc.).
    const SELECTORS = [
        '#preview_txt > div:nth-child(2) > span'
    ];
    const SELECTOR = SELECTORS.join(', ');
    const ORIGINAL_ATTR = 'data-psct-original-html';

    const COLORS = {
        condition: 'rgba(45, 180, 75, 0.28)',
        cost:      'rgba(235, 55, 55, 0.27)',
        effect:    'rgba(55, 125, 250, 0.25)'
    };

    // Bullet/threshold labels are not PSCT conditions: "● 1+:", "● 5:",
    // "● Monster:", "● Spell:", "● Trap:", "● Heads:", "● Tails:".
    // They are colored like an effect so the line looks uniform.
    // Add more words to the list if other cards need them.
    const LABEL_RE = new RegExp(
        '^\\s*(?:' +
        '(?:[●•▪‣◦⁃]\\s*)?\\d+\\+?' +
        '|' +
        '[●•▪‣◦⁃]\\s*(?:Monster|Spell|Trap|Heads|Tails)(?: Card)?' +
        ')\\s*:\\s*'
    );

    // Section headers like "Pendulum Effect:" or "Monster Effect:".
    // On Duelingbook these are <b> elements. They are left uncolored and
    // get a blank line after them (when spacing is on).
    const HEADER_RE =
        /^\s*\[?\s*(?:Pendulum|Monster) Effects?\s*\]?\s*:?\s*$/i;

    // Intro text such as "You can activate 1 of these effects:" (or ending
    // in ";") is not a PSCT condition or cost, so it is colored as effect.
    // An optional parenthetical is allowed before the separator.
    const INTRO_RE =
        /\b(?:these|following)(?:\s+effects?)?(?:\s*\([^)]*\))?\s*[:;]\s*$/i;

    // Sentences that continue the previous effect get a single line break
    // instead of a blank line. One phrase per line; keep the commas.
    const CONTINUES_RE = new RegExp(
        '^(?:' +
        [
            'Then,',
            'After that,',
            'Also,',
            'If you do,',
            'If you do not,',
            'If you cannot,',
            'If you can(?:\'|\u2019)t,',
            'If you don(?:\'|\u2019)t,',
            'If it does not,',
            'If it doesn(?:\'|\u2019)t,',
            'If that happens,',
            'If not,',
            'If you call\\b',
            'If (?:the result is|it is|it\'s) (?:heads|tails)',
            'In that case,',
            'Otherwise,',
            '(?:That|These|Those)\\b'
        ].join('|') +
        ')'
    );

    // Abbreviations whose period must not end a sentence
    // (e.g. "No.", "vs.", "max.", "Min.").
    const ABBREVIATION_RE = /\b(?:No|vs|Lv|Rk|[Mm]ax|[Mm]in)$/;

    // Restore the user's last-used settings.
    let enabled = GM_getValue('psct_enabled', true);
    let spacingEnabled = GM_getValue('psct_spacing_enabled', true);

    // Batch candidate processing.
    const pending = new Set();
    let frameScheduled = false;
    let scanning = false;
    let observer = null;

    // ---------- Helpers ----------

    function highlight(text, type) {
        const span = document.createElement('span');
        span.textContent = text;
        span.dataset.psctType = type;
        span.style.backgroundColor = COLORS[type];
        span.style.color = 'inherit';
        span.style.borderRadius = '2px';
        span.style.boxDecorationBreak = 'clone';
        span.style.webkitBoxDecorationBreak = 'clone';
        span.style.display = 'inline';
        return span;
    }

    function makeBreak(fragment) {
        fragment.appendChild(document.createElement('br'));
    }

    function isBullet(text) {
        return /^[\s]*(?:[●•▪‣◦⁃]|[-*]\s+)/.test(text);
    }

    // Intro segments ("... of these effects:") are colored as effect.
    function segmentType(segment, defaultType) {
        return INTRO_RE.test(segment) ? 'effect' : defaultType;
    }

    // Tracks whether we are inside quotation marks (straight or curly).
    function nextQuoteState(ch, inQuotes) {
        if (ch === '"') return !inQuotes;
        if (ch === '\u201C') return true;
        if (ch === '\u201D') return false;
        return inQuotes;
    }

    function isQuoteChar(ch) {
        return ch === '"' || ch === '\u201C' || ch === '\u201D';
    }

    // Split at periods outside quotes.
    // Keep a closing parenthesis attached to the period.
    function splitSentences(text) {
        const sentences = [];
        let start = 0;
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];

            if (isQuoteChar(ch)) {
                inQuotes = nextQuoteState(ch, inQuotes);
                continue;
            }

            if (ch !== '.' || inQuotes) continue;

            // Do not split decimal numbers.
            if (
                i > 0 &&
                i + 1 < text.length &&
                /\d/.test(text[i - 1]) &&
                /\d/.test(text[i + 1])
            ) {
                continue;
            }

            // Do not split after abbreviations like "No." or "max.".
            if (ABBREVIATION_RE.test(text.slice(Math.max(0, i - 4), i))) {
                continue;
            }

            let end = i + 1;

            if (text[end] === ')') end++;

            sentences.push(text.slice(start, end));
            start = end;
            i = end - 1;
        }

        if (start < text.length) {
            sentences.push(text.slice(start));
        }

        return sentences;
    }

    // PSCT is "Condition: Cost; Effect", so only the first unquoted
    // colon and first unquoted semicolon matter.
    function findSeparators(text) {
        let colon = -1;
        let semicolon = -1;
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];

            if (isQuoteChar(ch)) {
                inQuotes = nextQuoteState(ch, inQuotes);
                continue;
            }

            if (inQuotes) continue;

            if (ch === ':' && colon === -1) colon = i;
            if (ch === ';' && semicolon === -1) semicolon = i;
        }

        return { colon, semicolon };
    }

    // ---------- Parsing ----------

    function parseLine(text, fragment) {
        const sentences = splitSentences(text);

        function add(value, type) {
            if (!value) return;

            if (!enabled || !value.trim()) {
                fragment.appendChild(document.createTextNode(value));
            } else {
                fragment.appendChild(highlight(value, type));
            }
        }

        for (let i = 0; i < sentences.length; i++) {
            let sentence = sentences[i];
            if (!sentence) continue;

            // Leading "● 1+:" / "● Monster:" style label (first sentence
            // only).
            if (i === 0) {
                const labelMatch = sentence.match(LABEL_RE);

                if (labelMatch) {
                    add(labelMatch[0], 'effect');
                    sentence = sentence.slice(labelMatch[0].length);
                    if (!sentence) continue;
                }
            }

            const trimmed = sentence.trimEnd();
            const endsWithParenthesis = trimmed.endsWith('.)');
            const endsWithPeriod = /\.\)?$/.test(trimmed);

            const body = endsWithPeriod
                ? trimmed.slice(0, endsWithParenthesis ? -2 : -1)
                : sentence;

            const ending = endsWithPeriod
                ? (endsWithParenthesis ? '.)' : '.')
                : '';

            const { colon, semicolon } = findSeparators(body);

            // A line that ends right after its colon
            // ("... apply the proper effect:") introduces the bullets below
            // it. It is not a PSCT condition.
            const endsWithColon =
                colon !== -1 &&
                semicolon === -1 &&
                body.slice(colon + 1).trim() === '';

            if (!enabled) {
                add(sentence, 'effect');
            } else if (endsWithColon) {
                add(body + ending, 'effect');
            } else if (colon === -1 && semicolon === -1) {
                add(body + ending, 'effect');
            } else if (
                colon !== -1 &&
                (semicolon === -1 || colon < semicolon)
            ) {
                const conditionText = body.slice(0, colon + 1);
                add(conditionText, segmentType(conditionText, 'condition'));

                if (semicolon !== -1) {
                    const costText = body.slice(colon + 1, semicolon + 1);
                    add(costText, segmentType(costText, 'cost'));
                    add(body.slice(semicolon + 1) + ending, 'effect');
                } else {
                    add(body.slice(colon + 1) + ending, 'effect');
                }
            } else {
                const costText = body.slice(0, semicolon + 1);
                add(costText, segmentType(costText, 'cost'));
                add(body.slice(semicolon + 1) + ending, 'effect');
            }

            if (!spacingEnabled || !endsWithPeriod) continue;

            const nextSentence = sentences
                .slice(i + 1)
                .join('')
                .trimStart();

            if (!nextSentence) continue;

            // No blank line before bullets or parentheses,
            // except when the next sentence starts with (Quick Effect).
            if (
                isBullet(nextSentence) ||
                (
                    nextSentence.startsWith('(') &&
                    !nextSentence.startsWith('(Quick Effect)')
                )
            ) {
                continue;
            }

            // "Then," / "That monster..." / coin toss results etc. continue
            // the same effect: single line break only.
            if (CONTINUES_RE.test(nextSentence)) {
                makeBreak(fragment);
                continue;
            }

            // Blank line between separate effects.
            makeBreak(fragment);
            makeBreak(fragment);
        }
    }

    function parseText(text) {
        const fragment = document.createDocumentFragment();

        // Split at newlines, and before any bullet character in the middle
        // of a line, so each bullet is parsed as its own line.
        const lines = text
            .split(/\r?\n/)
            .flatMap(line => line.split(/(?=[●•▪‣◦⁃])/))
            .filter(line => line.trim() !== '');

        if (lines.length <= 1) {
            parseLine(text, fragment);
            return fragment;
        }

        lines.forEach((line, index) => {
            if (index > 0) makeBreak(fragment);
            parseLine(line, fragment);
        });

        return fragment;
    }

    // ---------- Element processing ----------

    function isCandidate(element) {
        if (!(element instanceof HTMLElement)) return false;
        if (!element.matches(SELECTOR)) return false;
        if (element.dataset.psctType) return false;
        if (element.querySelector('[data-psct-type]')) return false;
        if (element.hasAttribute(ORIGINAL_ATTR)) return false;

        const text = (element.textContent || '').trim();
        return text.length >= 12 && text.length <= 3000;
    }

    function getMeaningfulSibling(startNode, direction) {
        let current = startNode;

        while (current) {
            if (current.nodeType === Node.TEXT_NODE) {
                if (current.textContent.trim() !== '') return current;
            } else if (current.nodeType === Node.ELEMENT_NODE) {
                if (current.nodeName !== 'BR') return current;
            }

            current = direction === 'next'
                ? current.nextSibling
                : current.previousSibling;
        }

        return null;
    }

    function renderElement(element) {
        const originalHTML = element.getAttribute(ORIGINAL_ATTR);
        if (originalHTML === null) return;

        const temp = document.createElement('div');
        temp.innerHTML = originalHTML;

        const fragment = document.createDocumentFragment();
        const nodes = Array.from(temp.childNodes);
        let firstOriginalBreakSeen = false;

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            if (node.nodeName === 'BR') {
                // Always preserve the original line break.
                makeBreak(fragment);

                const previousNode = getMeaningfulSibling(
                    node.previousSibling,
                    'previous'
                );

                const nextNode = getMeaningfulSibling(
                    node.nextSibling,
                    'next'
                );

                const previousText = previousNode
                    ? previousNode.textContent.trimEnd()
                    : '';

                const nextText = nextNode
                    ? nextNode.textContent.trimStart()
                    : '';

                const nextOriginalNodeIsBreak =
                    node.nextSibling?.nodeName === 'BR';

                const previousOriginalNodeIsBreak =
                    node.previousSibling?.nodeName === 'BR';

                // A header gets a blank line after it. If the page already
                // has two breaks there, don't add a third.
                if (HEADER_RE.test(previousText)) {
                    if (
                        spacingEnabled &&
                        !nextOriginalNodeIsBreak &&
                        !previousOriginalNodeIsBreak
                    ) {
                        makeBreak(fragment);
                    }

                    continue;
                }

                // The break before a header isn't the materials/effects
                // break.
                const nextIsHeader = HEADER_RE.test(nextText);
                const isFirstOriginalBreak =
                    !firstOriginalBreakSeen && !nextIsHeader;

                if (!nextIsHeader) firstOriginalBreakSeen = true;

                // First original BR separates materials from effects.
                if (
                    spacingEnabled &&
                    isFirstOriginalBreak &&
                    nextText &&
                    !isBullet(nextText)
                ) {
                    makeBreak(fragment);
                    continue;
                }

                if (
                    !spacingEnabled ||
                    !previousText ||
                    !nextText ||
                    isBullet(nextText) ||
                    nextText.startsWith('(')
                ) {
                    continue;
                }

                const previousIsBullet = isBullet(previousText);
                const previousEndsSentence = /[.!?]\)?$/.test(previousText);

                if (
                    !nextOriginalNodeIsBreak &&
                    !previousOriginalNodeIsBreak &&
                    (previousIsBullet || previousEndsSentence)
                ) {
                    makeBreak(fragment);
                }
            } else if (node.nodeType === Node.TEXT_NODE) {
                fragment.appendChild(parseText(node.textContent || ''));
            } else {
                // Other elements (such as the <b> headers) are kept as is.
                fragment.appendChild(node.cloneNode(true));
            }
        }

        element.replaceChildren(fragment);
    }

    function processElement(element) {
        if (!enabled && !spacingEnabled) return;
        if (!isCandidate(element)) return;

        if (!element.hasAttribute(ORIGINAL_ATTR)) {
            element.setAttribute(ORIGINAL_ATTR, element.innerHTML);
        }

        renderElement(element);
    }

    function restoreElement(element) {
        const originalHTML = element.getAttribute(ORIGINAL_ATTR);
        if (originalHTML === null) return;

        element.innerHTML = originalHTML;
    }

    // Throw away mutation records caused by our own DOM changes.
    function discardOwnMutations() {
        if (observer) observer.takeRecords();
    }

    function rerenderAll() {
        // Handle any outside changes that are still waiting first.
        if (observer) handleMutations(observer.takeRecords());

        document.querySelectorAll(`[${ORIGINAL_ATTR}]`).forEach(element => {
            restoreElement(element);

            if (enabled || spacingEnabled) {
                renderElement(element);
            } else {
                // Everything is off: forget the stored original so the
                // element is processed fresh next time.
                element.removeAttribute(ORIGINAL_ATTR);
            }
        });

        discardOwnMutations();

        if (enabled || spacingEnabled) scan();
    }

    function queue(element) {
        if (!element || !element.isConnected) return;
        if (element.hasAttribute(ORIGINAL_ATTR)) return;

        pending.add(element);

        if (frameScheduled) return;
        frameScheduled = true;

        requestAnimationFrame(() => {
            // Pick up outside changes first (frameScheduled is still true,
            // so anything they queue lands in this batch).
            if (observer) handleMutations(observer.takeRecords());

            frameScheduled = false;
            const batch = Array.from(pending);
            pending.clear();

            for (const target of batch) {
                if (target.isConnected) processElement(target);
            }

            discardOwnMutations();
        });
    }

    function scan(root = document) {
        if (scanning) return;
        scanning = true;

        try {
            if (root instanceof Element) {
                if (root.matches(SELECTOR)) queue(root);
            }

            if (root.querySelectorAll) {
                root.querySelectorAll(SELECTOR).forEach(queue);
            }
        } finally {
            scanning = false;
        }
    }

    // ---------- Mutation handling ----------

    // Only outside (page) mutations reach this function, because our own
    // are discarded right after we make them.
    function handleMutations(records) {
        if (!enabled && !spacingEnabled) return;

        for (const mutation of records) {
            const target = mutation.target instanceof Element
                ? mutation.target
                : mutation.target.parentElement;

            if (target) {
                // The page changed text we already processed (for example,
                // a different card was loaded into the same element):
                // forget the old original and process it again.
                const processed = target.closest(`[${ORIGINAL_ATTR}]`);

                if (processed) {
                    processed.removeAttribute(ORIGINAL_ATTR);
                    queue(processed);
                    continue;
                }

                // Text changed in place before we ever processed it.
                const candidate = target.closest(SELECTOR);
                if (candidate) queue(candidate);
            }

            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) scan(node);
            }
        }
    }

    function startObserver() {
        observer = new MutationObserver(handleMutations);

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // ---------- UI ----------

    function makeButton(label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;

        Object.assign(button.style, {
            padding: '4px 8px',
            border: '1px solid #777',
            borderRadius: '6px',
            background: '#20242b',
            color: '#fff',
            // Shrinks with the screen width, between 9px and 12px.
            font: '600 clamp(9px, 2.4vw, 12px) sans-serif',
            cursor: 'pointer',
            whiteSpace: 'nowrap'
        });

        return button;
    }

    function addToggles() {
        if (document.getElementById('psct-controls')) return;

        let collapsed = GM_getValue('psct_ui_collapsed', false);

        const box = document.createElement('div');
        box.id = 'psct-controls';

        Object.assign(box.style, {
            position: 'fixed',
            right: '8px',
            bottom: '8px',
            zIndex: '2147483647',
            display: 'flex',
            gap: '4px',
            alignItems: 'center',
            opacity: '0.8'
        });

        const colorButton = makeButton('');
        const spacingButton = makeButton('');
        const handle = makeButton('\u22EF');

        const refresh = () => {
            colorButton.textContent =
                `Color: ${enabled ? 'ON' : 'OFF'}`;
            spacingButton.textContent =
                `Space: ${spacingEnabled ? 'ON' : 'OFF'}`;

            const display = collapsed ? 'none' : '';
            colorButton.style.display = display;
            spacingButton.style.display = display;
        };

        colorButton.addEventListener('click', () => {
            enabled = !enabled;
            GM_setValue('psct_enabled', enabled);
            refresh();
            rerenderAll();
        });

        spacingButton.addEventListener('click', () => {
            spacingEnabled = !spacingEnabled;
            GM_setValue('psct_spacing_enabled', spacingEnabled);
            refresh();
            rerenderAll();
        });

        handle.addEventListener('click', () => {
            collapsed = !collapsed;
            GM_setValue('psct_ui_collapsed', collapsed);
            refresh();
        });

        box.append(colorButton, spacingButton, handle);
        document.body.appendChild(box);
        refresh();
    }

    // Process existing card text on page load.
    startObserver();
    scan();
    addToggles();
})();