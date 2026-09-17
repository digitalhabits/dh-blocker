// App-styled dropdowns over native <select>s.
//
// Every dropdown in the app gets a trigger button and a menu styled like the
// Settings language picker, instead of the OS menu. The native <select> stays
// in the DOM, visually hidden, as the single source of truth: existing code
// keeps reading and writing `.value`, toggling `.disabled`, rebuilding options
// and listening for `change`, and the trigger follows along.
//
// The menu is appended to <body> and positioned against its trigger rather
// than nested under it, because editor panels clip overflow
// (`.exit-difficulty-panel`) and modal bodies scroll.
//
// Declarations only at module top level (see AGENTS.md).

/** Selects that stay native: the hidden bookkeeping select for the selected space. */
const NATIVE_SELECT_IDS = new Set(['blocklist-select']);

let openInstance = null;
let globalListenersBound = false;
let instanceCounter = 0;

/** Enhance every select under `root` that is not already enhanced. */
export function enhanceNativeSelects(root = document) {
    root.querySelectorAll('select').forEach((select) => {
        if (NATIVE_SELECT_IDS.has(select.id)) return;
        enhanceSelect(select);
    });
}

/** Wrap one native select with the app-styled trigger and menu. Idempotent. */
export function enhanceSelect(select) {
    if (!select || select.dataset.customSelectBound === '1') return null;
    select.dataset.customSelectBound = '1';
    bindGlobalListeners();

    instanceCounter += 1;
    const baseId = select.id || `custom-select-${instanceCounter}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    wrapper.dataset.for = baseId;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.id = `${baseId}-trigger`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
        <span class="custom-select-value"></span>
        <svg class="custom-select-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 10l5-4.5 5 4.5"></path>
            <path d="M7 14l5 4.5 5-4.5"></path>
        </svg>
    `;

    const menu = document.createElement('div');
    menu.className = 'custom-select-menu hidden';
    menu.id = `${baseId}-menu`;
    menu.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', menu.id);

    // Accessible name: the select's aria-label, or the <label for> pointing at it.
    const label = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
    if (select.getAttribute('aria-label')) {
        trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
    } else if (label) {
        if (!label.id) label.id = `${baseId}-label`;
        trigger.setAttribute('aria-labelledby', label.id);
        label.addEventListener('click', (e) => {
            e.preventDefault();
            trigger.focus();
        });
    }

    // The native select moves inside the wrapper and out of the tab order.
    select.insertAdjacentElement('beforebegin', wrapper);
    wrapper.appendChild(select);
    wrapper.appendChild(trigger);
    select.classList.add('custom-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    document.body.appendChild(menu);

    const inst = { select, wrapper, trigger, menu };
    installValueHooks(inst);

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openInstance === inst) closeMenu(inst, { focusTrigger: false });
        else openMenu(inst);
    });
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (openInstance !== inst) openMenu(inst);
        }
    });

    // Clicks inside the menu must not reach document-level "click outside"
    // handlers (deselecting the space, closing card menus).
    menu.addEventListener('click', (e) => {
        e.stopPropagation();
        const option = e.target.closest('[data-value]');
        if (!option || option.disabled) return;
        choose(inst, option.dataset.value);
    });
    menu.addEventListener('keydown', (e) => onMenuKeydown(inst, e));

    syncTrigger(inst);
    return inst;
}

/** Close whichever menu is open. Returns true when one was open (Escape layers). */
export function closeOpenCustomSelect() {
    if (!openInstance) return false;
    closeMenu(openInstance, { focusTrigger: true });
    return true;
}

function installValueHooks(inst) {
    const { select } = inst;
    const proto = HTMLSelectElement.prototype;
    for (const prop of ['value', 'selectedIndex', 'disabled']) {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc?.get || !desc?.set) continue;
        Object.defineProperty(select, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get() { return desc.get.call(this); },
            set(next) {
                desc.set.call(this, next);
                syncTrigger(inst);
            },
        });
    }
    select.addEventListener('change', () => syncTrigger(inst));
    // Options rebuilt or relabelled (language switch), class/attribute changes.
    new MutationObserver(() => syncTrigger(inst)).observe(select, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'class', 'hidden'],
    });
}

function syncTrigger(inst) {
    const { select, wrapper, trigger } = inst;
    const selected = select.selectedOptions?.[0] || select.options[select.selectedIndex] || null;
    const valueEl = trigger.querySelector('.custom-select-value');
    if (valueEl) valueEl.textContent = selected ? selected.textContent.trim() : '';
    trigger.disabled = select.disabled;
    // The editor's locked look ("form-select-disabled") carries over.
    trigger.classList.toggle('custom-select-trigger--locked', select.classList.contains('form-select-disabled'));
    wrapper.classList.toggle('hidden', select.classList.contains('hidden') || select.hidden);
    if (openInstance === inst) {
        if (select.disabled) closeMenu(inst, { focusTrigger: false });
        else renderOptions(inst);
    }
}

