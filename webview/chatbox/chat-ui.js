let attachedImages = [];
let attachedFiles = [];

// --- AUTOCOMPLETE STATE ---
const { COMMANDS = [], WORKFLOWS = [], AGENTS = [] } = window.VS_CONSTANTS || {};
const autocompleteMenu = document.getElementById('autocomplete-menu');

// --- MODE SWITCHER INITIALIZATION ---
const modeDropdown = document.getElementById('modeDropdown');
const modeSelected = document.getElementById('modeSelected');
const modeOptions = document.getElementById('modeOptions');

// Restore persisted agent selection, or default to first active agent
const _savedState = vscode.getState() || {};
let activeAgentId = _savedState.activeAgentId || 'default';

function persistAgentSelection() {
    vscode.setState({ ...(vscode.getState() || {}), activeAgentId });
}

function renderAgentDropdown(agents) {
    if (!modeDropdown || !modeOptions) { return; }
    // Remove all dynamically added agent options (keep the first "Chat" option)
    const existingAgentOpts = modeOptions.querySelectorAll('.mode-option:not([data-value="default"])');
    existingAgentOpts.forEach(opt => opt.remove());

    (agents || []).forEach(agent => {
        if (!agent.isActive) { return; }
        const opt = document.createElement('div');
        opt.className = 'mode-option';
        opt.dataset.value = agent.id;
        const agentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
        opt.innerHTML = `<span class="mode-icon">${agentIcon}</span> ${escapeHtml(agent.name)}`;
        modeOptions.appendChild(opt);
    });
}

// Initial render — auto-select first active agent if no saved/explicit selection
renderAgentDropdown(AGENTS);
if (activeAgentId === 'default' && AGENTS && AGENTS.length > 0) {
    const firstActive = AGENTS.find(a => a.isActive);
    if (firstActive) {
        activeAgentId = firstActive.id;
        persistAgentSelection();
    }
}

function updateActiveAgentUI(agentId, agentsList) {
    activeAgentId = agentId || 'default';

    const chatIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
    const agentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
    const arrowIcon = `<svg class="dropdown-arrow" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>`;

    if (activeAgentId === 'default') {
        if (modeSelected) {
            modeSelected.innerHTML = `<span class="mode-icon">${chatIcon}</span> Chat ${arrowIcon}`;
        }
    } else {
        const agents = agentsList || (window.VS_CONSTANTS ? window.VS_CONSTANTS.AGENTS : []);
        const agent = (agents || []).find(a => a.id === activeAgentId);
        if (agent && modeSelected) {
            modeSelected.innerHTML = `<span class="mode-icon">${agentIcon}</span> ${escapeHtml(agent.name)} ${arrowIcon}`;
        } else {
            // Fallback to default if agent not found
            activeAgentId = 'default';
            if (modeSelected) {
                modeSelected.innerHTML = `<span class="mode-icon">${chatIcon}</span> Chat ${arrowIcon}`;
            }
        }
    }

    // Update selected class in dropdown
    if (modeOptions) {
        modeOptions.querySelectorAll('.mode-option').forEach(o => {
            if (o.dataset.value === activeAgentId) {
                o.classList.add('selected');
            } else {
                o.classList.remove('selected');
            }
        });
    }
}

updateActiveAgentUI(activeAgentId, AGENTS);

// Dropdown Interactions
if (modeDropdown) {
    // Open/Close
    modeSelected.addEventListener('click', (e) => {
        e.stopPropagation();
        modeOptions.classList.toggle('hidden');
        modeDropdown.classList.toggle('open');
    });

    // Select Option
    modeOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.mode-option');
        if (!option) { return; }

        updateActiveAgentUI(option.dataset.value);
        persistAgentSelection();

        // Hide
        modeOptions.classList.add('hidden');
        modeDropdown.classList.remove('open');
    });

    // Close on outside click
    document.addEventListener('click', () => {
        if (modeOptions && !modeOptions.classList.contains('hidden')) {
            modeOptions.classList.add('hidden');
            modeDropdown.classList.remove('open');
        }
    });
}

