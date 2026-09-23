// The single typing-challenge engine behind every friction gate in the app:
// stopping a block or schedule (#override-modal), stopping everything
// (#override-all-modal), and confirming an edit that loosens a
// running focus space (also #override-modal, see openBlocklistUnlockChallenge).
//
// Previously this was implemented three times, in three files, with three id
// conventions and three state-ownership styles. The copies drifted into fifteen
// behavioural differences, five of them bugs — which is the argument for one
// implementation rather than the line count.
//
// A controller takes an explicit element map rather than reaching for
// getElementById. That is what lets the test suite drive it against synthetic
// detached nodes (see runChallengeControllerTests) — this engine had no
// automated coverage at all while it was hardcoding element ids.
//
// The controller owns its own challenge text and word state. Nothing lives on
// the shared `state` object, and nothing is a module-level `let`, so two modals
// can never tread on each other.
import {
    applyChallengeTypedInputSanitization,
    buildWordChallengeState,
    generateOverrideChallengeText,
    getCompletedChallengeText,
    getCurrentChallengeWord,
    isMobileWordByWordChallenge,
    normalizeChallengeComparableText,
    renderChallengeReferenceText,
    sanitizeChallengeTargetText,
    shouldBlockChallengeSpaceKey,
} from './override-challenge.js';
import { tSettingsFmt } from './i18n.js';

const DEFAULT_PROGRESS_GRADIENT = 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)';

/** First index where `typed` diverges from `target`, or -1 when it is a clean prefix/match. */
export function findFirstChallengeMismatch(typed, target) {
    if (typed === target) return -1;
    for (let i = 0; i < Math.max(typed.length, target.length); i++) {
        if (typed[i] !== target[i]) return i;
    }
    // typed is a strict prefix of target: the first missing character is the error.
    return typed.length < target.length ? typed.length : -1;
}

/** How many leading characters of `typed` match `target`. */
export function countCorrectChallengeChars(typed, target) {
    let correct = 0;
    for (let i = 0; i < typed.length && i < target.length; i++) {
        if (typed[i] !== target[i]) break;
        correct++;
    }
    return correct;
}

/**
 * Percentage of `target` completed.
 * Guarded against an empty target: the un-deduplicated override and override-all
 * copies divided by zero here and wrote `width: NaN%`, which the CSSOM drops,
 * freezing the bar at whatever it last showed.
 */
export function challengeProgressPercent(doneLength, totalLength) {
    if (!totalLength || totalLength <= 0) return 0;
    return Math.min(100, (doneLength / totalLength) * 100);
}

/**
 * @param {object} elements - textEl, inputEl, wordInputEl, wordProgressEl,
 *   currentWordEl, progressBarEl, confirmBtnEl, modalContentEl. Passed as a map
 *   because the three modals use three unrelated id conventions (pause drops the
 *   `challenge-` infix, override-all renames the progress bar) — there is no
 *   mechanical prefix rule to derive them from.
 */
