import { pushModalUndo } from './app.js';
import { state } from './state.js';
import { applyModalBlocklistTint, applyOverrideTypeUi, syncColorSwatchInk, updateOverridePreview } from './confirm-modals.js';
import { getMaxOverrideCountForType, getTypingCharsPerMinuteForType, normalizeOverrideCount } from './override-challenge.js';

export function setupFocusSpaceNameField(modalWebsiteInput) {
    function focusModalWebsiteInputFromNameField() {
        modalWebsiteInput.focus({ preventScroll: true });
        const pendingLen = modalWebsiteInput.value.length;
        const caret = pendingLen > 0 ? pendingLen : 0;
        modalWebsiteInput.setSelectionRange(caret, caret);
    }

    // Mobile: Name → websites. iOS shows plain Return (no default advance).
    if (state.isIOS) {
        const nameInput = document.getElementById('blocklist-name');
        nameInput.setAttribute('enterkeyhint', 'next');
        nameInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.keyCode !== 13) return;
            e.preventDefault();
            e.stopPropagation();
            focusModalWebsiteInputFromNameField();
        }, true);
    }

    // Touch: the tap that focuses the name puts the cursor at the end (iOS can land it at the start).
    const nameInput = document.getElementById('blocklist-name');
    let nameJustFocused = false;
    nameInput.addEventListener('focus', () => { nameJustFocused = true; });
    nameInput.addEventListener('click', () => {
        if (!nameJustFocused) return;
        nameJustFocused = false;
        if (document.body.classList.contains('ios')) {
            nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
        }
    });
    nameInput.addEventListener('blur', () => { nameJustFocused = false; });
    document.getElementById('blocklist-name').addEventListener('input', () => {
        const nameInput = document.getElementById('blocklist-name');
        nameInput.classList.remove('input-error');
        const previous = state.lastBlocklistNameValue;
        pushModalUndo('name', () => {
            nameInput.value = previous;
            state.lastBlocklistNameValue = previous;
            nameInput.classList.remove('input-error');
        });
        state.lastBlocklistNameValue = nameInput.value;
    });
}

export function setupFocusSpaceOverrideFields() {
    // Override type
    document.getElementById('override-type').addEventListener('change', (e) => {
        const overrideTypeSelect = e.target;
        const previousType = state.lastOverrideTypeValue;
        pushModalUndo('override-type', () => {
            overrideTypeSelect.value = previousType;
            state.lastOverrideTypeValue = previousType;
            overrideTypeSelect.dispatchEvent(new Event('change'));
        });

        const type = e.target.value;
        const overrideCountInput = document.getElementById('override-count');
        applyOverrideTypeUi(type);

        overrideCountInput.value = normalizeOverrideCount(overrideCountInput.value, type);
        state.lastOverrideTypeValue = overrideTypeSelect.value;
    });
    document.getElementById('custom-override-text').addEventListener('input', (e) => {
        const customTextArea = e.target;
        customTextArea.classList.remove('input-error');
        document.getElementById('custom-override-text-error')?.classList.add('hidden');
        const previous = state.lastCustomOverrideTextValue;
        pushModalUndo('custom-override-text', () => {
            customTextArea.value = previous;
            state.lastCustomOverrideTextValue = previous;
            customTextArea.classList.remove('input-error');
            document.getElementById('custom-override-text-error')?.classList.add('hidden');
            const warningEl = document.getElementById('override-count-warning');
            const maxChars = getMaxOverrideCountForType('custom');
            if (previous.length >= maxChars) {
                const charsPerMinute = getTypingCharsPerMinuteForType('custom');
                const estimatedMinutes = Math.ceil(maxChars / charsPerMinute);
                warningEl.textContent = `Max is ${maxChars} characters so it's still possible to override in case of emergency (takes you ~${estimatedMinutes} minutes to type).`;
                warningEl.classList.remove('hidden');
            } else {
                warningEl.classList.add('hidden');
                warningEl.textContent = '';
            }
        });

        const warningEl = document.getElementById('override-count-warning');
        const maxChars = getMaxOverrideCountForType('custom');
        const charsPerMinute = getTypingCharsPerMinuteForType('custom');
        const estimatedMinutes = Math.ceil(maxChars / charsPerMinute);
        e.target.maxLength = maxChars;

        if (e.target.value.length > maxChars) {
            e.target.value = e.target.value.slice(0, maxChars);
        }

        if (e.target.value.length >= maxChars) {
            warningEl.textContent = `Max is ${maxChars} characters so it's still possible to override in case of emergency (takes you ~${estimatedMinutes} minutes to type).`;
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
            warningEl.textContent = '';
        }
        state.lastCustomOverrideTextValue = e.target.value;
        updateOverridePreview();
    });

    // Words slider
    document.getElementById('override-count').addEventListener('input', (e) => {
        const overrideCountInput = e.target;
        const previous = state.lastOverrideCountValue;
        const current = overrideCountInput.value;
        if (previous !== current) {
            pushModalUndo('override-count', () => {
                overrideCountInput.value = previous;
                state.lastOverrideCountValue = previous;
                updateOverridePreview();
            });
        }
        state.lastOverrideCountValue = current;
        updateOverridePreview();
    });
}