// --- PREMIUM HEADER WIRING ---
function updateContextCountPill() {
    const pill = document.getElementById('count-context');
    if (!pill) return;

    const attachedCount = (attachedFiles ? attachedFiles.length : 0) + (attachedImages ? attachedImages.length : 0);
    const inlinePills = document.querySelectorAll('.inline-attachment-pill').length;
    pill.textContent = attachedCount + inlinePills;
}

// Observe context changes to update pill
const observer = new MutationObserver(() => updateContextCountPill());
const previewContainer = document.getElementById('attachments-preview-container');
const messageBox = document.getElementById('messageInput');

if (previewContainer) observer.observe(previewContainer, { childList: true });
if (messageBox) observer.observe(messageBox, { childList: true, subtree: true });

// Initial count
updateContextCountPill();

// --- TOOLBAR DROPDOWNS INITIALIZATION ---
let { MODELS, PERMISSIONS, UI } = window.VS_CONSTANTS || {};

let uiStyleNode = null;

function applyUISettings(uiData) {
    if (!uiData) return;

    if (!uiStyleNode) {
        uiStyleNode = document.createElement('style');
        document.head.appendChild(uiStyleNode);
    }

    let styleRules = uiData.customCss || '';

    uiStyleNode.innerHTML = styleRules;
}

if (UI) {
    applyUISettings(UI);
}

const toolbarModelBtn = document.getElementById('toolbar-model-btn');
const modelOptionsMenu = document.getElementById('model-options-menu');
const currentModelLabel = document.getElementById('current-model-label');

const toolbarPermsBtn = document.getElementById('toolbar-perms-btn');
const permsOptionsMenu = document.getElementById('perms-options-menu');

const tbReadPerm = document.getElementById('tb-read-perm');
const tbWritePerm = document.getElementById('tb-write-perm');
const tbCmdPerm = document.getElementById('tb-cmd-perm');
const tbAlwaysProceed = document.getElementById('tb-always-proceed');

function initModelDropdown() {
    if (!MODELS || !currentModelLabel || !modelOptionsMenu) return;

    modelOptionsMenu.innerHTML = ''; // clear previous options

    const providerSettings = MODELS.providerSettings?.[MODELS.provider] || {};
    let initialModel = providerSettings.textModel || MODELS.textModel;

    const customModels = window.VS_CONSTANTS.CUSTOM_MODELS || [];
    const inactiveModels = MODELS.inactiveModels || [];

    let availableModels = []; // Array of { name, provider }
    let isValidModel = false;

    // Add built-in models from all providers
    const availableProviders = window.VS_CONSTANTS.AVAILABLE_MODELS || {};
    for (const [prov, data] of Object.entries(availableProviders)) {
        if (data && data.models && data.models.text) {
            data.models.text.forEach(m => {
                if (!inactiveModels.includes(m)) {
                    availableModels.push({ name: m, provider: prov });
                }
            });
        }
    }

    // Add active custom models
    customModels.forEach(cm => {
        if (cm.isActive !== false) {
            if (!availableModels.find(m => m.name === cm.name)) {
                availableModels.push({ name: cm.name, provider: cm.provider, alias: cm.alias });
            }
        }
    });

    let activeDisplayName = initialModel;

    availableModels.forEach(modelObj => {
        const m = modelObj.name;
        const displayName = modelObj.alias || m;

        // Ensure initialModel is valid
        if (m === initialModel) {
            isValidModel = true;
            activeDisplayName = displayName;
        }

        const btn = document.createElement('button');
        btn.className = 'context-item';
        btn.innerHTML = `<span>${displayName}</span>`;
        btn.addEventListener('click', () => {
            currentModelLabel.textContent = displayName;

            // Update providerSettings
            MODELS.provider = modelObj.provider;
            MODELS.textModel = m;
            const pSettings = MODELS.providerSettings || {};
            if (!pSettings[modelObj.provider]) pSettings[modelObj.provider] = {};
            pSettings[modelObj.provider].textModel = m;

            sendMessage('updateCategorySettings', {
                category: 'models',
                settings: {
                    provider: modelObj.provider,
                    textModel: m,
                    providerSettings: pSettings
                }
            });

            modelOptionsMenu.classList.add('hidden');
        });
        modelOptionsMenu.appendChild(btn);
    });

    if (!isValidModel && availableModels.length > 0) {
        initialModel = availableModels[0].name;
        activeDisplayName = availableModels[0].alias || initialModel;
        MODELS.provider = availableModels[0].provider;
        const pSettings = MODELS.providerSettings || {};
        if (!pSettings[MODELS.provider]) pSettings[MODELS.provider] = {};
        pSettings[MODELS.provider].textModel = initialModel;

        sendMessage('updateCategorySettings', {
            category: 'models',
            settings: {
                provider: MODELS.provider,
                textModel: initialModel,
                providerSettings: pSettings
            }
        });
    }
    currentModelLabel.textContent = activeDisplayName || 'Unknown';
}