export function createChallengeController(elements) {
    const {
        textEl, inputEl, wordInputEl, wordProgressEl,
        currentWordEl, progressBarEl, confirmBtnEl, modalContentEl,
    } = elements;

    let targetText = '';
    let wordState = null;
    let skipped = false;

    /**
     * @param {'char'|'word'|'none'} mode - 'none' hides the whole stack, for a
     *   skipped challenge. Emptying the elements is not enough: .challenge-text
     *   carries its own padding and background, so an empty one still paints a
     *   grey box, and a visible textarea invites input that goes nowhere.
     */
    const setStackMode = (mode) => {
        const hideAll = mode === 'none';
        const word = mode === 'word';
        textEl?.classList.toggle('hidden', hideAll);
        wordProgressEl?.classList.toggle('hidden', hideAll || !word);
        currentWordEl?.classList.toggle('hidden', hideAll || !word);
        wordInputEl?.classList.toggle('hidden', hideAll || !word);
        inputEl?.classList.toggle('hidden', hideAll || word);
        // Visibility is driven by the `hidden` class alone. override-all used to
        // mix in inline style.display and never clear it, so an element could
        // stay hidden no matter what the class said — clear any such leftovers.
        for (const el of [textEl, inputEl, wordInputEl, wordProgressEl, currentWordEl]) {
            if (el) el.style.display = '';
        }
    };

    const setProgress = (doneLength) => {
        if (progressBarEl) {
            progressBarEl.style.width = `${challengeProgressPercent(doneLength, targetText.length)}%`;
        }
    };

    const renderReference = (errorIndex = -1, cursorIndex = 0) => {
        renderChallengeReferenceText(textEl, targetText, { errorIndex, cursorIndex });
    };

    const renderWordState = () => {
        if (!wordState) return;
        const currentWord = getCurrentChallengeWord(wordState);
        // Only finished words count: the bar starts empty, not on the word still to type.
        const completed = getCompletedChallengeText(wordState);
        if (wordProgressEl) {
            wordProgressEl.textContent = tSettingsFmt('challengeWordProgressFmt', {
                current: wordState.currentIndex + 1,
                total: wordState.words.length,
            });
        }
        if (currentWordEl) currentWordEl.textContent = currentWord;
        if (wordInputEl) wordInputEl.value = '';
        setProgress(completed.length);
        if (confirmBtnEl) confirmBtnEl.disabled = !currentWord;
    };

    const wiggle = () => {
        if (!modalContentEl) return;
        modalContentEl.classList.remove('wiggle');
        void modalContentEl.offsetWidth; // force reflow so the animation restarts
        modalContentEl.classList.add('wiggle');
    };

    function getTypedValue() {
        if (wordState) return wordState.typedText ?? '';
        return inputEl?.value ?? '';
    }

    // ---- listeners (identical in all three copies before the dedup) ----

    const onTextInput = () => {
        const typed = applyChallengeTypedInputSanitization(inputEl);
        const correct = countCorrectChallengeChars(typed, targetText);
        const firstError = typed.slice(0, correct) === typed && correct === typed.length
            ? -1
            : correct;
        setProgress(correct);
        renderReference(firstError, correct);
    };

    const onWordInput = () => {
        if (!wordState || !currentWordEl) return;
        currentWordEl.textContent = getCurrentChallengeWord(wordState);
    };

    const onKeyDown = (e) => {
        if (shouldBlockChallengeSpaceKey(e.currentTarget, e)) {
            e.preventDefault();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault(); // never insert a newline into a challenge field
            // Route through the button rather than calling the submit function:
            // a disabled confirm button must suppress Enter too. The pause modal
            // used to bypass its own disabled button this way.
            confirmBtnEl?.click();
        }
    };

    const blockPaste = (e) => e.preventDefault();

    inputEl?.addEventListener('input', onTextInput);
    inputEl?.addEventListener('keydown', onKeyDown);
    inputEl?.addEventListener('paste', blockPaste);
    wordInputEl?.addEventListener('input', onWordInput);
    wordInputEl?.addEventListener('keydown', onKeyDown);
    wordInputEl?.addEventListener('paste', blockPaste);

    return {
        /**
         * @param {object} [opts]
         * @param {object} [opts.difficulty] - generates the challenge text
         * @param {string} [opts.text] - explicit text, wins over `difficulty`
         * @param {boolean} [opts.wordMode] - forces word-by-word (defaults to the
         *   difficulty's mobile behaviour)
         * @param {string} [opts.progressColor]
         * @param {boolean} [opts.skipChallenge] - no challenge at all; covers the
         *   frictionless pause and override-all's "nothing to clear"
         */
        open({ difficulty = null, text = null, wordMode = null, progressColor = null, skipChallenge = false } = {}) {
            skipped = !!skipChallenge;

            if (inputEl) inputEl.value = '';
            if (wordInputEl) wordInputEl.value = '';
            modalContentEl?.classList.remove('wiggle');

            if (skipped) {
                // Both inputs are cleared above. override-all used to leave stale
                // text in the now-hidden textarea, so confirm compared it against
                // '' and wiggled a field the user could no longer reach.
                targetText = '';
                wordState = null;
                setStackMode('none');
                renderReference();
                if (progressBarEl) progressBarEl.style.width = '0%';
                if (confirmBtnEl) confirmBtnEl.disabled = false;
                return;
            }

            const raw = text !== null
                ? text
                : generateOverrideChallengeText(difficulty?.type, difficulty?.count, difficulty?.customText);
            targetText = sanitizeChallengeTargetText(raw);

            const useWordMode = wordMode !== null ? !!wordMode : isMobileWordByWordChallenge(difficulty);
            wordState = useWordMode ? buildWordChallengeState(targetText) : null;
            setStackMode(wordState ? 'word' : 'char');

            // Always render through the shared helper: assigning textContent
            // directly (as override and pause used to) leaves data-challenge-render
            // stale, bypassing the WKWebView repaint guard on the first keystroke.
            renderReference();
            if (progressBarEl) {
                progressBarEl.style.width = '0%';
                progressBarEl.style.background = progressColor || DEFAULT_PROGRESS_GRADIENT;
            }

            if (wordState) {
                renderWordState();
            } else if (confirmBtnEl) {
                confirmBtnEl.disabled = false;
            }
        },

        /** Focus the active field. Separate from open() so callers can defer it to a rAF.
         *  `preventScroll` matters on iOS: without it the page scrolls to reveal
         *  the field and drags the sheet header up under the status bar. */
        focus() {
            if (skipped) return;
            (wordState ? wordInputEl : inputEl)?.focus({ preventScroll: true });
        },

        /**
         * @returns {{status: 'ok'|'advanced'|'rejected'}}
         *   'advanced' = a correct word that was not the last one; the caller
         *   should do nothing and let the user keep typing.
         */
        handleConfirm() {
            if (skipped) return { status: 'ok' };

            if (wordState) {
                const expected = getCurrentChallengeWord(wordState);
                const typed = wordInputEl?.value ?? '';
                // Normalized on both sides: word mode is mobile-only, and mobile
                // autocorrect substitutes curly apostrophes and dashes, which used
                // to make a correct answer fail here while char mode accepted it.
                if (normalizeChallengeComparableText(typed).trim()
                    !== normalizeChallengeComparableText(expected).trim()) {
                    wiggle();
                    if (currentWordEl) currentWordEl.textContent = expected;
                    return { status: 'rejected' };
                }

                wordState.currentIndex++;
                const done = wordState.currentIndex >= wordState.words.length;
                // Keep typedText a valid "completed so far" value at every step —
                // the pause copy only wrote it on the final word.
                wordState.typedText = done ? targetText : getCompletedChallengeText(wordState);
                if (!done) {
                    renderWordState();
                    wordInputEl?.focus({ preventScroll: true });
                    return { status: 'advanced' };
                }
                setProgress(targetText.length);
                return { status: 'ok' };
            }

            const typed = getTypedValue();
            if (typed === targetText) return { status: 'ok' };
            wiggle();
            renderReference(findFirstChallengeMismatch(typed, targetText));
            return { status: 'rejected' };
        },

        getTypedValue,

        /** Clear state without touching modal visibility (the caller owns that). */
        reset() {
            targetText = '';
            wordState = null;
            skipped = false;
            if (inputEl) inputEl.value = '';
            if (wordInputEl) wordInputEl.value = '';
            setStackMode('char');
            modalContentEl?.classList.remove('wiggle');
            if (confirmBtnEl) confirmBtnEl.disabled = false;
        },

        destroy() {
            inputEl?.removeEventListener('input', onTextInput);
            inputEl?.removeEventListener('keydown', onKeyDown);
            inputEl?.removeEventListener('paste', blockPaste);
            wordInputEl?.removeEventListener('input', onWordInput);
            wordInputEl?.removeEventListener('keydown', onKeyDown);
            wordInputEl?.removeEventListener('paste', blockPaste);
        },
    };
}

