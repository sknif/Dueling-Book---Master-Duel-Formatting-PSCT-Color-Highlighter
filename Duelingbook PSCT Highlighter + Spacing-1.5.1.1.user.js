
 // ==UserScript==
 // @name         Duelingbook PSCT Highlighter + Spacing
 // @namespace    local.duelingbook.psct
 // @version      1.5.1.1
 // @description  PSCT color highlighting and optional paragraph spacing.
 // @match        https://www.duelingbook.com/*
 // @run-at       document-idle
 // @grant        none
 // ==/UserScript==

 (() => {
     'use strict';

     const SELECTOR =
         '#preview_txt > div:nth-child(2) > span';
     const FLAG_ATTR = 'data-psct-bg-highlighted';
     const ORIGINAL_ATTR = 'data-psct-original-html';

     const COLORS = {
         condition: 'rgba(45, 180, 75, 0.28)',
         cost:      'rgba(235, 55, 55, 0.27)',
         effect:    'rgba(55, 125, 250, 0.25)'
     };

     let enabled = true;
     let spacingEnabled = true;

     // Batch candidate processing.
     const pending = new Set();
     let frameScheduled = false;
     let scanning = false;

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

     // Split at periods outside double quotes.
     // Keep a closing parenthesis attached to the period.
     function splitSentences(text) {
         const sentences = [];
         let start = 0;
         let inQuotes = false;

         for (let i = 0; i < text.length; i++) {
             if (text[i] === '"') {
                 inQuotes = !inQuotes;
                 continue;
             }

             if (text[i] !== '.' || inQuotes) continue;

             // Do not split decimal numbers.
             if (
                 i > 0 &&
                 i + 1 < text.length &&
                 /\d/.test(text[i - 1]) &&
                 /\d/.test(text[i + 1])
             ) {
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

     function findSeparators(text) {
         let colon = -1;
         let semicolon = -1;
         let inQuotes = false;

         for (let i = 0; i < text.length; i++) {
             if (text[i] === '"') {
                 inQuotes = !inQuotes;
                 continue;
             }

             if (inQuotes) continue;

             if (text[i] === ':' && colon === -1) colon = i;
             if (text[i] === ';' && semicolon === -1) semicolon = i;
         }

         return { colon, semicolon };
     }

     function parseText(text) {
         const fragment = document.createDocumentFragment();
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
             const sentence = sentences[i];
             if (!sentence) continue;

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

             if (!enabled) {
                 add(sentence, 'effect');
             } else if (colon === -1 && semicolon === -1) {
                 add(body + ending, 'effect');
             } else if (
                 colon !== -1 &&
                 (semicolon === -1 || colon < semicolon)
             ) {
                 add(body.slice(0, colon + 1), 'condition');

                 if (semicolon !== -1) {
                     add(body.slice(colon + 1, semicolon + 1), 'cost');
                     add(body.slice(semicolon + 1) + ending, 'effect');
                 } else {
                     add(body.slice(colon + 1) + ending, 'effect');
                 }
             } else {
                 add(body.slice(0, semicolon + 1), 'cost');
                 add(body.slice(semicolon + 1) + ending, 'effect');
             }

             if (!spacingEnabled || !endsWithPeriod) continue;

             const nextSentence = sentences
                 .slice(i + 1)
                 .join('')
                 .trimStart();

             if (!nextSentence) continue;

             // Don't put a blank line before bullets or parentheses,
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

             // Blank line after every sentence-ending period.
             makeBreak(fragment);
             makeBreak(fragment);
         }

         return fragment;
     }

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

                 const isFirstOriginalBreak = !firstOriginalBreakSeen;
                 firstOriginalBreakSeen = true;

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

                 const nextOriginalNodeIsBreak =
                     node.nextSibling?.nodeName === 'BR';

                 const previousOriginalNodeIsBreak =
                     node.previousSibling?.nodeName === 'BR';

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
                 fragment.appendChild(node.cloneNode(true));
             }
         }

         if (enabled) {
             element.setAttribute(FLAG_ATTR, '1');
         } else {
             element.removeAttribute(FLAG_ATTR);
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
         element.removeAttribute(FLAG_ATTR);
     }

     function rerenderAll() {
         document.querySelectorAll(`[${ORIGINAL_ATTR}]`).forEach(element => {
             restoreElement(element);

             if (enabled || spacingEnabled) {
                 renderElement(element);
             }
         });

         if (enabled || spacingEnabled) scan();
     }

     function queue(element) {
         if (!element || !element.isConnected) return;
         if (element.hasAttribute(ORIGINAL_ATTR)) return;

         pending.add(element);

         if (frameScheduled) return;
         frameScheduled = true;

         requestAnimationFrame(() => {
             frameScheduled = false;
             const batch = Array.from(pending);
             pending.clear();

             for (const target of batch) {
                 if (target.isConnected) processElement(target);
             }
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

     function makeButton(id, label, bottom) {
         const button = document.createElement('button');
         button.id = id;
         button.type = 'button';
         button.textContent = label;

         Object.assign(button.style, {
             position: 'fixed',
             right: '14px',
             bottom,
             zIndex: '2147483647',
             padding: '8px 11px',
             border: '1px solid #777',
             borderRadius: '8px',
             background: '#20242b',
             color: '#fff',
             font: '600 12px sans-serif',
             cursor: 'pointer'
         });

         document.body.appendChild(button);
         return button;
     }

     function addToggles() {
         if (document.getElementById('psct-highlight-toggle')) return;

         const colorButton = makeButton(
             'psct-highlight-toggle',
             'PSCT Highlight: ON',
             '14px'
         );

         colorButton.addEventListener('click', () => {
             enabled = !enabled;
             colorButton.textContent = enabled
                 ? 'PSCT Highlight: ON'
                 : 'PSCT Highlight: OFF';
             rerenderAll();
         });

         const spacingButton = makeButton(
             'psct-spacing-toggle',
             'Spacing: ON',
             '56px'
         );

         spacingButton.addEventListener('click', () => {
             spacingEnabled = !spacingEnabled;
             spacingButton.textContent = spacingEnabled
                 ? 'Spacing: ON'
                 : 'Spacing: OFF';
             rerenderAll();
         });
     }

     function startObserver() {
         const observer = new MutationObserver(mutations => {
             if (!enabled && !spacingEnabled) return;

             for (const mutation of mutations) {
                 if (
                     mutation.target instanceof Element &&
                     mutation.target.closest(`[${FLAG_ATTR}="1"]`)
                 ) {
                     continue;
                 }

                 for (const node of mutation.addedNodes) {
                     if (node.nodeType !== Node.ELEMENT_NODE) continue;
                     if (node.closest?.(`[${FLAG_ATTR}="1"]`)) continue;
                     scan(node);
                 }
             }
         });

         observer.observe(document.body, {
             childList: true,
             subtree: true
         });
     }

     scan();
     addToggles();
     startObserver();
 })();