if (MODELS && currentModelLabel && modelOptionsMenu) {
    initModelDropdown();

    toolbarModelBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        // Request fresh model data from backend every time the dropdown is opened
        sendMessage('requestModels', {});

        modelOptionsMenu.classList.toggle('hidden');
        if (permsOptionsMenu) permsOptionsMenu.classList.add('hidden');
        contextMenu.classList.add('hidden');
    });
}

if (PERMISSIONS && toolbarPermsBtn && permsOptionsMenu) {
    // Initialize Always Proceed toggle
    const isAlwaysProceed = PERMISSIONS.alwaysProceed === true;
    if (tbAlwaysProceed) {
        tbAlwaysProceed.checked = isAlwaysProceed;
    }

    // Apply initial state
    function applyAlwaysProceedState(enabled) {
        tbReadPerm.value = enabled ? 'auto' : (PERMISSIONS.readFilesConfirmation ? 'ask' : 'auto');
        tbWritePerm.value = enabled ? 'auto' : (PERMISSIONS.writeFilesConfirmation ? 'ask' : 'auto');
        tbCmdPerm.value = enabled ? 'auto' : ((PERMISSIONS.commandSafetyMode && PERMISSIONS.commandSafetyMode !== 'none') ? 'ask' : 'auto');
        tbReadPerm.disabled = enabled;
        tbWritePerm.disabled = enabled;
        tbCmdPerm.disabled = enabled;
        if (enabled) {
            tbReadPerm.style.opacity = '0.4';
            tbWritePerm.style.opacity = '0.4';
            tbCmdPerm.style.opacity = '0.4';
        } else {
            tbReadPerm.style.opacity = '1';
            tbWritePerm.style.opacity = '1';
            tbCmdPerm.style.opacity = '1';
        }
    }
    applyAlwaysProceedState(isAlwaysProceed);

    if (tbAlwaysProceed) {
        tbAlwaysProceed.addEventListener('change', (e) => {
            const on = e.target.checked;
            sendMessage('updateNestedSetting', { category: 'permissions', key: 'alwaysProceed', value: on });
            if (on) {
                sendMessage('updateNestedSetting', { category: 'permissions', key: 'readFilesConfirmation', value: false });
                sendMessage('updateNestedSetting', { category: 'permissions', key: 'writeFilesConfirmation', value: false });
                sendMessage('updateNestedSetting', { category: 'permissions', key: 'commandSafetyMode', value: 'none' });
            }
            applyAlwaysProceedState(on);
        });
    }

    tbWritePerm.addEventListener('change', (e) => {
        const isAuto = e.target.value === 'auto';
        sendMessage('updateNestedSetting', { category: 'permissions', key: 'writeFilesConfirmation', value: !isAuto });
        // If file writing and edits is enabled (auto mode), auto file reading is enabled
        if (isAuto) {
            tbReadPerm.value = 'auto';
            sendMessage('updateNestedSetting', { category: 'permissions', key: 'readFilesConfirmation', value: false });
        }
    });

    tbReadPerm.addEventListener('change', (e) => {
        const isAuto = e.target.value === 'auto';
        sendMessage('updateNestedSetting', { category: 'permissions', key: 'readFilesConfirmation', value: !isAuto });
    });

    tbCmdPerm.addEventListener('change', (e) => {
        const isAuto = e.target.value === 'auto';
        sendMessage('updateNestedSetting', { category: 'permissions', key: 'commandSafetyMode', value: isAuto ? 'none' : 'smart' });
    });

    toolbarPermsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        permsOptionsMenu.classList.toggle('hidden');
        if (modelOptionsMenu) modelOptionsMenu.classList.add('hidden');
        contextMenu.classList.add('hidden');
    });
}

