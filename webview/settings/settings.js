import { ProviderRegistry } from './providers/index.js';

/**
 * Settings webview controller logic for real-time keybinding and agent configs.
 */
const vscode = acquireVsCodeApi();

// --- STATE ---
let currentSettings = {
    general: { aggressiveAgentic: false, systemPrompt: '', contextMode: 'compact' },
    models: {
        textModel: 'gpt-4o', imageModel: 'gpt-4o-mini', baseUrl: '', apiKey: '', provider: 'OpenAI',
        providerSettings: {}
    },
    prompts: [],
    permissions: {
        readFilesConfirmation: false,
        writeFilesConfirmation: true,
        commandSafetyMode: 'smart',
        alwaysProceed: false,
        enableTerminalSandbox: false,
        newChatSessionPlacement: 'window'
    },
    ui: {
        fontFamily: '',
        fontSize: '',
        themeColor: 'adaptive',
        customCss: '',
        lastCustomCss: '' // Track the actual custom CSS separately from template selection
    },
    customTemplates: [] // Array of { id: string, name: string, css: string } for user-created templates
};

// Default lists to show before fetching
// Models injected from backend
let DEFAULT_MODELS = window.VS_MODELS || {
};

// --- DOM ELEMENTS ---
const tabs = document.querySelectorAll('.nav-item');
const contents = document.querySelectorAll('.tab-view');
const saveBtn = document.getElementById('saveBtn');
const addPromptBtn = document.getElementById('addPromptBtn');
const promptsList = document.getElementById('promptsList');

// Modal Elements
const customModal = document.getElementById('customModal');
const modalTitle = document.getElementById('modalTitle');
const modalText = document.getElementById('modalText');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
let modalResolver = null;

// --- MODAL CONTROLLER ---
function showModal(title, text, showInput = false, isAlert = false) {
    return new Promise((resolve) => {
        if (!customModal) {
            resolve(false);
            return;
        }

        modalTitle.textContent = title;
        
        if (showInput) {
            modalText.innerHTML = `<p>${text}</p><input type="text" id="modalInput" class="modal-input" placeholder="Template name" style="width: 100%; margin-top: 12px; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--input-bg); color: var(--input-fg);">`;
        } else {
            modalText.textContent = text;
        }

        // Configure buttons based on type
        if (isAlert) {
            modalCancelBtn.style.display = 'none';
            modalConfirmBtn.textContent = 'OK';
        } else {
            modalCancelBtn.style.display = 'inline-block';
            modalConfirmBtn.textContent = 'Confirm';
        }
        
        customModal.classList.remove('hidden');

        const onConfirm = () => {
            // Hide modal and remove listeners immediately
            customModal.classList.add('hidden');
            modalConfirmBtn.removeEventListener('click', onConfirm);
            modalCancelBtn.removeEventListener('click', onCancel);
            
            let result;
            if (showInput) {
                const input = document.getElementById('modalInput');
                result = input ? input.value : '';
            } else {
                result = true;
            }

            // Resolve and then refresh UI/Persist if needed (logic handled by caller)
            resolve(result);
        };
        
        const onCancel = () => {
            // Hide modal and remove listeners immediately
            customModal.classList.add('hidden');
            modalConfirmBtn.removeEventListener('click', onConfirm);
            modalCancelBtn.removeEventListener('click', onCancel);
            
            let result;
            if (showInput) {
                result = '';
            } else {
                result = false;
            }
            resolve(result);
        };

        modalConfirmBtn.addEventListener('click', onConfirm);
        modalCancelBtn.addEventListener('click', onCancel);
        
        // Focus input if shown
        if (showInput) {
            setTimeout(() => {
                const input = document.getElementById('modalInput');
                if (input) input.focus();
            }, 100);
        }
    });
}

// Inputs
const providerSelect = document.getElementById('providerSelect');
const apiKeyInput = document.getElementById('apiKeyInput');
const baseUrlInput = document.getElementById('baseUrlInput');
const textModelInput = document.getElementById('textModelInput');
const imageModelInput = document.getElementById('imageModelInput');

const aggressiveAgenticInput = document.getElementById('aggressiveAgentic');
const customCssInput = document.getElementById('customCssInput');
const resetCssBtn = document.getElementById('resetCssBtn');
const themeTemplateSelect = document.getElementById('themeTemplateSelect');
const showKeyToggleBtn = document.getElementById('showKeyToggleBtn');
const saveTemplateBtn = document.getElementById('saveTemplateBtn');
const deleteTemplateBtn = document.getElementById('deleteTemplateBtn');
const commandSafetyMode = document.getElementById('commandSafetyMode');
const allowExternalMediaToggle = document.getElementById('allowExternalMedia');
const contextModeToggle = document.getElementById('contextModeToggle');
const enableTerminalSandboxToggle = document.getElementById('enableTerminalSandbox');
const enableSuggestionsToggle = document.getElementById('enableSuggestions');
const newChatSessionPlacementInput = document.getElementById('newChatSessionPlacement');
let isKeyVisible = false;

// External media toggle handler
if (allowExternalMediaToggle) {
    allowExternalMediaToggle.addEventListener('change', (e) => {
        if (!currentSettings.ui) currentSettings.ui = {};
        currentSettings.ui.allowExternalMedia = e.target.checked;
        
        persistSettings();
        
        vscode.postMessage({
            command: 'saveSetting',
            data: { category: 'ui', key: 'allowExternalMedia', value: e.target.checked }
        });
    });
}

if (commandSafetyMode) {
    commandSafetyMode.addEventListener('change', (e) => {
        if (!currentSettings.permissions) currentSettings.permissions = {};
        currentSettings.permissions.commandSafetyMode = e.target.value;
        persistSettings();
        
        vscode.postMessage({
            command: 'saveSetting',
            data: { category: 'permissions', key: 'commandSafetyMode', value: e.target.value }
        });
    });
}

if (newChatSessionPlacementInput) {
    newChatSessionPlacementInput.addEventListener('change', (e) => {
        if (!currentSettings.permissions) currentSettings.permissions = {};
        currentSettings.permissions.newChatSessionPlacement = e.target.value;
        persistSettings();
        
        vscode.postMessage({
            command: 'saveSetting',
            data: { category: 'permissions', key: 'newChatSessionPlacement', value: e.target.value }
        });
    });
}

if (enableTerminalSandboxToggle) {
    enableTerminalSandboxToggle.addEventListener('change', (e) => {
        if (!currentSettings.permissions) currentSettings.permissions = {};
        currentSettings.permissions.enableTerminalSandbox = e.target.checked;
        persistSettings();
        
        vscode.postMessage({
            command: 'saveSetting',
            data: { category: 'permissions', key: 'enableTerminalSandbox', value: e.target.checked }
        });
    });
}



if (enableSuggestionsToggle) {
    enableSuggestionsToggle.addEventListener('change', (e) => {
        if (!currentSettings.general) currentSettings.general = {};
        currentSettings.general.enableSuggestions = e.target.checked;
        persistSettings();
        
        vscode.postMessage({
            command: 'saveSetting',
            data: { category: 'general', key: 'enableSuggestions', value: e.target.checked }
        });
    });
}


const disableSslToggle = document.getElementById('disableSslVerification');
if (disableSslToggle) {
    disableSslToggle.addEventListener('change', (e) => {
        vscode.postMessage({
            command: 'updateVsCodeSetting',
            data: { key: 'disableSslVerification', value: e.target.checked }
        });
    });
}

// Agent Hub summary (optional, safe if missing)
const agentCountValue = document.getElementById('agentCountValue');
const activeAgentCountValue = document.getElementById('activeAgentCountValue');

