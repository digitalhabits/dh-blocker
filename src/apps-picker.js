// Installed-apps picker modal (desktop + Android app lists).
// Extracted verbatim from app.js.
import { state } from './state.js';
import { tauriAPI } from './tauri-api.js';
import { escapeHtml } from './utils.js';
import { pushModalUndo } from './app.js';
import { ensureInstalledAppsCache } from './blocking-platform.js';
import { isProtectedApp } from './blocklist-utils.js';

/** Should the picker offer to add `filter` as a typed name? Only when the search
 *  found nothing, and never for the blocker itself — blocking it would take
 *  enforcement down with it. Separate from the DOM so it can be tested. */
export function canOfferTypedAppName(filter, installedApps = []) {
    const name = String(filter || '').trim();
    if (!name) return false;
    if (isProtectedApp(name)) return false;
    const lower = name.toLocaleLowerCase();
    return !installedApps.some((a) => (
        String(a?.display_name || '').toLocaleLowerCase() === lower
        || String(a?.process_name || '').toLocaleLowerCase() === lower
    ));
}

// The blocklist modal's selected-apps array lives inside setupModalListeners
// (app.js) and is shared with this picker via `window.modalApps`. Keep a
// fallback to `window.getModalApps()` so the picker still works if only the
// getter bridge exists during a refactor.
export async function openInstalledAppsPicker() {
    const modal = document.getElementById('app-picker-modal');
    const listEl = document.getElementById('app-picker-list');
    const searchInput = document.getElementById('app-picker-search');
    const addBtn = document.getElementById('app-picker-add-btn');
    const cancelBtn = document.getElementById('app-picker-cancel-btn');
    const browseBtn = document.getElementById('app-picker-browse-btn');

    if (!modal || !listEl) return;

    // No OS-level "browse for an app bundle" concept on Android —
    // installed apps are only reachable via PackageManager (already
    // covered by the list above).
    browseBtn?.classList.toggle('hidden', state.isAndroid);

    // Show modal with loading state
    modal.classList.remove('hidden');
    searchInput.value = '';
    listEl.innerHTML = '<div class="app-picker-loading">Scanning installed apps...</div>';

    // Opening this picker is the explicit freshness boundary for Android.
    // Refresh PackageManager here (rather than at app start) and persist the
    // resulting labels for the next launch.
    await ensureInstalledAppsCache({ refresh: state.isAndroid });
    if (!state.installedAppsCache) {
        listEl.innerHTML = '<div class="app-picker-empty">Could not scan installed apps. Use "Browse manually..." below.</div>';
    }

    const apps = state.installedAppsCache || [];
    const getModalApps = () => {
        if (Array.isArray(window.modalApps)) return window.modalApps;
        if (typeof window.getModalApps === 'function') {
            const sharedApps = window.getModalApps();
            if (Array.isArray(sharedApps)) return sharedApps;
        }
        return [];
    };
    const selectedProcessNames = new Set();
    // Desktop only: an app the scan missed can still be named by hand. On iOS and
    // Android the list comes from the OS and a typed name would match nothing.
    const canTypeNames = !state.isAndroid && !state.isIOS;
    const typedApps = [];

    function sameAppPickerName(displayName, processName) {
        const normalize = (value) => String(value || '').trim().toLocaleLowerCase();
        return normalize(displayName) === normalize(processName);
    }

    function renderAppList(filter = '') {
        const lowerFilter = filter.toLowerCase();
        const source = typedApps.length > 0 ? [...typedApps, ...apps] : apps;
        const filtered = filter
            ? source.filter(a =>
                a.display_name.toLowerCase().includes(lowerFilter) ||
                a.process_name.toLowerCase().includes(lowerFilter))
            : source;

        if (filtered.length === 0) {
            if (filter && canTypeNames) {
                const typed = filter.trim();
                const safe = escapeHtml(typed);
                listEl.innerHTML = `<div class="app-picker-empty">No installed app called "${safe}"</div>`
                    + (canOfferTypedAppName(typed, apps)
                        ? `<button type="button" class="modal-btn cancel-btn app-picker-add-typed">Add "${safe}" anyway</button>`
                        : '');
                listEl.querySelector('.app-picker-add-typed')
                    ?.addEventListener('click', () => addTypedName(typed));
                return;
            }
            listEl.innerHTML = filter
                ? '<div class="app-picker-empty">No apps match your search</div>'
                : '<div class="app-picker-empty">No installed apps found</div>';
            return;
        }

        listEl.innerHTML = filtered.map(app => {
            const alreadyAdded = getModalApps().some(a => a.toLowerCase() === app.process_name.toLowerCase());
            const isChecked = selectedProcessNames.has(app.process_name) || alreadyAdded;
            const checkedClass = isChecked ? ' checked' : '';
            const checkedAttr = isChecked ? ' checked' : '';
            const disabledAttr = alreadyAdded ? ' disabled' : '';
            const dimStyle = alreadyAdded ? ' style="opacity: 0.5;"' : '';
            const processLine = sameAppPickerName(app.display_name, app.process_name)
                ? ''
                : `<div class="app-picker-item-process">${escapeHtml(app.process_name)}</div>`;

            return `<label class="app-picker-item${checkedClass}"${dimStyle}>
                <input type="checkbox" data-process="${escapeHtml(app.process_name)}"${checkedAttr}${disabledAttr}>
                <div class="app-picker-item-info">
                    <div class="app-picker-item-name">${escapeHtml(app.display_name)}</div>
                    ${processLine}
                </div>
            </label>`;
        }).join('');

        // Attach checkbox handlers
        listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (cb.disabled) return;
            cb.addEventListener('change', () => {
                const proc = cb.dataset.process;
                if (cb.checked) {
                    selectedProcessNames.add(proc);
                } else {
                    selectedProcessNames.delete(proc);
                }
                cb.closest('.app-picker-item').classList.toggle('checked', cb.checked);
                updateAddButton();
            });
        });
    }

    function addTypedName(rawName) {
        const name = String(rawName || '').trim();
        if (!canOfferTypedAppName(name, apps)) return;
        typedApps.push({ display_name: name, process_name: name });
        selectedProcessNames.add(name);
        searchInput.value = '';
        renderAppList('');
        updateAddButton();
    }

    function updateAddButton() {
        const newCount = [...selectedProcessNames].filter(
            p => !getModalApps().some(a => a.toLowerCase() === p.toLowerCase())
        ).length;
        addBtn.textContent = newCount > 0 ? `Add Selected (${newCount})` : 'Add Selected';
        addBtn.disabled = newCount === 0;
    }

    renderAppList();
    updateAddButton();

    // Search filtering
    const onSearch = () => renderAppList(searchInput.value);
    searchInput.addEventListener('input', onSearch);

    // Enter adds the typed name, the same as the button.
    const onSearchKeydown = (e) => {
        if (e.key !== 'Enter' || !canTypeNames) return;
        e.preventDefault();
        if (listEl.querySelector('.app-picker-add-typed')) addTypedName(searchInput.value);
    };
    searchInput.addEventListener('keydown', onSearchKeydown);

    // Clean up and close
    function closePickerModal() {
        modal.classList.add('hidden');
        searchInput.removeEventListener('input', onSearch);
        searchInput.removeEventListener('keydown', onSearchKeydown);
        modal.removeEventListener('click', onOverlayClick);
    }

    // Cancel
    const onCancel = () => closePickerModal();
    cancelBtn.onclick = onCancel;

    // Click overlay to close
    const onOverlayClick = (e) => {
        if (e.target === modal) closePickerModal();
    };
    modal.addEventListener('click', onOverlayClick);

    // Add Selected
    addBtn.onclick = () => {
        const toAdd = [...selectedProcessNames].filter(
            p => !getModalApps().some(a => a.toLowerCase() === p.toLowerCase())
        );
        if (toAdd.length > 0) {
            const modalApps = getModalApps();
            const toAddCopy = [...toAdd];
            pushModalUndo('app', () => {
                toAddCopy.forEach(a => {
                    const i = modalApps.indexOf(a);
                    if (i !== -1) modalApps.splice(i, 1);
                });
                window.renderModalTags();
            });
            for (const appName of toAdd) {
                modalApps.push(appName);
            }
            window.renderModalTags();
        }
        closePickerModal();
    };

    // Browse manually — fall back to the OS file picker (desktop only)
    if (browseBtn && !state.isAndroid) {
        browseBtn.classList.remove('hidden');
        browseBtn.onclick = async () => {
            closePickerModal();
            const appNames = await tauriAPI.openAppPicker();
            if (appNames && appNames.length > 0) {
                const modalApps = getModalApps();
                const toAdd = appNames.filter(n => !modalApps.includes(n));
                if (toAdd.length > 0) {
                    const toAddCopy = [...toAdd];
                    pushModalUndo('app', () => {
                        toAddCopy.forEach(a => {
                            const i = modalApps.indexOf(a);
                            if (i !== -1) modalApps.splice(i, 1);
                        });
                        window.renderModalTags();
                    });
                }
                for (const appName of appNames) {
                    if (!modalApps.includes(appName)) {
                        modalApps.push(appName);
                    }
                }
                window.renderModalTags();
            }
        };
    } else if (browseBtn) {
        browseBtn.classList.add('hidden');
    }

    // Focus search input
    requestAnimationFrame(() => searchInput.focus());
}