export function setupFocusSpaceAppearanceFields() {
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
            applyModalBlocklistTint(swatch.dataset.color);
        });
    });
    document.getElementById('custom-color-input')?.addEventListener('input', (e) => {
        const customSwatch = document.getElementById('custom-color-swatch');
        const color = e.target.value;
        customSwatch.style.background = color;
        customSwatch.dataset.color = color;
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        customSwatch.classList.add('selected');
        syncColorSwatchInk();
        applyModalBlocklistTint(color);
    });

    // Emoji swatches
    document.querySelectorAll('.emoji-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            // Only handle non-custom swatches here, or custom swatches if they already have an emoji
            if (!swatch.classList.contains('custom-emoji-swatch') || swatch.dataset.emoji) {
                document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));
                swatch.classList.add('selected');
            }
        });
    });

    // Custom emoji picker with emoji-picker-element popover
    const customEmojiSwatch = document.getElementById('custom-emoji-swatch');
    const emojiPickerPopover = document.getElementById('emoji-picker-popover');
    const emojiPicker = emojiPickerPopover?.querySelector('emoji-picker');

    if (customEmojiSwatch && emojiPickerPopover && emojiPicker) {
        function readSafeAreaInsetTop() {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);';
            document.body.appendChild(probe);
            const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
            probe.remove();
            return inset;
        }

        /** Lowest Y (viewport coords) the picker top may use without overlapping safe area / chrome. */
        function getEmojiPickerMinTop(padding) {
            const safeTop = readSafeAreaInsetTop();
            const blocklistModal = document.getElementById('blocklist-modal');
            if (blocklistModal && !blocklistModal.classList.contains('hidden')) {
                const modalHeader = blocklistModal.querySelector('.mobile-modal-header');
                if (modalHeader) {
                    return modalHeader.getBoundingClientRect().bottom + padding;
                }
            }
            const titleBar = document.querySelector('.title-bar');
            const titleBarBottom = titleBar?.classList.contains('hidden')
                ? 0
                : (titleBar?.getBoundingClientRect().bottom ?? 0);
            return Math.max(safeTop + padding, titleBarBottom + padding);
        }

        function positionEmojiPickerPopover() {
            const gap = 8;
            const padding = 8;

            emojiPickerPopover.style.top = '';
            emojiPickerPopover.style.bottom = '';
            emojiPickerPopover.style.left = '';
            emojiPickerPopover.style.right = '';

            // Escape modal overflow clipping while open
            if (emojiPickerPopover.parentElement !== document.body) {
                document.body.appendChild(emojiPickerPopover);
            }

            emojiPickerPopover.classList.remove('hidden');

            const rect = customEmojiSwatch.getBoundingClientRect();
            const popoverRect = emojiPickerPopover.getBoundingClientRect();
            const popoverHeight = popoverRect.height;
            const popoverWidth = popoverRect.width;

            const minTop = getEmojiPickerMinTop(padding);
            const aboveTop = rect.top - popoverHeight - gap;
            const belowTop = rect.bottom + gap;
            // Place above only when the picker's top edge stays below the safe/chrome line.
            let top = aboveTop >= minTop ? aboveTop : belowTop;
            top = Math.max(minTop, Math.min(top, window.innerHeight - popoverHeight - padding));

            let left = rect.right - popoverWidth;
            left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));

            emojiPickerPopover.style.top = `${top}px`;
            emojiPickerPopover.style.left = `${left}px`;
        }

        // Toggle popover on swatch click
        customEmojiSwatch.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // The picker carries a sizeable emoji database. Load it only
            // when somebody opens the custom picker instead of parsing it on
            // every app launch.
            if (!customElements.get('emoji-picker')) {
                await import('emoji-picker-element');
            }

            if (emojiPickerPopover.classList.contains('hidden')) {
                positionEmojiPickerPopover();
            } else {
                emojiPickerPopover.classList.add('hidden');
            }
        });

        // Handle emoji selection
        emojiPicker.addEventListener('emoji-click', (e) => {
            const emoji = e.detail.unicode;
            customEmojiSwatch.innerHTML = emoji;
            customEmojiSwatch.dataset.emoji = emoji;

            // Select the custom swatch
            document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));
            customEmojiSwatch.classList.add('selected');

            // Hide popover
            emojiPickerPopover.classList.add('hidden');
        });

        // Close popover when clicking outside
        document.addEventListener('click', (e) => {
            if (!emojiPickerPopover.classList.contains('hidden') &&
                !emojiPickerPopover.contains(e.target) &&
                !customEmojiSwatch.contains(e.target)) {
                emojiPickerPopover.classList.add('hidden');
            }
        });
    }
}