// --- THEME TEMPLATES ---
const THEME_TEMPLATES = {
    default: `/* ─── Default — Clean & Minimal ─── */

/* Typography */
body {
    font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, sans-serif) !important;
    -webkit-font-smoothing: antialiased;
}

#messageInput, code, .textarea {
    font-family: var(--font-editor, monospace) !important;
    font-size: 0.92rem !important;
    line-height: 1.6 !important;
}

/* Bubble */
.message-body {
    border-radius: 12px !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1) !important;
}
`,
    futuristic: `/* ─── Futuristic — Neon & Glassmorphism ─── */

:root {
    --app-bg: #0a0a1a !important;
    --chat-bg: #070714 !important;
    --text-color: #e0e8ff !important;
    --border-color: rgba(0, 242, 254, 0.15) !important;
    --input-bg: rgba(15, 15, 40, 0.8) !important;
    --input-fg: #c8d6ff !important;
    --input-focus-border: #00f2fe !important;
    --user-msg-bg: rgba(79, 172, 254, 0.08) !important;
    --code-bg: rgba(0, 242, 254, 0.05) !important;

    /* Settings & Hub Sync */
    --accent-color: #00f2fe !important;
    --accent-glow: rgba(0, 242, 254, 0.3) !important;
    --accent-gradient: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%) !important;
    --sidebar-bg: #070714 !important;
    --panel-bg: rgba(10, 10, 30, 0.6) !important;
    --panel-border: rgba(0, 242, 254, 0.12) !important;
    --bg-base: #0a0a1a !important;
}

body {
    font-family: 'Inter', 'SF Mono', system-ui, sans-serif !important;
    background: linear-gradient(145deg, #0a0a1a 0%, #0d0d2b 50%, #0a0a1a 100%) !important;
}

.message-body {
    border: 1px solid rgba(0, 242, 254, 0.12) !important;
    border-radius: 16px !important;
    box-shadow: 0 0 20px rgba(0, 242, 254, 0.04), 0 8px 32px rgba(0, 0, 0, 0.3) !important;
    backdrop-filter: blur(12px) !important;
    background: rgba(10, 10, 30, 0.6) !important;
}

.unified-input-container {
    border: 1px solid rgba(0, 242, 254, 0.15) !important;
    box-shadow: 0 0 30px rgba(0, 242, 254, 0.05) !important;
    background: rgba(10, 10, 30, 0.7) !important;
    backdrop-filter: blur(16px) !important;
}

.send-btn-premium {
    background: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%) !important;
    box-shadow: 0 0 15px rgba(0, 242, 254, 0.3) !important;
}

code {
    color: #00f2fe !important;
}
`,
    retro: `/* ─── Retro — Warm Amber & CRT ─── */

:root {
    --app-bg: #1a1207 !important;
    --chat-bg: #15100a !important;
    --text-color: #d4a574 !important;
    --border-color: rgba(212, 165, 116, 0.2) !important;
    --input-bg: rgba(26, 18, 7, 0.9) !important;
    --input-fg: #c89b6b !important;
    --input-focus-border: #e8a84c !important;
    --user-msg-bg: rgba(232, 168, 76, 0.08) !important;
    --code-bg: rgba(232, 168, 76, 0.06) !important;

    /* Settings & Hub Sync */
    --accent-color: #e8a84c !important;
    --accent-glow: rgba(232, 168, 76, 0.3) !important;
    --accent-gradient: linear-gradient(135deg, #e8a84c 0%, #d4a574 100%) !important;
    --sidebar-bg: #15100a !important;
    --panel-bg: rgba(26, 18, 7, 0.8) !important;
    --panel-border: rgba(212, 165, 116, 0.2) !important;
    --bg-base: #1a1207 !important;
}

body {
    font-family: 'Courier New', 'Liberation Mono', monospace !important;
    background: #1a1207 !important;
    text-shadow: 0 0 2px rgba(212, 165, 116, 0.15) !important;
}

.message-body {
    border: 1px solid rgba(212, 165, 116, 0.2) !important;
    border-radius: 2px !important;
    box-shadow: none !important;
    background: rgba(26, 18, 7, 0.8) !important;
}

.unified-input-container {
    border: 1px solid rgba(212, 165, 116, 0.25) !important;
    border-radius: 2px !important;
    background: rgba(26, 18, 7, 0.9) !important;
}

.send-btn-premium {
    background: linear-gradient(135deg, #e8a84c 0%, #d4a574 100%) !important;
    border-radius: 2px !important;
}

code {
    color: #e8a84c !important;
    font-family: 'Courier New', monospace !important;
}
`,
    classic: `/* ─── Classic — Elegant & Refined ─── */

:root {
    --app-bg: #1c1c20 !important;
    --chat-bg: #18181c !important;
    --text-color: #c8c4bc !important;
    --border-color: rgba(180, 170, 155, 0.15) !important;
    --input-bg: rgba(28, 28, 32, 0.9) !important;
    --input-fg: #b8b0a4 !important;
    --input-focus-border: #8b7e6a !important;
    --user-msg-bg: rgba(139, 126, 106, 0.08) !important;
    --code-bg: rgba(139, 126, 106, 0.06) !important;

    /* Settings & Hub Sync */
    --accent-color: #8b7e6a !important;
    --accent-glow: rgba(139, 126, 106, 0.3) !important;
    --accent-gradient: linear-gradient(135deg, #8b7e6a 0%, #a09080 100%) !important;
    --sidebar-bg: #18181c !important;
    --panel-bg: rgba(28, 28, 32, 0.7) !important;
    --panel-border: rgba(180, 170, 155, 0.12) !important;
    --bg-base: #1c1c20 !important;
}

body {
    font-family: 'Georgia', 'Palatino Linotype', 'Book Antiqua', serif !important;
    letter-spacing: 0.01em !important;
    background: #1c1c20 !important;
}

.message-body {
    border: 1px solid rgba(180, 170, 155, 0.12) !important;
    border-radius: 8px !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2) !important;
    background: rgba(28, 28, 32, 0.7) !important;
}

.unified-input-container {
    border: 1px solid rgba(180, 170, 155, 0.15) !important;
    border-radius: 8px !important;
    background: rgba(28, 28, 32, 0.8) !important;
}

.send-btn-premium {
    background: linear-gradient(135deg, #8b7e6a 0%, #a09080 100%) !important;
}

code {
    font-family: 'Menlo', 'Consolas', monospace !important;
}
`
};

// --- TEMPLATE HANDLER ---
if (themeTemplateSelect) {
    themeTemplateSelect.addEventListener('change', (e) => {
        const template = e.target.value;
        
        // Update delete button visibility
        updateDeleteButtonVisibility();

        if (template !== 'custom' && THEME_TEMPLATES[template]) {
            // Store current custom if we're moving AWAY from custom
            if (customCssInput && !Object.values(THEME_TEMPLATES).includes(customCssInput.value)) {
                currentSettings.ui.lastCustomCss = customCssInput.value;
            }
            customCssInput.value = THEME_TEMPLATES[template];
            currentSettings.ui.customCss = THEME_TEMPLATES[template];
        } else if (template === 'custom') {
            // Restore last known custom CSS
            customCssInput.value = currentSettings.ui.lastCustomCss || '';
            currentSettings.ui.customCss = customCssInput.value;
        } else if (template.startsWith('custom_')) {
            // Handle custom template selection
            const templateId = template.substring(7);
            const customTemplate = currentSettings.customTemplates.find(t => t.id === templateId);
            if (customTemplate) {
                if (customCssInput && !Object.values(THEME_TEMPLATES).includes(customCssInput.value)) {
                    currentSettings.ui.lastCustomCss = customCssInput.value;
                }
                customCssInput.value = customTemplate.css;
                currentSettings.ui.customCss = customTemplate.css;
            }
        }
        applyUISettings(currentSettings.ui);
    });
}