document.addEventListener('click', (e) => {
    if (modelOptionsMenu && !modelOptionsMenu.contains(e.target) && !toolbarModelBtn.contains(e.target)) {
        modelOptionsMenu.classList.add('hidden');
    }
    if (permsOptionsMenu && !permsOptionsMenu.contains(e.target) && !toolbarPermsBtn.contains(e.target)) {
        permsOptionsMenu.classList.add('hidden');
    }
});
let autocompleteActive = false;
let autocompleteType = null; // '@' or '/'
let selectedIndex = 0;
let filteredItems = [];
let triggerQuery = '';

// --- HELPER FUNCTIONS ---

function updateAutocompleteItems(text) {
    const query = text.toLowerCase();

    if (autocompleteType === '@') {
        // Always filter commands first (e.g. @workspace, @problems, @selection, @terminal)
        const matchedCommands = COMMANDS.filter(item =>
            item.label.toLowerCase().includes(query)
        );

        if (query.length > 0) {
            // Also request files from backend dynamically
            vscode.postMessage({
                command: 'searchWorkspaceFiles',
                data: { query: text }
            });
        }

        // Show matched commands immediately (file results will merge in via searchFilesResult)
        filteredItems = query.length === 0 ? COMMANDS : matchedCommands;
    } else {
        filteredItems = WORKFLOWS.filter(item =>
            item.label.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query)
        );
    }

    if (filteredItems.length === 0 && autocompleteType !== '@') {
        // Don't hide for @ — file results may arrive async
        hideAutocomplete();
        return;
    }

    if (filteredItems.length > 0) {
        selectedIndex = Math.min(selectedIndex, filteredItems.length - 1);
        renderAutocomplete();
    }
}

function renderAutocomplete() {
    autocompleteMenu.innerHTML = '';

    // Add hint row when showing @ commands (not file search results)
    if (autocompleteType === '@' && filteredItems.length > 0 && filteredItems[0].label) {
        const isFileSearch = filteredItems[0].path;
        const hintEl = document.createElement('div');
        hintEl.className = 'autocomplete-hint';
        hintEl.textContent = isFileSearch ? 'FILES' : 'Type a filename to search...';
        autocompleteMenu.appendChild(hintEl);
    }

    filteredItems.forEach((item, index) => {
        const itemEl = document.createElement('div');
        itemEl.className = `autocomplete-item ${index === selectedIndex ? 'selected' : ''}`;

        // Determine icon based on label
        let iconSvg = '';
        if (item.path) {
            iconSvg = '<svg class="ac-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>';
        } else if (item.label === '@workspace') {
            iconSvg = '<svg class="ac-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>';
        } else if (item.label === '@problems') {
            iconSvg = '<svg class="ac-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z M12 15.75h.007v.008H12v-.008z" /></svg>';
        } else if (item.label === '@selection') {
            iconSvg = '<svg class="ac-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" /></svg>';
        } else if (item.label === '@terminal') {
            iconSvg = '<svg class="ac-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
        } else {
            iconSvg = '<svg class="ac-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';
        }

        itemEl.innerHTML = `
            ${iconSvg}
            <span class="autocomplete-label">${escapeHtml(item.label)}</span>
            <span class="autocomplete-description">${escapeHtml(item.description)}</span>
        `;
        itemEl.addEventListener('click', () => {
            selectedIndex = index;
            confirmAutocompleteSelection();
        });
        autocompleteMenu.appendChild(itemEl);
    });

    autocompleteMenu.classList.remove('hidden');
    autocompleteActive = true;

    // Ensure selected item is visible if scrolling is needed
    const selectedEl = autocompleteMenu.querySelector('.autocomplete-item.selected');
    if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
    }
}