function renderOptions(inst) {
    const { select, menu } = inst;
    menu.innerHTML = '';
    [...select.options].forEach((option) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'custom-select-option';
        btn.setAttribute('role', 'option');
        btn.dataset.value = option.value;
        btn.textContent = option.textContent.trim();
        const isSelected = option.selected;
        btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        btn.classList.toggle('custom-select-option--selected', isSelected);
        btn.disabled = option.disabled;
        btn.tabIndex = -1;
        menu.appendChild(btn);
    });
}

function openMenu(inst) {
    if (inst.select.disabled || inst.trigger.classList.contains('custom-select-trigger--locked')) return;
    if (openInstance && openInstance !== inst) closeMenu(openInstance, { focusTrigger: false });
    renderOptions(inst);
    inst.menu.classList.remove('hidden');
    inst.trigger.setAttribute('aria-expanded', 'true');
    openInstance = inst;
    positionMenu(inst);
    const current = inst.menu.querySelector('.custom-select-option--selected') || inst.menu.querySelector('.custom-select-option');
    current?.focus({ preventScroll: true });
    current?.scrollIntoView?.({ block: 'nearest' });
}

function closeMenu(inst, { focusTrigger }) {
    inst.menu.classList.add('hidden');
    inst.trigger.setAttribute('aria-expanded', 'false');
    if (openInstance === inst) openInstance = null;
    if (focusTrigger) inst.trigger.focus({ preventScroll: true });
}

function choose(inst, value) {
    const { select } = inst;
    const changed = select.value !== value;
    select.value = value;
    closeMenu(inst, { focusTrigger: true });
    if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function onMenuKeydown(inst, e) {
    const options = [...inst.menu.querySelectorAll('.custom-select-option:not(:disabled)')];
    const index = options.indexOf(document.activeElement);
    const focusAt = (i) => {
        const target = options[Math.max(0, Math.min(options.length - 1, i))];
        target?.focus({ preventScroll: true });
        target?.scrollIntoView?.({ block: 'nearest' });
    };
    switch (e.key) {
        case 'ArrowDown': e.preventDefault(); focusAt(index + 1); break;
        case 'ArrowUp': e.preventDefault(); focusAt(index - 1); break;
        case 'Home': e.preventDefault(); focusAt(0); break;
        case 'End': e.preventDefault(); focusAt(options.length - 1); break;
        case 'Escape':
            // Stop here so the app's own Escape (deselect / close dialog) does not also fire.
            e.preventDefault();
            e.stopPropagation();
            closeMenu(inst, { focusTrigger: true });
            break;
        case 'Tab':
            closeMenu(inst, { focusTrigger: true });
            break;
        default:
            break;
    }
}

/**
 * Below the trigger, left-aligned and at least as wide; flipped above when
 * there is more room there; kept inside the viewport. Coordinates are divided
 * by any CSS `zoom` on <html> (the non-native UI zoom fallback), since the
 * menu is itself inside the zoomed document.
 */
function positionMenu(inst) {
    const { trigger, menu } = inst;
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const rect = trigger.getBoundingClientRect();
    const viewportW = window.innerWidth / zoom;
    const viewportH = window.innerHeight / zoom;
    const margin = 8;
    const gap = 6;
    const left = rect.left / zoom;
    const top = rect.top / zoom;
    const bottom = rect.bottom / zoom;
    const width = rect.width / zoom;

    menu.style.minWidth = `${width}px`;
    menu.style.maxHeight = '';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const menuRect = menu.getBoundingClientRect();
    const menuW = menuRect.width / zoom;
    const menuH = menuRect.height / zoom;

    const spaceBelow = viewportH - bottom - gap - margin;
    const spaceAbove = top - gap - margin;
    const placeAbove = menuH > spaceBelow && spaceAbove > spaceBelow;
    const available = Math.max(120, placeAbove ? spaceAbove : spaceBelow);
    menu.style.maxHeight = `${available}px`;
    const finalH = Math.min(menuH, available);

    const x = Math.max(margin, Math.min(left, viewportW - menuW - margin));
    const y = placeAbove ? top - gap - finalH : bottom + gap;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

function bindGlobalListeners() {
    if (globalListenersBound) return;
    globalListenersBound = true;
    // A press anywhere outside the open menu and its trigger closes it.
    document.addEventListener('pointerdown', (e) => {
        if (!openInstance) return;
        if (openInstance.menu.contains(e.target) || openInstance.trigger.contains(e.target)) return;
        closeMenu(openInstance, { focusTrigger: false });
    }, true);
    // The menu is positioned once on open; anything that moves the trigger closes it.
    window.addEventListener('resize', () => {
        if (openInstance) closeMenu(openInstance, { focusTrigger: false });
    });
    document.addEventListener('scroll', (e) => {
        if (!openInstance || openInstance.menu.contains(e.target)) return;
        closeMenu(openInstance, { focusTrigger: false });
    }, true);
}