// --- CUSTOM TEMPLATE MANAGEMENT ---
function generateTemplateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function saveCurrentAsTemplate() {
    const css = customCssInput.value.trim();
    if (!css) {
        showModal('Empty CSS', 'Please enter some CSS code before saving it as a template.', false, true);
        return;
    }

    showModal('Save Custom Template', 'Enter a descriptive name for your template:', true).then(name => {
        if (name && name.trim()) {
            const templateName = name.trim();
            
            // Check if template with this name already exists
            const existingTemplate = currentSettings.customTemplates.find(t => t.name.toLowerCase() === templateName.toLowerCase());
            
            if (existingTemplate) {
                // Ask if user wants to overwrite with more informative message
                showModal('Overwrite Template?', `A template named "${templateName}" already exists.\n\nSelecting "Confirm" will replace the existing template's CSS with your current CSS. This action cannot be undone.`).then(overwrite => {
                    if (overwrite) {
                        existingTemplate.css = css;
                        updateTemplateDropdown();
                        persistSettings();
                        // Brief success modal that closes quickly
                        showModal('Success', `Template "${templateName}" has been updated.`, false, true);
                    }
                });
            } else {
                // Create new template
                const templateId = generateTemplateId();
                
                if (!currentSettings.customTemplates) {
                    currentSettings.customTemplates = [];
                }

                currentSettings.customTemplates.push({
                    id: templateId,
                    name: templateName,
                    css: css
                });
                
                updateTemplateDropdown();
                // Select the newly created template
                if (themeTemplateSelect) {
                    themeTemplateSelect.value = 'custom_' + templateId;
                    updateDeleteButtonVisibility();
                }
                persistSettings();
                showModal('Success', `Template "${templateName}" saved successfully.`, false, true);
            }
        }
    });
}

function updateTemplateDropdown() {
    if (!themeTemplateSelect) return;
    
    // Preserve current selection if possible
    const currentVal = themeTemplateSelect.value;
    
    // Remove existing custom template options
    const customOptions = themeTemplateSelect.querySelectorAll('option[value^="custom_"]');
    customOptions.forEach(option => option.remove());
    
    // Add custom templates
    if (currentSettings.customTemplates) {
        currentSettings.customTemplates.forEach(template => {
            const option = document.createElement('option');
            option.value = 'custom_' + template.id;
            option.textContent = `▸ ${template.name}`;
            themeTemplateSelect.appendChild(option);
        });
    }

    // Restore selection if it still exists, otherwise default to 'custom'
    const optionExists = Array.from(themeTemplateSelect.options).some(opt => opt.value === currentVal);
    if (optionExists) {
        themeTemplateSelect.value = currentVal;
    } else {
        themeTemplateSelect.value = 'custom';
    }
    
    // Always update button visibility after dropdown structure changes
    updateDeleteButtonVisibility();
}

function deleteCurrentTemplate() {
    const templateId = deleteTemplateBtn.dataset.templateId;
    if (!templateId) return;
    
    const template = currentSettings.customTemplates.find(t => t.id === templateId);
    if (!template) return;
    
    showModal('Delete Template?', `Are you sure you want to delete the template "${template.name}"?\n\nThis will permanently remove it from your collection.`).then(confirm => {
        if (confirm) {
            currentSettings.customTemplates = currentSettings.customTemplates.filter(t => t.id !== templateId);
            
            // Re-populate dropdown (this will also handle visibility via updateDeleteButtonVisibility)
            updateTemplateDropdown();
            
            persistSettings();
            showModal('Deleted', `Template "${template.name}" has been removed.`, false, true);
        }
    });
}

// Event listeners for template management
if (saveTemplateBtn) {
    saveTemplateBtn.addEventListener('click', saveCurrentAsTemplate);
}

if (deleteTemplateBtn) {
    deleteTemplateBtn.addEventListener('click', deleteCurrentTemplate);
}
// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
    // Request settings from extension
    vscode.postMessage({ command: 'requestSettings' });
    populateModelDropdowns(currentSettings.models.provider);
    
    // Initialize template dropdown
    if (themeTemplateSelect) {
        updateTemplateDropdown();
    }

    // Initialize tool status pills event listeners
    const toolGroups = ['sys_tools', 'web_tools', 'cognitive_tools', 'artifact_tools', 'browser_tools'];
    toolGroups.forEach(group => {
        const pill = document.getElementById(`btn-${group}`);
        if (pill) {
            pill.addEventListener('click', () => {
                cycleToolState(group);
            });
            pill.addEventListener('animationend', () => {
                pill.classList.remove('cycling');
            });
        }
    });
});

function cycleToolState(group) {
    if (!currentSettings.tools) {
        currentSettings.tools = {};
    }
    const currentVal = currentSettings.tools[group] || (
        group === 'sys_tools' ? 'ask' :
        group === 'browser_tools' ? 'ask' : 'always'
    );
    const states = ['always', 'ask', 'off'];
    const nextIndex = (states.indexOf(currentVal) + 1) % states.length;
    const nextVal = states[nextIndex];
    
    currentSettings.tools[group] = nextVal;
    updateToolPillDOM(group, nextVal);
    persistSettings();

    // Trigger micro-animation
    const pill = document.getElementById(`btn-${group}`);
    if (pill) {
        pill.classList.remove('cycling');
        void pill.offsetWidth; // trigger reflow
        pill.classList.add('cycling');
    }
}

function updateToolPillDOM(group, val) {
    const pill = document.getElementById(`btn-${group}`);
    if (!pill) return;
    
    pill.className = `tool-status-pill clickable state-${val}`;
    const labelMap = {
        always: 'Always Proceed',
        ask: 'Ask',
        off: 'Off'
    };
    pill.querySelector('.status-label').textContent = labelMap[val] || val;
}

// Listener for Provider Change (Switching contexts)
providerSelect.addEventListener('change', (e) => {
    const newProvider = e.target.value;

    // 2. Update current active provider
    currentSettings.models.provider = newProvider;

    // Ensure providerSettings exists
    if (!currentSettings.models.providerSettings) {
        currentSettings.models.providerSettings = {};
    }

    // 3. Load values for new Provider
    const providerInstance = ProviderRegistry.get(newProvider);
    const providerDefaults = providerInstance.getDefaults();

    let defaults = currentSettings.models.providerSettings[newProvider] || { ...providerDefaults };

    // PRESET BASE URL if empty
    if (!defaults.baseUrl && (!defaults.apiKey || defaults.apiKey === '')) {
        defaults.baseUrl = providerDefaults.baseUrl;
    }

    // Determine target values
    const defaultText = providerDefaults.textModel;
    const defaultImage = providerDefaults.imageModel;

    const targetText = defaults.textModel || defaultText;
    const targetImage = defaults.imageModel || defaultImage;

    // Repopulate Dropdowns (Pass target values to ensure they are added if missing)
    populateModelDropdowns(newProvider, targetText, targetImage);

    // Update inputs
    apiKeyInput.value = defaults.apiKey || '';
    baseUrlInput.value = defaults.baseUrl || '';
    textModelInput.value = targetText;
    imageModelInput.value = targetImage;

    // Update active state
    currentSettings.models.apiKey = defaults.apiKey;
    currentSettings.models.baseUrl = defaults.baseUrl;
    currentSettings.models.imageModel = imageModelInput.value;
    persistSettings();
});

// Real-time updates for Model Inputs to persist to providerSettings
// Note: imageModelInput is handled separately below (it's a global setting, not per-provider)
const providerModelInputs = [apiKeyInput, baseUrlInput, textModelInput];
providerModelInputs.forEach(input => {
    input.addEventListener('input', () => {
        const provider = currentSettings.models.provider;

        // Ensure structure
        if (!currentSettings.models.providerSettings) {
             currentSettings.models.providerSettings = {};
        }
        if (!currentSettings.models.providerSettings[provider]) {
            currentSettings.models.providerSettings[provider] = {};
        }

        // Update specific field
        if (input === apiKeyInput) { currentSettings.models.providerSettings[provider].apiKey = input.value; }
        if (input === baseUrlInput) { currentSettings.models.providerSettings[provider].baseUrl = input.value; }
        if (input === textModelInput) {
            currentSettings.models.providerSettings[provider].textModel = input.value;
        }

        // Also update the top-level active key for backward compatibility/immediate use
        if (input === apiKeyInput) { currentSettings.models.apiKey = input.value; }
        if (input === baseUrlInput) { currentSettings.models.baseUrl = input.value; }
        if (input === textModelInput) {
            currentSettings.models.textModel = input.value;
        }
        persistSettings();
    });
});

// We will handle the fallback image model via the inline checkboxes

// --- EVENT LISTENERS ---

// Tab Switching
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
    });
});

// (Temperature slider removed — #49)