function hideAutocomplete() {
    autocompleteMenu.classList.add('hidden');
    autocompleteMenu.innerHTML = '';
    autocompleteActive = false;
    autocompleteType = null;
    triggerQuery = '';
    selectedIndex = 0;
}

function confirmAutocompleteSelection() {
    const item = filteredItems[selectedIndex];
    if (!item) { return; }

    const text = chatMessage.innerText;
    const cursorPosition = getCaretPosition(chatMessage);

    // Find the trigger position (backwards from cursor)
    const textBeforeCursor = text.substring(0, cursorPosition);
    const triggerIndex = textBeforeCursor.lastIndexOf(autocompleteType);

    if (triggerIndex !== -1) {
        // Safe removal of trigger token without destroying other HTML elements (pills)
        const deleteLength = 1 + (triggerQuery ? triggerQuery.length : 0);
        const selection = window.getSelection();
        let deleted = false;
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset >= deleteLength) {
                const startOffset = range.startOffset - deleteLength;
                range.setStart(range.startContainer, startOffset);
                range.deleteContents();
                deleted = true;
            } else {
                // Fallback: use execCommand delete
                for (let i = 0; i < deleteLength; i++) {
                    document.execCommand('delete', false, null);
                }
                deleted = true;
            }
        }
        // Final fallback: scan text nodes for orphaned trigger char
        if (!deleted) {
            const walker = document.createTreeWalker(chatMessage, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                const idx = node.textContent.lastIndexOf(autocompleteType);
                if (idx !== -1) {
                    node.textContent = node.textContent.substring(0, idx) + node.textContent.substring(idx + deleteLength);
                    break;
                }
            }
        }

        if (item.label === '@workspace') {
            sendMessage(CHAT_COMMANDS.ADD_CONTEXT, { type: 'workspace' });
        } else if (item.label === '@problems') {
            sendMessage(CHAT_COMMANDS.ADD_CONTEXT, { type: 'problems' });
        } else if (item.label === '@selection') {
            sendMessage(CHAT_COMMANDS.ADD_CONTEXT, { type: 'selection' });
        } else if (item.label === '@terminal') {
            sendMessage(CHAT_COMMANDS.ADD_CONTEXT, { type: 'terminal' });
        } else if (item.path) {
            // User selected a specific file from search results
            vscode.postMessage({
                command: 'addFileByPath',
                data: { path: item.path }
            });
        } else {
            // Normal insertion for workflows and other commands
            document.execCommand('insertHTML', false, item.label + '&nbsp;');
        }
    }

    hideAutocomplete();
}

/**
 * Gets the current caret position in a contenteditable element.
 */
function getCaretPosition(element) {
    let position = 0;
    const isSupported = typeof window.getSelection !== "undefined";
    if (isSupported) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(element);
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            position = preCaretRange.toString().length;
        }
    }
    return position;
}

/**
 * Sets the caret position in a contenteditable element.
 */
function setCaretPosition(element, offset) {
    const range = document.createRange();
    const sel = window.getSelection();

    // This is a simplified version for plain text contenteditables
    let currentOffset = 0;
    let node = element.firstChild || element;

    // If no text node yet, we can't set offset
    if (node.nodeType !== 3) {
        element.focus();
        return;
    }

    range.setStart(node, Math.min(offset, node.textContent.length));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    element.focus();
}


// --- VIEW SWITCHING FUNCTIONS (Global) ---

/**
 * Hides the history view and shows the main chat view.
 */