// The three modals' element ids, in one place. There is no mechanical rule that
// derives these from a prefix — pause drops the `challenge-` infix on two of
// them and override-all renames the progress bar — so the map is explicit. The
// inconsistency is a fossil of the hand-copying this module replaces; renaming
// the ids is deliberately left out of scope to keep the diff reviewable.
const CHALLENGE_ELEMENT_IDS = {
    override: {
        textEl: 'challenge-text',
        inputEl: 'challenge-input',
        wordInputEl: 'challenge-word-input',
        wordProgressEl: 'challenge-word-progress',
        currentWordEl: 'challenge-current-word',
        progressBarEl: 'challenge-progress-bar',
        confirmBtnEl: 'confirm-override-btn',
        modalContentSelector: '#override-modal .modal-content',
    },
    overrideAll: {
        textEl: 'override-all-challenge-text',
        inputEl: 'override-all-challenge-input',
        wordInputEl: 'override-all-challenge-word-input',
        wordProgressEl: 'override-all-word-progress',
        currentWordEl: 'override-all-current-word',
        progressBarEl: 'override-all-progress-bar',
        confirmBtnEl: 'confirm-override-all-btn',
        modalContentSelector: '#override-all-modal .modal-content',
    },
};

const controllerRegistry = {};

/**
 * The controller for a given modal, created on first use.
 *
 * Lazy so the DOM is guaranteed to exist by the time it is built, and reached
 * through a function rather than an exported binding so the three consumer
 * modules (app.js, confirm-modals.js, settings.js) share one instance without a
 * cross-module `let` — see the module conventions in AGENTS.md.
 *
 * @param {'override'|'overrideAll'} key
 */
export function getChallengeController(key) {
    if (!controllerRegistry[key]) {
        const ids = CHALLENGE_ELEMENT_IDS[key];
        if (!ids) throw new Error(`Unknown challenge controller: ${key}`);
        const { modalContentSelector, ...elementIds } = ids;
        const elements = { modalContentEl: document.querySelector(modalContentSelector) };
        for (const [name, id] of Object.entries(elementIds)) {
            elements[name] = document.getElementById(id);
        }
        controllerRegistry[key] = createChallengeController(elements);
    }
    return controllerRegistry[key];
}