// Toggle API Key Visibility
if (showKeyToggleBtn) {
    showKeyToggleBtn.addEventListener('click', () => {
        isKeyVisible = !isKeyVisible;
        apiKeyInput.setAttribute('type', isKeyVisible ? 'text' : 'password');
        showKeyToggleBtn.style.opacity = isKeyVisible ? '1' : '0.5';
    });
}



if (resetCssBtn) {
    resetCssBtn.addEventListener('click', () => {
        const defaultCss = THEME_TEMPLATES.default;
        if (customCssInput) {
            customCssInput.value = defaultCss;
            currentSettings.ui.customCss = defaultCss;
            if (themeTemplateSelect) {
                themeTemplateSelect.value = 'default';
                updateDeleteButtonVisibility();
            }
            persistSettings();
            showModal('Reset Successful', 'CSS has been reset to the default theme.', false, true);
        }
    });
}

// #67: Generate Theme Button
const generateThemeBtn = document.getElementById('generateThemeBtn');
const themePromptInput = document.getElementById('themePromptInput');
let _genTimeout = null; // safety timeout to reset button
let _genActive = false; // track if generation is active or timed out

if (generateThemeBtn && themePromptInput) {
    generateThemeBtn.addEventListener('click', () => {
        const prompt = themePromptInput.value.trim();
        if (!prompt) {
            showModal('Empty Prompt', 'Please describe the theme you want to generate.', false, true);
            return;
        }
        generateThemeBtn.disabled = true;
        _genActive = true;
        generateThemeBtn.innerHTML = '<span class="status-spinner" style="width:12px;height:12px;border-width:2px;"></span> Generating (up to 2m)...';
        vscode.postMessage({ command: 'generateTheme', data: { prompt } });

        // Safety timeout: auto-reset after 120s if no response
        clearTimeout(_genTimeout);
        _genTimeout = setTimeout(() => {
            if (generateThemeBtn.disabled) {
                _genActive = false;
                generateThemeBtn.disabled = false;
                generateThemeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg> Generate';
                showModal('Generation Timeout', 'Theme generation took too long. Please try again.', false, true);
            }
        }, 120000);
    });

    themePromptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { generateThemeBtn.click(); }
    });
}

// Auto-Save listeners
document.body.addEventListener('change', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        debouncedPersist(300);
    }
});

document.body.addEventListener('input', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        debouncedPersist(300);
    }
});

function persistSettings() {
    collectSettings();
    vscode.postMessage({
        command: 'saveSettings',
        settings: currentSettings
    });
    applyUISettings(currentSettings.ui);
}

// Debounced version — use for text input fields to avoid flicker
let _persistTimer = null;
function debouncedPersist(delay = 800) {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
        persistSettings();
    }, delay);
}

// Add Prompt Button (now lives in Agent Hub — guard for backward compat)
if (addPromptBtn) {
  addPromptBtn.addEventListener('click', () => {
    const newId = Date.now().toString();
    currentSettings.prompts.push({
        id: newId,
        name: 'New Agent',
        content: 'You are a helpful AI.',
        isActive: true,
        order: currentSettings.prompts.length + 1
    });
    renderPrompts();
  });
}

// Handle Messages from Extension
window.addEventListener('message', event => {
    const message = event.data;
    try {
        switch (message.command) {
            case 'loadSettings':
                if (!message.settings) {
                    throw new Error('Settings data is missing in loadSettings message');
                }
                currentSettings = message.settings;
                // Update available models from backend source of truth
                if (message.availableModels) {
                    DEFAULT_MODELS = message.availableModels;
                }

                // Ensure providerSettings exists in loaded data
                if (!currentSettings.models.providerSettings) {
                    currentSettings.models.providerSettings = {};
                }
                // First populate dropdowns based on the load
                populateModelDropdowns(currentSettings.models.provider, currentSettings.models.textModel, currentSettings.models.imageModel);
                updateTemplateDropdown();
                populateForm();
                renderPrompts();
                renderModelTable();
                break;

            // #67: AI-generated theme result
            case 'generateThemeResult': {
                clearTimeout(_genTimeout);
                if (!_genActive) return; // Ignore if we timed out
                _genActive = false;
                const genBtn = document.getElementById('generateThemeBtn');
                if (genBtn) {
                    genBtn.disabled = false;
                    genBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg> Generate';
                }
                if (message.success && message.css) {
                    if (customCssInput) {
                        customCssInput.value = message.css;
                        currentSettings.ui.customCss = message.css;
                        if (themeTemplateSelect) {
                            themeTemplateSelect.value = 'custom';
                            updateDeleteButtonVisibility();
                        }
                        applyUISettings(currentSettings.ui);
                        persistSettings();
                    }
                } else {
                    showModal('Generation Failed', message.error || 'Failed to generate theme. Please try again.', false, true);
                }
                break;
            }
        }
    } catch (err) {
        console.error('Error handling message:', err);
        showModal('System Error', `An error occurred while processing settings: ${err.message}`, false, true);
    }
});


// --- FUNCTIONS ---

let uiStyleNode = null;

function applyUISettings(uiData) {
    // Theme CSS is only applied to the chatbox webview, not the Settings panel.
    // This function intentionally does nothing here — it exists to avoid
    // breaking calls in populateForm() and generateThemeResult.
}

function populateForm() {
    const { general, models, ui } = currentSettings;

    // Models
    providerSelect.value = models.provider;
    apiKeyInput.value = models.apiKey;
    baseUrlInput.value = models.baseUrl;
    textModelInput.value = models.textModel;
    imageModelInput.value = models.imageModel;

    // General

    if (aggressiveAgenticInput) {
        aggressiveAgenticInput.checked = general.aggressiveAgentic || false;
    }

    if (contextModeToggle) {
        contextModeToggle.checked = general.contextMode === 'compact';
        contextModeToggle.addEventListener('change', () => {
            currentSettings.general.contextMode = contextModeToggle.checked ? 'compact' : 'full';
            persistSettings();
        });
    }

    if (enableSuggestionsToggle) {
        enableSuggestionsToggle.checked = general.enableSuggestions !== false;
    }


    // UI
    if (ui) {
        if (customCssInput) {
            customCssInput.value = ui.customCss || '';
        }
        if (allowExternalMediaToggle) {
            allowExternalMediaToggle.checked = ui.allowExternalMedia !== false; // default true
        }

        if (commandSafetyMode) {
            commandSafetyMode.value = currentSettings.permissions.commandSafetyMode || 'smart';
        }

        if (enableTerminalSandboxToggle) {
            enableTerminalSandboxToggle.checked = currentSettings.permissions.enableTerminalSandbox === true;
        }



        if (newChatSessionPlacementInput) {
            newChatSessionPlacementInput.value = currentSettings.permissions.newChatSessionPlacement || 'window';
        }

        // Auto-detect template if it matches exactly
        if (themeTemplateSelect && ui.customCss) {
            let foundMatch = false;
            
            // Check predefined templates
            for (const [key, val] of Object.entries(THEME_TEMPLATES)) {
                if (val.trim() === ui.customCss.trim()) {
                    themeTemplateSelect.value = key;
                    foundMatch = true;
                    break;
                }
            }
            
            // Check custom templates
            if (!foundMatch && currentSettings.customTemplates) {
                for (const template of currentSettings.customTemplates) {
                    if (template.css.trim() === ui.customCss.trim()) {
                        themeTemplateSelect.value = 'custom_' + template.id;
                        foundMatch = true;
                        break;
                    }
                }
            }
            
            if (!foundMatch) {
                themeTemplateSelect.value = 'custom';
            }
        } else if (themeTemplateSelect) {
            themeTemplateSelect.value = 'custom';
        }

        // Update delete button visibility based on the final selected value
        updateDeleteButtonVisibility();

        applyUISettings(ui);
    }

    // Load tools status
    const toolGroups = ['sys_tools', 'web_tools', 'cognitive_tools', 'artifact_tools', 'browser_tools'];
    toolGroups.forEach(group => {
        const val = currentSettings.tools?.[group] || (
            group === 'sys_tools' ? 'ask' :
            group === 'browser_tools' ? 'ask' : 'always'
        );
        updateToolPillDOM(group, val);
    });
}