function showChatView() {
    historyView.classList.remove('active-view');
    chatView.classList.add('active-view');
    chatMessage.focus(); // Focus the input
}


/**
 * Hides the chat view and shows the history view, populating it with data.
 * @param {Array<Object>} historyGroups - Data from the extension
 */
function showHistoryView(historyGroups) {
    historyListContainer.innerHTML = ''; // Clear old history


    try {
        if (!historyGroups || historyGroups.length === 0) {
            historyListContainer.innerHTML = '<div class="empty-message">No chat history found.</div>';
        } else {
            for (const group of historyGroups) {
                const groupEl = document.createElement('div');
                groupEl.className = 'history-group';
                const titleEl = document.createElement('h3');
                titleEl.className = 'history-group-title';
                titleEl.textContent = group.title;
                groupEl.appendChild(titleEl);

                for (const item of group.chats) {
                    const itemEl = document.createElement('div');
                    itemEl.className = 'history-item';
                    itemEl.dataset.chatId = item.id;
                    const safeTitle = escapeHtml(item.title || 'Untitled');
                    const msgCount = item.messageCount || '';
                    const countBadge = msgCount ? `<span class="history-item-count">${msgCount} msg${msgCount > 1 ? 's' : ''}</span>` : '';
                    itemEl.innerHTML = `
        <div class="history-info">
            <span class="history-item-title" title="${safeTitle}">${safeTitle}</span>
            <div class="history-item-meta">
                <span class="history-item-time">${item.time}</span>
                ${countBadge}
            </div>
        </div>
        <button class="delete-item-btn" title="Delete conversation">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      `;
                    groupEl.appendChild(itemEl);
                }
                historyListContainer.appendChild(groupEl);
            }
        }
    } catch (error) {
        console.error('Error rendering chat history:', error);
        historyListContainer.innerHTML = '<div class="empty-message">Error loading chat history.</div>';
    }
    // Show the view
    chatView.classList.remove('active-view');
    historyView.classList.add('active-view');
}
// --- END VIEW SWITCHING ---

// ─── #48: AGENT QUESTION STICKY BANNER ─────────────────────────────
const questionBanner = document.getElementById('agent-question-banner');
const questionText = document.getElementById('agent-question-text');
const dismissQuestionBtn = document.getElementById('dismiss-question-btn');

function showQuestionBanner(agentName) {
    if (!questionBanner) return;
    const name = agentName || 'Agent';
    questionText.textContent = `${name} is asking a question — answer to proceed`;
    questionBanner.classList.remove('hidden');
}

function hideQuestionBanner() {
    if (!questionBanner) return;
    questionBanner.classList.add('hidden');
}

/**
 * Heuristic: check if the AI's last response ends with a question.
 * Looks at the last 200 chars of the accumulated response.
 */
function detectsQuestion(text) {
    if (!text || text.length < 5) return false;
    const tail = text.trim().slice(-200);
    // Check if it ends with a question mark (ignore trailing whitespace/markdown)
    const cleaned = tail.replace(/[\s*_`#>]+$/, '');
    return cleaned.endsWith('?');
}

if (dismissQuestionBtn) {
    dismissQuestionBtn.addEventListener('click', hideQuestionBanner);
}


let isGenerating = false;

function toggleSendButton(mode = "off") {
    if (mode === "disabled") {
        sendButton.classList.add("disabled");
        sendButton.classList.remove("generating");
        sendButton.title = "Send";
        sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
  <path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
</svg>`;
    } else if (mode === "generating") {
        sendButton.classList.remove("disabled");
        sendButton.classList.add("generating");
        sendButton.title = "Stop Request";
        sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
  <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z" />
</svg>`;
    } else {
        sendButton.classList.remove("disabled");
        sendButton.classList.remove("generating");
        sendButton.title = "Send";
        sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
  <path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
</svg>`;
    }
}


function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getCurrentDate() {
    const now = new Date();
    const options = {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    };
    return now.toLocaleString('en-US', options);
}