function updateDeleteButtonVisibility() {
    if (!themeTemplateSelect || !deleteTemplateBtn) return;
    
    const value = themeTemplateSelect.value;
    if (value.startsWith('custom_')) {
        const templateId = value.substring(7);
        deleteTemplateBtn.style.display = 'inline-flex';
        deleteTemplateBtn.dataset.templateId = templateId;
    } else {
        deleteTemplateBtn.style.display = 'none';
        deleteTemplateBtn.removeAttribute('data-template-id');
    }
}

function collectSettings() {
    if (aggressiveAgenticInput) {
        currentSettings.general.aggressiveAgentic = aggressiveAgenticInput.checked;
    }
    if (contextModeToggle) {
        currentSettings.general.contextMode = contextModeToggle.checked ? 'compact' : 'full';
    }    if (enableSuggestionsToggle) {
        currentSettings.general.enableSuggestions = enableSuggestionsToggle.checked;
    }

    if (!currentSettings.permissions) {
        currentSettings.permissions = {};
    }
    if (enableTerminalSandboxToggle) {
        currentSettings.permissions.enableTerminalSandbox = enableTerminalSandboxToggle.checked;
    }

    if (newChatSessionPlacementInput) {
        currentSettings.permissions.newChatSessionPlacement = newChatSessionPlacementInput.value;
    }

    
    if (!currentSettings.ui) {
        currentSettings.ui = {};
    }
    if (customCssInput) { 
        currentSettings.ui.customCss = customCssInput.value;
        // If we are currently in 'custom' mode, also update lastCustomCss
        if (themeTemplateSelect && themeTemplateSelect.value === 'custom') {
            currentSettings.ui.lastCustomCss = customCssInput.value;
        }
    }
}

function renderPrompts() {
    if (!promptsList) return;
    promptsList.innerHTML = '';

    if (currentSettings.prompts.length === 0) {
        promptsList.innerHTML = `<div class="empty-state"><h3>No agent profiles yet</h3><p>Create your first agent to define a custom identity and system prompt.</p></div>`;
        if (agentCountValue) {
            agentCountValue.textContent = '0';
        }
        if (activeAgentCountValue) {
            activeAgentCountValue.textContent = '0';
        }
        return;
    }

    // Sort by Order
    currentSettings.prompts.sort((a, b) => a.order - b.order);

    // Summary counts
    if (agentCountValue) {
        agentCountValue.textContent = String(currentSettings.prompts.length);
    }
    if (activeAgentCountValue) {
        activeAgentCountValue.textContent = String(currentSettings.prompts.filter(p => !!p.isActive).length);
    }

    currentSettings.prompts.forEach((prompt, index) => {
        const item = document.createElement('div');
        item.className = 'agent-card';
        item.setAttribute('role', 'group');
        item.setAttribute('aria-label', `Agent: ${prompt.name || 'Unnamed'}`);

        const textareaId = `agent-prompt-${prompt.id}`;
        const activeId = `agent-active-${prompt.id}`;
        const nameId = `agent-name-${prompt.id}`;
        const maxChars = 2000;

        // Define HTML structure for the Agent Card
        item.innerHTML = `
            <div class="agent-card-header">
                <div class="agent-avatar">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                </div>
                <div class="prompt-controls">
                    <button class="icon-btn move-up" title="Move Left" aria-label="Move agent left" ${index === 0 ? 'disabled' : ''}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
                    </button>
                    <button class="icon-btn move-down" title="Move Right" aria-label="Move agent right" ${index === currentSettings.prompts.length - 1 ? 'disabled' : ''}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                    <button class="icon-btn delete" title="Delete" aria-label="Delete agent">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2-2h2"/></svg>
                    </button>
                </div>
            </div>
            <div class="prompt-body">
                <div class="form-group">
                    <label for="${nameId}">Agent Name</label>
                    <input id="${nameId}" type="text" class="prompt-name-input" value="${escapeHtml(prompt.name)}" placeholder="e.g. Chat" autocomplete="off">
                </div>
                <div class="form-group">
                    <label for="${textareaId}">Identity / System Prompt</label>
                    <textarea id="${textareaId}" rows="4" class="enhanced-textarea prompt-text" placeholder="e.g. You are an expert AI..." spellcheck="false">${escapeHtml(prompt.content)}</textarea>
                    <div class="textarea-status">
                        <span class="char-count" aria-live="polite">${prompt.content.length}</span>
                        <span class="char-limit">/ ${maxChars} characters</span>
                    </div>
                </div>
                <div class="form-group" style="display: flex; align-items: center; gap: 12px; justify-content: space-between;">
                    <label for="${activeId}" class="active-status-label" style="margin: 0;">${prompt.isActive ? 'Active' : 'Inactive'}</label>
                    <label class="toggle-switch" aria-label="Toggle agent active">
                        <input id="${activeId}" type="checkbox" ${prompt.isActive ? 'checked' : ''}>
                        <span class="toggle-slider" aria-hidden="true"></span>
                    </label>
                </div>
            </div>
        `;

        // Add Listeners

        // Name Change
        const nameInput = item.querySelector('.prompt-name-input');
        nameInput.addEventListener('input', (e) => {
            prompt.name = e.target.value;
            item.setAttribute('aria-label', `Agent: ${prompt.name || 'Unnamed'}`);
            debouncedPersist();
        });

        // Content Change
        const promptText = item.querySelector('.prompt-text');
        const charCount = item.querySelector('.char-count');
        const autoGrow = (ta) => {
            // Auto-grow without shrinking too aggressively; keeps UI stable
            ta.style.height = 'auto';
            ta.style.height = Math.min(420, ta.scrollHeight + 2) + 'px';
        };

        // Initialize editor height
        autoGrow(promptText);

        promptText.addEventListener('input', (e) => {
            const next = e.target.value || '';
            prompt.content = next.length > maxChars ? next.slice(0, maxChars) : next;
            if (e.target.value !== prompt.content) {
                e.target.value = prompt.content;
            }
            if (charCount) {
                charCount.textContent = String(prompt.content.length);
            }
            autoGrow(e.target);
            debouncedPersist();
        });

        // Active toggle
        const activeToggle = item.querySelector(`#${activeId}`);
        const activeLabel = item.querySelector('.active-status-label');
        activeToggle.addEventListener('change', (e) => {
            prompt.isActive = !!e.target.checked;
            if (activeLabel) {
                activeLabel.textContent = prompt.isActive ? 'Active' : 'Inactive';
            }
            if (activeAgentCountValue) {
                activeAgentCountValue.textContent = String(currentSettings.prompts.filter(p => !!p.isActive).length);
            }
            persistSettings();
        });

        // Move Up
        item.querySelector('.move-up').addEventListener('click', (e) => {
            e.stopPropagation();
            if (index > 0) {
                const temp = currentSettings.prompts[index];
                currentSettings.prompts[index] = currentSettings.prompts[index - 1];
                currentSettings.prompts[index - 1] = temp;
                currentSettings.prompts.forEach((p, i) => p.order = i + 1);
                renderPrompts();
                persistSettings();
            }
        });

        // Move Down
        item.querySelector('.move-down').addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < currentSettings.prompts.length - 1) {
                const temp = currentSettings.prompts[index];
                currentSettings.prompts[index] = currentSettings.prompts[index + 1];
                currentSettings.prompts[index + 1] = temp;
                currentSettings.prompts.forEach((p, i) => p.order = i + 1);
                renderPrompts();
                persistSettings();
            }
        });

        // Delete
        const deleteBtn = item.querySelector('.delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const confirmed = await showModal(
                    'Delete Agent',
                    `Are you sure you want to delete agent "${prompt.name || 'Unnamed'}"? This cannot be undone.`
                );

                if (confirmed) {
                    currentSettings.prompts = currentSettings.prompts.filter(p => p.id !== prompt.id);
                    currentSettings.prompts.forEach((p, i) => {
                        p.order = i + 1;
                    });
                    renderPrompts();
                    persistSettings();
                }
            });
        }

        promptsList.appendChild(item);
    });
}

function escapeHtml(unsafe) {
    if (!unsafe) {
        return "";
    }
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function populateModelDropdowns(provider, selectedText, selectedImage) {

    const data = DEFAULT_MODELS[provider] || DEFAULT_MODELS['OpenAI'];

    // Safety check: specific model data might not be loaded yet
    if (!data) {
        return;
    }

    // Structure from backend is { name: '...', models: { text: [], image: [] } }
    // But we should also fail-safe if structure is flat
    const source = data.models || data;

    if (!source || !source.text) {
        return;
    }

    let textList = [...source.text];
    // Gather ALL image models across all providers (deduplicated)
    let imageSet = new Set();
    for (const [key, pData] of Object.entries(DEFAULT_MODELS)) {
        const pSource = pData.models || pData;
        if (pSource && pSource.image) {
            pSource.image.forEach(m => imageSet.add(m));
        }
    }
    let imageList = [...imageSet];

    // Add custom models
    const customModels = currentSettings.customModels || [];
    for (const cm of customModels) {
        if (cm.provider === provider || cm.provider === 'Custom') {
            if (!textList.includes(cm.name)) textList.push(cm.name);
        }
        // Add ALL custom models to the image list (so they can be used as global fallbacks)
        if (!imageList.includes(cm.name)) imageList.push(cm.name);
    }

    // If selected model is not in default list, add it (preserves previously fetched selection)
    if (selectedText && !textList.includes(selectedText)) {
        textList.push(selectedText);
    }
    if (selectedImage && !imageList.includes(selectedImage)) {
        imageList.push(selectedImage);
    }

    // Helper to format option with alias if available
    const getOptionHtml = (modelName) => {
        const cm = customModels.find(c => c.name === modelName);
        const displayName = cm && cm.alias ? cm.alias : modelName;
        return `<option value="${modelName}">${displayName}</option>`;
    };

    // Text
    textModelInput.innerHTML = textList.map(m => getOptionHtml(m)).join('');
    // Image
    imageModelInput.innerHTML = imageList.map(m => getOptionHtml(m)).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// MODEL MANAGEMENT TABLE
// ═══════════════════════════════════════════════════════════════════════

function getProviderIcon(provider) {
    switch ((provider || '').toLowerCase()) {
        case 'openai':
            return `<svg class="model-icon openai" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>`;
        case 'gemini':
            return `<svg class="model-icon gemini" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;
        default:
            return `<svg class="model-icon custom" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
    }
}

function renderModelTable() {
    const listBody = document.getElementById('model-list-body');
    if (!listBody) return;

    const activeImageModel = currentSettings.models.imageModel;

    // Helper: build a model row with expandable config
    function buildRow(modelName, providerKey, providerName, isCustom, customId, supportsImage, modelSupportsReasoning, modelTier, alias) {
        let isActive = true;
        if (isCustom) {
            const cm = (currentSettings.customModels || []).find(m => m.id === customId);
            if (cm && cm.isActive !== undefined) isActive = cm.isActive;
        } else {
            const inactive = currentSettings.models.inactiveModels || [];
            if (inactive.includes(modelName)) isActive = false;
        }

        const uid = (customId || providerKey + '-' + modelName).replace(/[^a-zA-Z0-9]/g, '_');
        const configId = `config-${uid}`;

        // Get existing config for this model
        let apiKey = '', baseUrl = '', apiKeyHeaderVal = '', supportsReasoning = modelSupportsReasoning;
        let tier = modelTier || 'mid';
        let azureStyleVal = false;
        if (isCustom) {
            const cm = (currentSettings.customModels || []).find(m => m.id === customId);
            if (cm) { 
                apiKey = cm.apiKey || ''; 
                baseUrl = cm.baseUrl || ''; 
                apiKeyHeaderVal = cm.apiKeyHeader || ''; 
                supportsReasoning = cm.supportsReasoning || false;
                tier = cm.tier || 'mid';
                azureStyleVal = cm.azureStyle || false;
            }
        } else {
            const ps = (currentSettings.models.providerSettings || {})[providerKey];
            if (ps) { apiKey = ps.apiKey || ''; baseUrl = ps.baseUrl || ''; }
        }

        const hasConfig = apiKey || baseUrl;
        const configDot = hasConfig ? `<span class="config-dot" title="Configured"></span>` : '';

        const dataAttr = isCustom ? `data-custom-id="${customId}"` : `data-provider="${providerKey}"`;
        const activeToggleId = `active-toggle-${uid}`;
        const reasonToggleId = `reason-toggle-${uid}`;
        const imageToggleId = `image-toggle-${uid}`;

        const tierLabel = tier === 'frontier' ? 'Pro' : tier === 'mid' ? 'Mid' : 'Lite';
        const tierClickable = isCustom ? ' clickable' : '';
        const tierOnClick = isCustom ? ` onclick="cycleModelTier('${customId}')"` : '';

        let deleteBtn = '';
        if (isCustom) {
            deleteBtn = `<button class="icon-btn danger" title="Delete" onclick="event.stopPropagation(); deleteCustomModel('${customId}')">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>`;
        }

        // Active status indicator on inline row
        const statusDot = isActive
            ? `<span class="model-status-dot active" title="Active"></span>`
            : `<span class="model-status-dot" title="Inactive"></span>`;

        return `
            <div class="model-card" ${dataAttr}>
                <div class="model-card-main" onclick="toggleModelExpand('${configId}', this)">
                    <div class="model-card-identity">
                        <svg class="expand-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                        ${getProviderIcon(providerKey)}
                        <div class="model-card-name-block">
                            <span class="model-card-name">${escapeHtml(alias || modelName)}${configDot}</span>
                            <span class="model-card-provider">${escapeHtml(providerName)}</span>
                        </div>
                    </div>
                    <div class="model-card-inline-meta" onclick="event.stopPropagation()">
                        ${statusDot}
                        ${deleteBtn}
                    </div>
                </div>
                <div class="model-config-panel" id="${configId}" style="display:none;" ${dataAttr}>
                    <div class="config-toggles">
                        <span class="tier-badge tier-${tier}${tierClickable}"${tierOnClick} title="${isCustom ? 'Click to cycle tier' : 'Model tier'}">${tierLabel}</span>
                        <label class="config-toggle-item">
                            <span class="config-toggle-label">Active</span>
                            <label class="toggle-switch">
                                <input id="${activeToggleId}" type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleModelActive('${isCustom ? 'true' : 'false'}', '${customId || ''}', '${escapeHtml(modelName)}', this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </label>
                        <label class="config-toggle-item">
                            <span class="config-toggle-label">Reasoning</span>
                            <label class="toggle-switch">
                                <input id="${reasonToggleId}" type="checkbox" ${supportsReasoning ? 'checked' : ''} ${!isCustom ? 'disabled' : ''} onchange="toggleModelReasoning('${customId || ''}', this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </label>
                        <label class="config-toggle-item">
                            <span class="config-toggle-label">Image</span>
                            <label class="toggle-switch">
                                <input id="${imageToggleId}" type="checkbox" ${supportsImage ? 'checked' : ''} ${!isCustom ? 'disabled' : ''} onchange="toggleModelImage('${customId || ''}', this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </label>
                        <label class="config-toggle-item">
                            <span class="config-toggle-label" title="Set this model as the global fallback image service">Img Fallback</span>
                            <label class="toggle-switch">
                                <input type="checkbox" class="vision-fallback-checkbox" data-model-name="${escapeHtml(modelName)}" ${currentSettings.models.imageModel === modelName ? 'checked' : ''} onchange="setVisionFallback('${escapeHtml(modelName)}', this.checked)">
                                <span class="toggle-slider"></span>
                            </label>
                        </label>
                    </div>
                    <div class="config-row">
                        <div class="config-field">
                            <label>API Key</label>
                            <div style="display:flex;gap:0;">
                                <input type="password" placeholder="sk-..." value="${escapeHtml(apiKey)}" data-config-field="apiKey" disabled style="border-radius:6px 0 0 6px;border-right:none;">
                                <button class="config-eye-btn" onclick="toggleConfigKey(this)" title="Toggle visibility" type="button">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="config-field">
                            <label>Base URL</label>
                            <input type="text" placeholder="Leave empty for default" value="${escapeHtml(baseUrl)}" data-config-field="baseUrl" disabled>
                        </div>
                        ${isCustom ? `<div class="config-field">
                            <label>Alias <span style="font-size:0.72rem;opacity:0.6;">(optional)</span></label>
                            <input type="text" placeholder="Display name" value="${escapeHtml(alias || '')}" data-config-field="alias" disabled>
                        </div>` : ''}
                        ${isCustom && (providerKey === 'Custom' || providerKey === 'Azure OpenAI' || providerKey === 'Anthropic') ? `<div class="config-field">
                            <label>API Key Header <span style="font-size:0.72rem;opacity:0.6;">(optional)</span></label>
                            <input type="text" placeholder="e.g., x-api-key" value="${escapeHtml(apiKeyHeaderVal)}" data-config-field="apiKeyHeader" disabled>
                        </div>` : ''}
                    </div>
                    <div class="config-actions">
                        <button class="config-edit-btn" onclick="toggleModelEdit('${configId}')" title="Edit">
                            <svg class="edit-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            <svg class="check-icon" style="display:none;" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        </button>
                    </div>
                </div>
            </div>`;
    }

    // Build all rows into a single list
    let allHtml = '';

    // Built-in models
    for (const [providerKey, providerData] of Object.entries(DEFAULT_MODELS)) {
        const source = providerData.models || providerData;
        if (!source || !source.text) continue;
        const allModels = [...new Set([...source.text, ...(source.image || [])])];
        const imageModels = source.image || [];
        const reasoningModels = providerData.supportsReasoning || [];
        const tiers = providerData.tiers || {};
        for (const modelName of allModels) {
            const canImage = imageModels.includes(modelName);
            const canReason = reasoningModels.includes(modelName);
            const modelTier = tiers[modelName] || 'mid';
            allHtml += buildRow(modelName, providerKey, providerData.name || providerKey, false, null, canImage, canReason, modelTier);
        }
    }

    // Custom models
    const customModels = currentSettings.customModels || [];
    for (const cm of customModels) {
        const tier = cm.name.toLowerCase().includes('gpt-4') || cm.name.toLowerCase().includes('claude-3-opus') ? 'frontier' : 'mid';
        allHtml += buildRow(cm.name, cm.provider, cm.provider, true, cm.id, !!cm.supportsImage, !!cm.supportsReasoning, tier, cm.alias);
    }

    listBody.innerHTML = allHtml;
}

window.toggleModelActive = function (isCustomStr, customId, modelName, isActive) {
    const isCustom = isCustomStr === 'true';

    if (isCustom) {
        const cm = (currentSettings.customModels || []).find(m => m.id === customId);
        if (cm) cm.isActive = isActive;
    } else {
        if (!currentSettings.models.inactiveModels) currentSettings.models.inactiveModels = [];
        if (!isActive) {
            if (!currentSettings.models.inactiveModels.includes(modelName)) {
                currentSettings.models.inactiveModels.push(modelName);
            }
        } else {
            currentSettings.models.inactiveModels = currentSettings.models.inactiveModels.filter(m => m !== modelName);
        }
    }

    persistSettings();
    populateModelDropdowns(currentSettings.models.provider, currentSettings.models.textModel, currentSettings.models.imageModel);

    // Update inline status dot
    const selector = isCustom ? `[data-custom-id="${customId}"]` : `[data-provider="${modelName}"]`;
    // Try to find the closest model-card parent
    const checkbox = document.getElementById(`active-toggle-${(customId || modelName).replace(/[^a-zA-Z0-9]/g, '_')}`);
    if (checkbox) {
        const card = checkbox.closest('.model-card');
        if (card) {
            const dot = card.querySelector('.model-status-dot');
            if (dot) {
                dot.classList.toggle('active', isActive);
            }
        }
    }
};

window.toggleModelReasoning = function (customId, supportsReasoning) {
    if (customId) {
        const cm = (currentSettings.customModels || []).find(m => m.id === customId);
        if (cm) {
            cm.supportsReasoning = supportsReasoning;
            persistSettings();
        }
    }
};

window.cycleModelTier = function (customId) {
    const cm = (currentSettings.customModels || []).find(m => m.id === customId);
    if (!cm) return;
    const order = ['frontier', 'mid', 'small'];
    const labels = { frontier: 'Pro', mid: 'Mid', small: 'Lite' };
    const current = cm.tier || 'mid';
    const idx = order.indexOf(current);
    const newTier = order[(idx + 1) % order.length];
    cm.tier = newTier;

    // Update badge DOM directly for instant feedback (no full table re-render)
    const row = document.querySelector(`[data-custom-id="${customId}"]`);
    if (row) {
        const badge = row.querySelector('.tier-badge');
        if (badge) {
            badge.className = `tier-badge ${newTier} clickable`;
            badge.textContent = labels[newTier] || newTier;
        }
    }

    persistSettings();
};



// Toggle expand/collapse of model config panel
window.toggleModelExpand = function(configId, mainEl) {
    const panel = document.getElementById(configId);
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    
    // Rotate chevron
    const card = mainEl.closest('.model-card');
    if (card) card.classList.toggle('expanded', !isOpen);
};

// Toggle edit/save mode for model config fields
window.toggleModelEdit = function(configId) {
    const panel = document.getElementById(configId);
    if (!panel) return;
    
    const inputs = panel.querySelectorAll('.config-row input');
    const editIcon = panel.querySelector('.edit-icon');
    const checkIcon = panel.querySelector('.check-icon');
    const editBtn = panel.querySelector('.config-edit-btn');
    
    const isEditing = !inputs[0]?.disabled === false;
    
    if (inputs[0]?.disabled) {
        // Enter edit mode
        inputs.forEach(i => i.disabled = false);
        if (editIcon) editIcon.style.display = 'none';
        if (checkIcon) checkIcon.style.display = 'inline';
        if (editBtn) editBtn.classList.add('editing');
    } else {
        // Save and exit edit mode
        // Get config data from panel
        const dataAttr = panel.dataset.customId ? 'customId' : 'provider';
        const customId = panel.dataset.customId || '';
        const providerKey = panel.dataset.provider || '';
        
        // Delegate to existing save logic
        const apiKeyField = panel.querySelector('[data-config-field="apiKey"]');
        const baseUrlField = panel.querySelector('[data-config-field="baseUrl"]');
        const apiKey = apiKeyField?.value?.trim() || '';
        const baseUrl = baseUrlField?.value?.trim() || '';
        const apiKeyHeaderField = panel.querySelector('[data-config-field="apiKeyHeader"]');
        const apiKeyHeaderVal = apiKeyHeaderField?.value?.trim() || '';
        const azureStyleField = panel.querySelector('[data-config-field="azureStyle"]');
        const azureStyleVal = azureStyleField?.checked || false;
        const aliasField = panel.querySelector('[data-config-field="alias"]');
        const aliasVal = aliasField?.value?.trim() || '';
        
        if (customId) {
            const cm = (currentSettings.customModels || []).find(m => m.id === customId);
            if (cm) {
                cm.apiKey = apiKey;
                cm.baseUrl = baseUrl;
                if (apiKeyHeaderVal) cm.apiKeyHeader = apiKeyHeaderVal;
                else delete cm.apiKeyHeader;
                if (azureStyleVal) cm.azureStyle = true;
                else delete cm.azureStyle;
                if (aliasVal) cm.alias = aliasVal;
                else delete cm.alias;
            }
        } else if (providerKey) {
            if (!currentSettings.models.providerSettings) currentSettings.models.providerSettings = {};
            if (!currentSettings.models.providerSettings[providerKey]) {
                currentSettings.models.providerSettings[providerKey] = { apiKey: '', baseUrl: '', textModel: '', imageModel: '' };
            }
            currentSettings.models.providerSettings[providerKey].apiKey = apiKey;
            currentSettings.models.providerSettings[providerKey].baseUrl = baseUrl;
        }
        
        if (providerKey === currentSettings.models.provider || customId) {
            currentSettings.models.apiKey = apiKey;
            currentSettings.models.baseUrl = baseUrl;
        }
        
        persistSettings();
        
        if (customId) {
            // Re-render table and dropdowns to show any updates
            renderModelTable();
            populateModelDropdowns(currentSettings.models.provider, currentSettings.models.textModel, currentSettings.models.imageModel);
        }
        
        // Lock fields again
        inputs.forEach(i => i.disabled = true);
        if (editIcon) editIcon.style.display = 'inline';
        if (checkIcon) checkIcon.style.display = 'none';
        if (editBtn) editBtn.classList.remove('editing');
        
        // Update config dot
        renderModelTable();
    }
};

// Toggle API key visibility in config panels
window.toggleConfigKey = function(btn) {
    const input = btn.parentElement.querySelector('input[data-config-field="apiKey"]');
    if (!input) return;
    const isVisible = input.type === 'text';
    input.type = isVisible ? 'password' : 'text';
    btn.style.opacity = isVisible ? '0.5' : '1';
};

// Save model config (inline)
window.saveModelConfig = function(configId, customId, providerKey) {
    const panel = document.getElementById(configId);
    if (!panel) return;
    const apiKeyField = panel.querySelector('[data-config-field="apiKey"]');
    const baseUrlField = panel.querySelector('[data-config-field="baseUrl"]');
    const apiKey = apiKeyField?.value?.trim() || '';
    const baseUrl = baseUrlField?.value?.trim() || '';
    const apiKeyHeaderField = panel.querySelector('[data-config-field="apiKeyHeader"]');
    const apiKeyHeaderVal = apiKeyHeaderField?.value?.trim() || '';
    const supportsReasoningField = panel.querySelector('[data-config-field="supportsReasoning"]');
    const supportsReasoningVal = supportsReasoningField?.checked || false;
    const azureStyleField = panel.querySelector('[data-config-field="azureStyle"]');
    const azureStyleVal = azureStyleField?.checked || false;

    if (customId) {
        // Custom model
        const cm = (currentSettings.customModels || []).find(m => m.id === customId);
        if (cm) {
            cm.apiKey = apiKey;
            cm.baseUrl = baseUrl;
            cm.supportsReasoning = supportsReasoningVal;
            if (apiKeyHeaderVal) { cm.apiKeyHeader = apiKeyHeaderVal; }
            else { delete cm.apiKeyHeader; }
            if (azureStyleVal) { cm.azureStyle = true; }
            else { delete cm.azureStyle; }
        }
    } else {
        // Built-in model — save to providerSettings
        if (!currentSettings.models.providerSettings) currentSettings.models.providerSettings = {};
        if (!currentSettings.models.providerSettings[providerKey]) {
            currentSettings.models.providerSettings[providerKey] = { apiKey: '', baseUrl: '', textModel: '', imageModel: '' };
        }
        currentSettings.models.providerSettings[providerKey].apiKey = apiKey;
        currentSettings.models.providerSettings[providerKey].baseUrl = baseUrl;
    }

    // Also update the top-level active settings if this is the active provider
    if (providerKey === currentSettings.models.provider || customId) {
        currentSettings.models.apiKey = apiKey;
        currentSettings.models.baseUrl = baseUrl;
    }

    panel.style.display = 'none';
    persistSettings();
    renderModelTable(); // Refresh to show config dot
};

// Toggle image support for a custom model
window.toggleModelImage = function(customId, supportsImage) {
    if (customId) {
        const cm = (currentSettings.customModels || []).find(m => m.id === customId);
        if (cm) {
            cm.supportsImage = supportsImage;
            persistSettings();
        }
    }
};

// Set this model as the global fallback image service
window.setVisionFallback = function(modelName, isChecked) {
    if (isChecked) {
        currentSettings.models.imageModel = modelName;
    } else {
        // If they uncheck the current one, we clear it (defaults to text model)
        if (currentSettings.models.imageModel === modelName) {
            currentSettings.models.imageModel = "";
        }
    }
    
    // Update the DOM for mutual exclusivity without a full re-render
    const checkboxes = document.querySelectorAll('.vision-fallback-checkbox');
    checkboxes.forEach(cb => {
        if (cb.dataset.modelName !== modelName) {
            cb.checked = false;
        }
    });

    persistSettings();
};

// ═══════════════════════════════════════════════════════════════════════
// ADD MODEL MODAL
// ═══════════════════════════════════════════════════════════════════════

const addModelModal = document.getElementById('addModelModal');
const btnAddModel = document.getElementById('btn-add-model');
const addModelCloseBtn = document.getElementById('addModelCloseBtn');
const addModelSubmitBtn = document.getElementById('addModelSubmitBtn');
const addModelProvider = document.getElementById('addModelProvider');
const addModelName = document.getElementById('addModelName');
const addModelAzureGroup = document.getElementById('addModelAzureGroup');
const addModelAzureStyle = document.getElementById('addModelAzureStyle');



function openAddModelModal() {
    if (!addModelModal) return;
    // Reset fields
    if (addModelProvider) addModelProvider.value = '';
    if (addModelName) addModelName.value = '';
    addModelModal.classList.remove('hidden');
}


function closeAddModelModal() {
    if (addModelModal) addModelModal.classList.add('hidden');
}

if (btnAddModel) btnAddModel.addEventListener('click', openAddModelModal);
if (addModelCloseBtn) addModelCloseBtn.addEventListener('click', closeAddModelModal);
if (addModelModal) {
    addModelModal.addEventListener('click', (e) => {
        if (e.target === addModelModal) closeAddModelModal();
    });
}

if (addModelSubmitBtn) {
    addModelSubmitBtn.addEventListener('click', () => {
        const provider = addModelProvider?.value;
        const name = addModelName?.value?.trim();

        if (!provider || !name) {
            // Flash the missing fields
            if (!provider && addModelProvider) { addModelProvider.style.borderColor = 'var(--danger-color)'; setTimeout(() => { addModelProvider.style.borderColor = ''; }, 1500); }
            if (!name && addModelName) { addModelName.style.borderColor = 'var(--danger-color)'; setTimeout(() => { addModelName.style.borderColor = ''; }, 1500); }
            return;
        }

        // Create the custom model — image/reasoning toggleable from the model table
        // Auto-detect known reasoning models
        const lowerName = name.toLowerCase();
        const isKnownReasoningModel = lowerName.includes('gemini') || lowerName.includes('gpt-5') || lowerName.includes('o1') || lowerName.includes('o3') || lowerName.includes('thinking') || lowerName.includes('claude') || lowerName.includes('sonnet') || lowerName.includes('opus');
        const supportsImage = lowerName.includes('gemini') || lowerName.includes('gpt-5') || lowerName.includes('vision') || lowerName.includes('claude') || lowerName.includes('sonnet') || lowerName.includes('opus');
        const supportsReasoning = isKnownReasoningModel;
        const isAzure = provider === 'Azure OpenAI';
        const newModel = {
            id: Date.now().toString(),
            name,
            provider,
            apiKey: '',
            baseUrl: '',
            supportsImage,
            supportsReasoning,
            azureStyle: isAzure || undefined
        };

        if (!currentSettings.customModels) currentSettings.customModels = [];
        currentSettings.customModels.push(newModel);

        // Also store in providerSettings for the model's provider if it's a known one
        if (!currentSettings.models.providerSettings) currentSettings.models.providerSettings = {};
        if (!currentSettings.models.providerSettings[provider]) {
            currentSettings.models.providerSettings[provider] = {
                apiKey: '',
                baseUrl: '',
                textModel: name,
                imageModel: name
            };
        }

        persistSettings();
        renderModelTable();
        populateModelDropdowns(currentSettings.models.provider, currentSettings.models.textModel, currentSettings.models.imageModel);
        closeAddModelModal();
    });
}

// Delete custom model
window.deleteCustomModel = async function(id) {
    const confirmed = await showModal('Delete Custom Model', 'Are you sure you want to remove this custom model?');
    if (!confirmed) return;

    if (!currentSettings.customModels) return;
    currentSettings.customModels = currentSettings.customModels.filter(m => m.id !== id);
    persistSettings();
    renderModelTable();
    populateModelDropdowns(currentSettings.models.provider, currentSettings.models.textModel, currentSettings.models.imageModel);
};
