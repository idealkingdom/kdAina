/**
 * Agent Hub — Frontend Logic
 * File-based Agents and Rules management.
 */
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // ─── STATE ───────────────────────────────────────────────────────────
    let agents = [];
    let rules = [];
    let providers = {}; // Record<name, ProviderDef>
    let providerSettings = {}; // Record<providerName, { apiKey, baseUrl, ... }>
    let inactiveModels = []; // string[]
    let currentFilteredModels = []; // string[]
    let activeModelFilter = 'all';
    const collapsedState = {};

    // ─── DOM REFS ────────────────────────────────────────────────────────
    const btnAddAgent = document.getElementById('btn-add-agent');
    const agentCountEl = document.getElementById('agent-count');
    const activeCountEl = document.getElementById('active-agent-count');
    const agentsList = document.getElementById('agents-list');
    const agentsEmpty = document.getElementById('agents-empty');
    const agentSearch = document.getElementById('agent-search');
    const agentSearchClear = document.getElementById('agent-search-clear');
    const agentFilterOrigin = document.getElementById('agent-filter-origin');
    const agentFilterStatus = document.getElementById('agent-filter-status');
    const agentFilterType = document.getElementById('agent-filter-type');

    const btnAddRule = document.getElementById('btn-add-rule');
    const ruleCountEl = document.getElementById('rule-count');
    const rulesList = document.getElementById('rules-list');
    const rulesEmpty = document.getElementById('rules-empty');
    const ruleSearch = document.getElementById('rule-search');
    const ruleSearchClear = document.getElementById('rule-search-clear');
    const ruleFilterOrigin = document.getElementById('rule-filter-origin');
    const ruleFilterScope = document.getElementById('rule-filter-scope');

    const btnAddProvider = document.getElementById('btn-add-provider');
    const providerCountEl = document.getElementById('provider-count');
    const providersList = document.getElementById('providers-list');
    const providersEmpty = document.getElementById('providers-empty');
    const providerSearch = document.getElementById('provider-search');
    const providerSearchClear = document.getElementById('provider-search-clear');
    const providerFilterOrigin = document.getElementById('provider-filter-origin');

    const btnAddModel = document.getElementById('btn-add-model');
    const modelCountEl = document.getElementById('model-count');
    const modelsList = document.getElementById('models-list');
    const modelsEmpty = document.getElementById('models-empty');
    const modelSearch = document.getElementById('model-search');
    const modelSearchClear = document.getElementById('model-search-clear');
    const modelFilterProvider = document.getElementById('model-filter-provider');
    const modelFilterType = document.getElementById('model-filter-type');
    const modelFilterTier = document.getElementById('model-filter-tier');
    const modelFilterStatus = document.getElementById('model-filter-status');
    const toggleAllModels = document.getElementById('toggle-all-models');

    // ─── MODAL DOM REFS ──────────────────────────────────────────────────
    const customModal = document.getElementById('customModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalText = document.getElementById('modalText');
    const modalCancelBtn = document.getElementById('modalCancelBtn');
    const modalConfirmBtn = document.getElementById('modalConfirmBtn');

    // ─── MODAL CONTROLLER ────────────────────────────────────────────────
    let _modalAbort = null;
    let _modalPendingResolve = null;

    function showModal(title, text, isAlert = false) {
        return new Promise((resolve) => {
            if (!customModal) return resolve(false);
            
            if (_modalAbort) { _modalAbort.abort(); }
            if (_modalPendingResolve) { _modalPendingResolve(false); }

            _modalAbort = new AbortController();
            _modalPendingResolve = resolve;
            const signal = _modalAbort.signal;

            modalTitle.textContent = title;
            modalText.textContent = text;
            
            if (isAlert) {
                modalCancelBtn.style.display = 'none';
                modalConfirmBtn.textContent = 'OK';
            } else {
                modalCancelBtn.style.display = 'inline-block';
                modalConfirmBtn.textContent = 'Confirm';
            }

            requestAnimationFrame(() => {
                if (signal.aborted) return;
                customModal.classList.remove('hidden');
            });

            const cleanup = () => {
                customModal.classList.add('hidden');
                _modalAbort?.abort();
                _modalAbort = null;
                _modalPendingResolve = null;
            };

            modalConfirmBtn.addEventListener('click', () => {
                cleanup();
                resolve(true);
            }, { signal });
            
            modalCancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            }, { signal });
        });
    }

    // ─── INPUT MODAL (text input) ────────────────────────────────────────
    function showInputModal(title, label, placeholder) {
        return new Promise((resolve) => {
            if (!customModal) return resolve(null);
            if (_modalAbort) { _modalAbort.abort(); }
            if (_modalPendingResolve) { _modalPendingResolve(null); }
            _modalAbort = new AbortController();
            _modalPendingResolve = resolve;
            const signal = _modalAbort.signal;

            modalTitle.textContent = title;
            modalText.innerHTML = `<label style="display:block;margin-bottom:6px;opacity:0.7;font-size:11px;">${escHtml(label)}</label><input id="modal-input-field" type="text" placeholder="${escHtml(placeholder)}" style="width:100%;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(255,255,255,0.1));border-radius:4px;font-size:13px;outline:none;" />`;
            modalCancelBtn.style.display = 'inline-block';
            modalConfirmBtn.textContent = 'OK';

            requestAnimationFrame(() => {
                if (signal.aborted) return;
                customModal.classList.remove('hidden');
                document.getElementById('modal-input-field')?.focus();
            });

            const cleanup = () => { customModal.classList.add('hidden'); _modalAbort?.abort(); _modalAbort = null; _modalPendingResolve = null; };
            modalConfirmBtn.addEventListener('click', () => { const v = document.getElementById('modal-input-field')?.value || ''; cleanup(); resolve(v); }, { signal });
            modalCancelBtn.addEventListener('click', () => { cleanup(); resolve(null); }, { signal });
            document.getElementById('modal-input-field')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = e.target.value || ''; cleanup(); resolve(v); } }, { signal });
        });
    }

    // ─── SELECT MODAL (dropdown) ─────────────────────────────────────────
    function showSelectModal(title, label, options) {
        return new Promise((resolve) => {
            if (!customModal) return resolve(null);
            if (_modalAbort) { _modalAbort.abort(); }
            if (_modalPendingResolve) { _modalPendingResolve(null); }
            _modalAbort = new AbortController();
            _modalPendingResolve = resolve;
            const signal = _modalAbort.signal;

            const optionsHtml = options.map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
            modalTitle.textContent = title;
            modalText.innerHTML = `<label style="display:block;margin-bottom:6px;opacity:0.7;font-size:11px;">${escHtml(label)}</label><select id="modal-select-field" style="width:100%;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(255,255,255,0.1));border-radius:4px;font-size:13px;outline:none;">${optionsHtml}</select>`;
            modalCancelBtn.style.display = 'inline-block';
            modalConfirmBtn.textContent = 'OK';

            requestAnimationFrame(() => {
                if (signal.aborted) return;
                customModal.classList.remove('hidden');
            });

            const cleanup = () => { customModal.classList.add('hidden'); _modalAbort?.abort(); _modalAbort = null; _modalPendingResolve = null; };
            modalConfirmBtn.addEventListener('click', () => { const v = document.getElementById('modal-select-field')?.value || ''; cleanup(); resolve(v); }, { signal });
            modalCancelBtn.addEventListener('click', () => { cleanup(); resolve(null); }, { signal });
        });
    }

    // ─── TAB SWITCHING ───────────────────────────────────────────────────
    document.querySelectorAll('.hub-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.hub-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.hub-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.getAttribute('data-tab');
            document.getElementById('panel-' + target)?.classList.add('active');

            if (target === 'agents') {
                vscode.postMessage({ command: 'requestAgents' });
            }
            if (target === 'rules') {
                vscode.postMessage({ command: 'requestRules' });
            }
            if (target === 'providers') {
                vscode.postMessage({ command: 'requestProviders' });
            }
            if (target === 'models') {
                vscode.postMessage({ command: 'requestProviders' });
            }
        });
    });

    // ─── RULES: ADD ──────────────────────────────────────────────────────
    btnAddRule?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addRule' });
    });

    // ─── AGENTS: SEARCH & FILTERS ────────────────────────────────────────
    agentSearch?.addEventListener('input', () => {
        if (agentSearchClear) {
            agentSearchClear.style.display = agentSearch.value ? 'block' : 'none';
        }
        renderAgents();
    });
    agentSearchClear?.addEventListener('click', () => {
        if (agentSearch) {
            agentSearch.value = '';
            agentSearchClear.style.display = 'none';
            renderAgents();
        }
    });
    agentFilterOrigin?.addEventListener('change', renderAgents);
    agentFilterStatus?.addEventListener('change', renderAgents);
    agentFilterType?.addEventListener('change', renderAgents);

    // ─── RULES: SEARCH & FILTERS ────────────────────────────────────────
    ruleSearch?.addEventListener('input', () => {
        if (ruleSearchClear) {
            ruleSearchClear.style.display = ruleSearch.value ? 'block' : 'none';
        }
        renderRules();
    });
    ruleSearchClear?.addEventListener('click', () => {
        if (ruleSearch) {
            ruleSearch.value = '';
            ruleSearchClear.style.display = 'none';
            renderRules();
        }
    });
    ruleFilterOrigin?.addEventListener('change', renderRules);
    ruleFilterScope?.addEventListener('change', renderRules);

    // ─── PROVIDERS: SEARCH & FILTERS ────────────────────────────────────
    providerSearch?.addEventListener('input', () => {
        if (providerSearchClear) {
            providerSearchClear.style.display = providerSearch.value ? 'block' : 'none';
        }
        renderProviders();
    });
    providerSearchClear?.addEventListener('click', () => {
        if (providerSearch) {
            providerSearch.value = '';
            providerSearchClear.style.display = 'none';
            renderProviders();
        }
    });
    providerFilterOrigin?.addEventListener('change', renderProviders);

    // ─── AGENTS: ADD ─────────────────────────────────────────────────────
    btnAddAgent?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addAgent' });
    });

    // ─── PROVIDERS: ADD ──────────────────────────────────────────────────
    btnAddProvider?.addEventListener('click', async () => {
        const name = await showInputModal('New Provider', 'Provider Name', 'e.g. Anthropic, Ollama...');
        if (!name) return;
        const baseUrl = await showInputModal('New Provider', 'Base URL', 'e.g. https://api.anthropic.com/v1');
        if (baseUrl === null) return;
        vscode.postMessage({ command: 'addProvider', data: { name, baseUrl: baseUrl || '' } });
    });

    // ─── MODELS: ADD ─────────────────────────────────────────────────────
    btnAddModel?.addEventListener('click', async () => {
        const providerNames = Object.keys(providers);
        if (providerNames.length === 0) {
            await showModal('No Providers', 'Add a provider first before adding models.', true);
            return;
        }
        // Use the input modal to get provider and model name
        const providerName = await showSelectModal('Add Model', 'Select Provider', providerNames);
        if (!providerName) return;
        const modelName = await showInputModal('Add Model', 'Model Name', 'e.g. gpt-4o, claude-3.5-sonnet');
        if (!modelName) return;

        const provider = providers[providerName];
        vscode.postMessage({
            command: 'addModel',
            data: { providerId: provider.id, modelName, types: ['text', 'image'] }
        });
    });

    // ─── MODELS: SEARCH & FILTERS ────────────────────────────────────────
    modelSearch?.addEventListener('input', () => {
        if (modelSearchClear) {
            modelSearchClear.style.display = modelSearch.value ? 'block' : 'none';
        }
        renderModels();
    });

    modelSearchClear?.addEventListener('click', () => {
        if (modelSearch) {
            modelSearch.value = '';
            modelSearchClear.style.display = 'none';
            renderModels();
        }
    });

    modelFilterProvider?.addEventListener('change', renderModels);
    modelFilterType?.addEventListener('change', renderModels);
    modelFilterTier?.addEventListener('change', renderModels);
    modelFilterStatus?.addEventListener('change', renderModels);

    toggleAllModels?.addEventListener('change', (e) => {
        if (currentFilteredModels.length === 0) return;
        const isActive = e.target.checked;
        vscode.postMessage({
            command: 'toggleMultipleModels',
            data: { modelNames: currentFilteredModels, isActive }
        });
    });

    function areArraysEqual(a, b) {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    function isEquivalentAgentList(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const x = a[i];
            const y = b[i];
            if (x.id !== y.id) return false;
            if (x.name !== y.name) return false;
            if (x.isActive !== y.isActive) return false;
            if (x.isDefault !== y.isDefault) return false;
            if (x.temperature !== y.temperature) return false;
            if (x.callable !== y.callable) return false;
            if (x.model !== y.model) return false;
            if (x.stepBudget !== y.stepBudget) return false;
            if (!areArraysEqual(x.tools, y.tools)) return false;
            if (!areArraysEqual(x.subagents, y.subagents)) return false;
            if (!areArraysEqual(x.rules, y.rules)) return false;
        }
        return true;
    }

    function isEquivalentRuleList(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const x = a[i];
            const y = b[i];
            if (x.id !== y.id) return false;
            if (x.name !== y.name) return false;
            if (x.scope !== y.scope) return false;
            if (x.isDefault !== y.isDefault) return false;
            if ((x.content || '') !== (y.content || '')) return false;
        }
        return true;
    }

    // ─── MESSAGE HANDLER ─────────────────────────────────────────────────
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'loadAgents':
                agents = msg.agents || [];
                renderAgents();
                break;
            case 'loadRules':
                rules = msg.rules || [];
                renderRules();
                break;
            case 'loadProviders':
                providers = msg.providers || {};
                renderProviders();
                renderModels();
                break;
            case 'loadSettings':
                providerSettings = msg.providerSettings || {};
                inactiveModels = msg.inactiveModels || [];
                renderProviders();
                renderModels();
                break;
        }
    });

    // Pull-refresh: explicitly ask backend for latest data
    function refreshAgents() { vscode.postMessage({ command: 'requestAgents' }); }
    function refreshRules()  { vscode.postMessage({ command: 'requestRules' }); }
    function refreshProviders() { vscode.postMessage({ command: 'requestProviders' }); }
    function refreshSettings() { vscode.postMessage({ command: 'requestSettings' }); }

    // ─── TOOLS LIST ──────────────────────────────────────────────────────
    const ALL_TOOLS = [
        { id: 'list_workspace', name: 'list_workspace', category: 'File' },
        { id: 'read_file_skeleton', name: 'read_file_skeleton', category: 'File' },
        { id: 'read_line_range', name: 'read_line_range', category: 'File' },
        { id: 'find_symbol', name: 'find_symbol', category: 'File' },
        { id: 'search_workspace', name: 'search_workspace', category: 'File' },
        { id: 'get_workspace_problems', name: 'get_workspace_problems', category: 'File' },
        { id: 'chunk_replace', name: 'chunk_replace', category: 'File' },
        { id: 'create_file', name: 'create_file', category: 'File' },
        { id: 'get_workspace_essence', name: 'get_workspace_essence', category: 'File' },
        { id: 'run_command', name: 'run_command', category: 'Sys' },
        { id: 'stop_background_process', name: 'stop_background_process', category: 'Sys' },
        { id: 'list_background_processes', name: 'list_background_processes', category: 'Sys' },
        { id: 'get_background_output', name: 'get_background_output', category: 'Sys' },
        { id: 'web_search', name: 'web_search', category: 'Web' },
        { id: 'scrape_url', name: 'scrape_url', category: 'Web' },
        { id: 'plan_task', name: 'plan_task', category: 'Cognitive' },
        { id: 'update_task_progress', name: 'update_task_progress', category: 'Cognitive' },
        { id: 'verify_completion', name: 'verify_completion', category: 'Cognitive' },
        { id: 'delegate_research', name: 'delegate_research', category: 'Cognitive' },
        { id: 'read_artifact', name: 'read_artifact', category: 'Artifact' },
        { id: 'manage_artifact', name: 'manage_artifact', category: 'Artifact' },
        { id: 'browser_open', name: 'browser_open', category: 'Browser' },
        { id: 'browser_snapshot', name: 'browser_snapshot', category: 'Browser' },
        { id: 'browser_action', name: 'browser_action', category: 'Browser' },
        { id: 'browser_get', name: 'browser_get', category: 'Browser' },
        { id: 'browser_evaluate', name: 'browser_evaluate', category: 'Browser' },
        { id: 'browser_close', name: 'browser_close', category: 'Browser' }
    ];

    const scopeLabelMap = {
        global: 'Global',
        agent: 'Linked',
        disabled: 'Disabled'
    };

    // (Filters are now driven by toolbar select elements, no state variable needed)

    // ═══════════════════════════════════════════════════════════════════════
    // RENDER: AGENTS
    // ═══════════════════════════════════════════════════════════════════════
    function getAgentCardHTML(agent, searchQuery = '') {
        const isReadonly = agent.isDefault;
        const isBuiltin = agent.isDefault || agent.isBuiltinOverride;
        const badgeText = isReadonly ? 'Built-in' : 'Workspace';
        const badgeClass = isReadonly ? 'badge-default' : 'badge-workspace';
        const disabledAttr = ''; // All agents are editable — built-in edits save as workspace overrides

        // Selected model options — only show enabled models (or current model if disabled)
        let agentModelOptions = '<option value="">Default (From Chatbox)</option>';
        if (window.VS_MODELS) {
            try {
                const providers = typeof window.VS_MODELS === 'string' ? JSON.parse(window.VS_MODELS) : window.VS_MODELS;
                Object.keys(providers).forEach(pName => {
                    const p = providers[pName];
                    if (p.models && p.models.text) {
                        p.models.text.forEach(modelName => {
                            const isEnabled = !inactiveModels.includes(modelName);
                            const isCurrent = agent.model === modelName;
                            if (isEnabled || isCurrent) {
                                const selectedAttr = isCurrent ? 'selected' : '';
                                const disabledLabel = !isEnabled ? ' (Disabled)' : '';
                                agentModelOptions += `<option value="${modelName}" ${selectedAttr}>${modelName} (${pName})${disabledLabel}</option>`;
                            }
                        });
                    }
                });
            } catch (e) {
                console.error('Error loading models in Agent Hub UI:', e);
            }
        }

        // 1. Build Tools checklist HTML
        const allowedTools = Array.isArray(agent.tools) ? agent.tools : ALL_TOOLS.map(t => t.id);
        let toolsHtml = '';
        ALL_TOOLS.forEach(tool => {
            const checked = allowedTools.includes(tool.id) ? 'checked' : '';
            toolsHtml += `
                <div class="cap-item">
                    <input type="checkbox" id="tool-${agent.id}-${tool.id}" ${checked} data-agent-id="${agent.id}" data-tool-id="${tool.id}" ${disabledAttr}>
                    <label for="tool-${agent.id}-${tool.id}" title="${tool.id}">${tool.name}</label>
                </div>`;
        });

        // 2. Build Subagents checklist HTML
        const subagentList = agents.filter(a => a.callable && a.id !== agent.id);
        let subagentsHtml = '';
        if (subagentList.length === 0) {
            subagentsHtml = '<span class="hub-text-muted" style="font-size: 11px;">No callable agents</span>';
        } else {
            const allowedSubagents = Array.isArray(agent.subagents)
                ? agent.subagents
                : (agent.id === 'architect' ? ['action', 'browser'] : (agent.id === 'action' ? ['browser'] : []));

            subagentList.forEach(sa => {
                const checked = allowedSubagents.includes(sa.id) ? 'checked' : '';
                subagentsHtml += `
                    <div class="cap-item">
                        <input type="checkbox" id="subagent-${agent.id}-${sa.id}" ${checked} data-agent-id="${agent.id}" data-subagent-id="${sa.id}" ${disabledAttr}>
                        <label for="subagent-${agent.id}-${sa.id}">${escHtml(sa.name)}</label>
                    </div>`;
            });
        }

        // 3. Build Rules checklist HTML
        const agentScopeRules = rules.filter(r => r.scope === 'agent');
        let rulesHtml = '';
        if (agentScopeRules.length === 0) {
            rulesHtml = '<span class="hub-text-muted" style="font-size: 11px;">No agent-scoped rules</span>';
        } else {
            const linkedRules = Array.isArray(agent.rules) ? agent.rules : [];
            agentScopeRules.forEach(r => {
                const checked = linkedRules.includes(r.id) ? 'checked' : '';
                rulesHtml += `
                    <div class="cap-item">
                        <input type="checkbox" id="rule-${agent.id}-${r.id}" ${checked} data-agent-id="${agent.id}" data-rule-id="${r.id}" ${disabledAttr}>
                        <label for="rule-${agent.id}-${r.id}">${escHtml(r.name)}</label>
                    </div>`;
            });
        }

        const isCollapsed = collapsedState[agent.id] !== false;
        const bodyClass = isCollapsed ? 'agent-capabilities-body hidden' : 'agent-capabilities-body';
        const toggleIcon = isCollapsed ? '▶&#xFE0E;' : '▼&#xFE0E;';

        const displayName = highlightText(agent.name, searchQuery);

        return `
            <div class="agent-card-top">
                <div class="agent-card-top-left">
                    <div class="agent-avatar">👤&#xFE0E;</div>
                    <div class="agent-name-wrapper ${isReadonly ? 'readonly' : 'clickable'}" data-agent-id="${agent.id}">
                        <span class="agent-name-display">${displayName}</span>
                        ${!isReadonly ? `<input type="text" class="agent-name-input edit-mode" value="${escHtml(agent.name)}" placeholder="Agent name" data-agent-id="${agent.id}" data-field="name" style="display:none;">` : ''}
                    </div>
                    <span class="agent-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="agent-card-actions">
                    <button class="hub-btn secondary small" onclick="hubEditAgentFile('${agent.id}')">
                        ✏&#xFE0E; Edit Prompt
                    </button>
                    <label class="agent-toggle" title="${agent.isActive ? 'Active' : 'Inactive'}">
                        <input type="checkbox" ${agent.isActive ? 'checked' : ''} data-agent-id="${agent.id}" data-field="active" ${disabledAttr}>
                        <span class="agent-toggle-slider"></span>
                    </label>
                    ${!isReadonly ? `
                    <button class="hub-btn icon-only danger" title="Delete" onclick="hubDeleteAgent('${agent.id}')">
                        ×&#xFE0E;
                    </button>
                    ` : ''}
                </div>
            </div>

            ${searchQuery ? `<div class="search-match-label">${highlightText(agent.name, searchQuery)} <span class="hub-text-muted">· ${highlightText(agent.id, searchQuery)}</span></div>` : ''}

            ${agent.description ? `<div class="agent-description">${highlightText(agent.description, searchQuery)}</div>` : ''}

            ${isBuiltin ? `<div class="agent-builtin-warning">⚠&#xFE0E; Modifying built-in agents is not recommended unless you understand the system behavior. Changes are saved as workspace overrides and may affect core functionality.</div>` : ''}

            <div class="agent-settings-grid">
                <div class="agent-setting-item">
                    <div class="agent-temp-row">
                       <label class="agent-temp-label">Temperature</label>
                       <input type="range" class="agent-temp-slider" min="0" max="1" step="0.01" value="${(agent.temperature ?? 0.15).toFixed(2)}" data-agent-id="${agent.id}" data-field="temperature" ${disabledAttr}>
                       <span class="agent-temp-value">${(agent.temperature ?? 0.15).toFixed(2)}</span>
                    </div>
                </div>

                <div class="agent-setting-item">
                    <label class="agent-checkbox-label">
                        <input type="checkbox" class="agent-callable-checkbox" ${agent.callable ? 'checked' : ''} data-agent-id="${agent.id}" data-field="callable" ${disabledAttr}>
                        <span>Subagent (Callable)</span>
                    </label>
                </div>

                <div class="agent-setting-item ${agent.id === 'token-saver' ? '' : 'subagent-only-field'}" style="display: ${agent.callable || agent.id === 'token-saver' ? 'block' : 'none'};">
                    <label class="agent-temp-label">${agent.id === 'token-saver' ? 'Assigned Model' : 'Subagent Model'}</label>
                    <select class="agent-model-select" data-agent-id="${agent.id}" data-field="model" ${disabledAttr}>
                        ${agentModelOptions}
                    </select>
                </div>

                <div class="agent-setting-item subagent-only-field" style="display: ${agent.callable ? 'block' : 'none'};">
                    <label class="agent-temp-label">Step Budget</label>
                    <input type="number" class="agent-budget-input" min="1" max="100" value="${agent.stepBudget ?? 30}" data-agent-id="${agent.id}" data-field="stepBudget" ${disabledAttr}>
                </div>
            </div>
            
            <div class="agent-capabilities-section">
                <div class="agent-capabilities-header" onclick="hubToggleCapabilities('${agent.id}')">
                    <span>Capabilities (Tools, Subagents, Rules)</span>
                    <span class="cap-toggle-icon" id="cap-toggle-${agent.id}">${toggleIcon}</span>
                </div>
                <div class="${bodyClass}" id="cap-body-${agent.id}">
                    <div class="cap-column">
                        <h4>Tools</h4>
                        <div class="cap-checkbox-list">
                            ${toolsHtml}
                        </div>
                    </div>
                    <div class="cap-column">
                        <h4>Subagents</h4>
                        <div class="cap-checkbox-list">
                            ${subagentsHtml}
                        </div>
                    </div>
                    <div class="cap-column">
                        <h4>Linked Rules</h4>
                        <div class="cap-checkbox-list">
                            ${rulesHtml}
                        </div>
                    </div>
                </div>
            </div>`;
    }

    function bindAgentCardEvents(card) {
        const nameWrapper = card.querySelector('.agent-name-wrapper');
        const nameDisplay = card.querySelector('.agent-name-display');
        const nameInput = card.querySelector('.agent-name-input');

        if (nameWrapper && nameInput && nameDisplay) {
            nameWrapper.addEventListener('click', (e) => {
                // If clicking inside the input itself, don't trigger wrapper click again
                if (e.target === nameInput) return;
                if (nameWrapper.classList.contains('readonly')) return;

                nameDisplay.style.display = 'none';
                nameInput.style.display = 'inline-block';
                nameInput.focus();
                nameInput.select();
            });

            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    nameInput.blur();
                }
                if (e.key === 'Escape') {
                    nameInput.value = nameDisplay.textContent; // revert
                    nameInput.blur();
                }
            });

            nameInput.addEventListener('blur', (e) => {
                nameDisplay.style.display = 'inline-block';
                nameInput.style.display = 'none';

                const agent = agents.find(a => a.id === e.target.dataset.agentId);
                if (agent && agent.name !== e.target.value) {
                    agent.name = e.target.value;
                    renderAgents();
                    vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'name', value: e.target.value } });
                }
            });
        }

        const activeCb = card.querySelector('.agent-toggle input');
        if (activeCb) {
            activeCb.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'isActive', value: e.target.checked } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.isActive = e.target.checked;
                const toggleLabel = card.querySelector('.agent-toggle');
                if (toggleLabel) toggleLabel.title = e.target.checked ? 'Active' : 'Inactive';
                if (activeCountEl) activeCountEl.textContent = String(agents.filter(a => a.isActive).length);
            });
        }

        const tempSlider = card.querySelector('.agent-temp-slider');
        const tempValEl = card.querySelector('.agent-temp-value');
        if (tempSlider) {
            tempSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value).toFixed(2);
                if (tempValEl) tempValEl.textContent = val;
            });
            tempSlider.addEventListener('change', (e) => {
                let val = parseFloat(e.target.value);
                if (isNaN(val)) val = 0.15;
                if (val < 0) val = 0;
                if (val > 1) val = 1;
                val = parseFloat(val.toFixed(2));

                const agent = agents.find(a => a.id === e.target.dataset.agentId);
                if (agent && agent.temperature !== val) {
                    agent.temperature = val;
                    vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'temperature', value: val } });
                }
            });
        }

        const callableCb = card.querySelector('.agent-callable-checkbox');
        if (callableCb) {
            callableCb.addEventListener('change', (e) => {
                const id = e.target.dataset.agentId;
                const subagentFields = card.querySelectorAll('.subagent-only-field');
                subagentFields.forEach(field => {
                    field.style.display = e.target.checked ? 'block' : 'none';
                });
                vscode.postMessage({ command: 'updateAgent', data: { id, field: 'callable', value: e.target.checked } });
                const a = agents.find(a => a.id === id);
                if (a) a.callable = e.target.checked;
            });
        }

        const modelSelect = card.querySelector('.agent-model-select');
        if (modelSelect) {
            modelSelect.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'model', value: e.target.value } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.model = e.target.value;
            });
        }

        const budgetInput = card.querySelector('.agent-budget-input');
        if (budgetInput) {
            budgetInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') budgetInput.blur();
            });
            budgetInput.addEventListener('blur', (e) => {
                const val = parseInt(e.target.value, 10) || 30;
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'stepBudget', value: val } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.stepBudget = val;
            });
        }

        // Handle tools checkboxes
        card.querySelectorAll('.cap-column input[data-tool-id]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const agentId = e.target.dataset.agentId;
                const agent = agents.find(a => a.id === agentId);
                if (!agent) return;
                
                const checkedCbs = card.querySelectorAll(`.cap-column input[data-tool-id]:checked`);
                const checkedTools = Array.from(checkedCbs).map(c => c.dataset.toolId);
                agent.tools = checkedTools;
                
                vscode.postMessage({ command: 'updateAgent', data: { id: agentId, field: 'tools', value: checkedTools } });
            });
        });

        // Handle subagents checkboxes
        card.querySelectorAll('.cap-column input[data-subagent-id]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const agentId = e.target.dataset.agentId;
                const agent = agents.find(a => a.id === agentId);
                if (!agent) return;
                
                const checkedCbs = card.querySelectorAll(`.cap-column input[data-subagent-id]:checked`);
                const checkedSubagents = Array.from(checkedCbs).map(c => c.dataset.subagentId);
                agent.subagents = checkedSubagents;
                
                vscode.postMessage({ command: 'updateAgent', data: { id: agentId, field: 'subagents', value: checkedSubagents } });
            });
        });

        // Handle rules checkboxes
        card.querySelectorAll('.cap-column input[data-rule-id]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const agentId = e.target.dataset.agentId;
                const agent = agents.find(a => a.id === agentId);
                if (!agent) return;
                
                const checkedCbs = card.querySelectorAll(`.cap-column input[data-rule-id]:checked`);
                const checkedRules = Array.from(checkedCbs).map(c => c.dataset.ruleId);
                agent.rules = checkedRules;
                
                vscode.postMessage({ command: 'updateAgent', data: { id: agentId, field: 'rules', value: checkedRules } });
            });
        });
    }

    function renderAgents() {
        if (!agentsList) return;

        const searchQuery = (agentSearch?.value || '').trim().toLowerCase();
        const filterOrigin = agentFilterOrigin?.value || 'all';
        const filterStatus = agentFilterStatus?.value || 'all';
        const filterType = agentFilterType?.value || 'all';

        const filtered = agents.filter(agent => {
            if (searchQuery) {
                const nameMatch = (agent.name || '').toLowerCase().includes(searchQuery);
                const descMatch = (agent.description || '').toLowerCase().includes(searchQuery);
                const idMatch = (agent.id || '').toLowerCase().includes(searchQuery);
                if (!nameMatch && !descMatch && !idMatch) return false;
            }
            if (filterOrigin !== 'all') {
                const isBuiltin = agent.isDefault || agent.isBuiltinOverride;
                if (filterOrigin === 'builtin' && !isBuiltin) return false;
                if (filterOrigin === 'workspace' && isBuiltin) return false;
            }
            if (filterStatus !== 'all') {
                if (filterStatus === 'active' && !agent.isActive) return false;
                if (filterStatus === 'inactive' && agent.isActive) return false;
            }
            if (filterType !== 'all') {
                if (filterType === 'subagent' && !agent.callable) return false;
                if (filterType === 'core' && agent.callable) return false;
            }
            return true;
        });

        if (agentCountEl) agentCountEl.textContent = String(filtered.length);
        if (activeCountEl) activeCountEl.textContent = String(filtered.filter(a => a.isActive).length);

        if (filtered.length === 0) {
            agentsList.innerHTML = '';
            if (agentsEmpty) {
                agentsList.appendChild(agentsEmpty);
                agentsEmpty.style.display = 'flex';
            }
            return;
        }

        if (agentsEmpty) agentsEmpty.style.display = 'none';

        const existingCards = Array.from(agentsList.querySelectorAll('.agent-card'));
        const cardMap = new Map(existingCards.map(el => [el.getAttribute('data-agent-id'), el]));

        for (let i = 0; i < filtered.length; i++) {
            const agent = filtered[i];
            let card = cardMap.get(agent.id);
            if (!card) {
                card = document.createElement('div');
                card.className = `agent-card ${agent.isDefault ? 'readonly' : ''}`;
                card.setAttribute('data-agent-id', agent.id);
                card.innerHTML = getAgentCardHTML(agent, searchQuery);
                bindAgentCardEvents(card);
            } else {
                // If isDefault changed (built-in overridden by workspace or workspace deleted), full rebuild
                const cardIsDefault = card.classList.contains('readonly');
                if (cardIsDefault !== !!agent.isDefault) {
                    card.className = `agent-card ${agent.isDefault ? 'readonly' : ''}`;
                    card.innerHTML = getAgentCardHTML(agent, searchQuery);
                    bindAgentCardEvents(card);
                }
                // If capabilities structure changed, rebuild
                else {
                const currentSubagentCbsCount = card.querySelectorAll('.cap-column input[data-subagent-id]').length;
                const expectedSubagentCount = agents.filter(a => a.callable && a.id !== agent.id).length;
                
                const currentRuleCbsCount = card.querySelectorAll('.cap-column input[data-rule-id]').length;
                const expectedRuleCount = rules.filter(r => r.scope === 'agent').length;
                
                if (currentSubagentCbsCount !== expectedSubagentCount || currentRuleCbsCount !== expectedRuleCount) {
                    card.innerHTML = getAgentCardHTML(agent, searchQuery);
                    bindAgentCardEvents(card);
                } else {
                    // Update elements in-place if not currently focused
                    const nameInput = card.querySelector('.agent-name-input');
                    if (nameInput && document.activeElement !== nameInput && nameInput.value !== agent.name) {
                        nameInput.value = agent.name;
                    }
                    const nameDisplay = card.querySelector('.agent-name-display');
                    if (nameDisplay) {
                        nameDisplay.innerHTML = highlightText(agent.name, searchQuery);
                    }

                    // Update description since it has highlighting
                    const descEl = card.querySelector('.agent-description');
                    if (descEl) {
                        descEl.innerHTML = agent.description ? highlightText(agent.description, searchQuery) : '';
                    }

                    const activeCheckbox = card.querySelector('.agent-toggle input');
                    if (activeCheckbox && activeCheckbox.checked !== agent.isActive) {
                        activeCheckbox.checked = agent.isActive;
                        const toggleLabel = card.querySelector('.agent-toggle');
                        if (toggleLabel) toggleLabel.title = agent.isActive ? 'Active' : 'Inactive';
                    }

                    const tempSlider = card.querySelector('.agent-temp-slider');
                    if (tempSlider && document.activeElement !== tempSlider) {
                        const targetVal = agent.temperature ?? 0.15;
                        if (parseFloat(tempSlider.value) !== targetVal) {
                            tempSlider.value = targetVal.toFixed(2);
                            const tempValEl = card.querySelector('.agent-temp-value');
                            if (tempValEl) tempValEl.textContent = targetVal.toFixed(2);
                        }
                    }

                    const callableCheckbox = card.querySelector('.agent-callable-checkbox');
                    if (callableCheckbox && callableCheckbox.checked !== agent.callable) {
                        callableCheckbox.checked = agent.callable;
                        const subagentFields = card.querySelectorAll('.subagent-only-field');
                        subagentFields.forEach(field => {
                            field.style.display = agent.callable ? 'block' : 'none';
                        });
                    }

                    const modelSelect = card.querySelector('.agent-model-select');
                    if (modelSelect && document.activeElement !== modelSelect) {
                        let agentModelOptions = '<option value="">Default (From Chatbox)</option>';
                        if (window.VS_MODELS) {
                            try {
                                const providers = typeof window.VS_MODELS === 'string' ? JSON.parse(window.VS_MODELS) : window.VS_MODELS;
                                Object.keys(providers).forEach(pName => {
                                    const p = providers[pName];
                                    if (p.models && p.models.text) {
                                        p.models.text.forEach(modelName => {
                                            const isEnabled = !inactiveModels.includes(modelName);
                                            const isCurrent = agent.model === modelName;
                                            if (isEnabled || isCurrent) {
                                                const selectedAttr = isCurrent ? 'selected' : '';
                                                const disabledLabel = !isEnabled ? ' (Disabled)' : '';
                                                agentModelOptions += `<option value="${modelName}" ${selectedAttr}>${modelName} (${pName})${disabledLabel}</option>`;
                                            }
                                        });
                                    }
                                });
                            } catch (e) {
                                console.error('Error rebuilding options in-place:', e);
                            }
                        }
                        if (modelSelect.innerHTML !== agentModelOptions) {
                            modelSelect.innerHTML = agentModelOptions;
                        }
                    }

                    const budgetInput = card.querySelector('.agent-budget-input');
                    if (budgetInput && document.activeElement !== budgetInput) {
                        const targetVal = agent.stepBudget ?? 30;
                        if (parseInt(budgetInput.value, 10) !== targetVal) {
                            budgetInput.value = String(targetVal);
                        }
                    }

                    // Update checkboxes in-place
                    const allowedTools = Array.isArray(agent.tools) ? agent.tools : ALL_TOOLS.map(t => t.id);
                    card.querySelectorAll('.cap-column input[data-tool-id]').forEach(cb => {
                        const tid = cb.dataset.toolId;
                        const shouldBeChecked = allowedTools.includes(tid);
                        if (cb.checked !== shouldBeChecked) {
                            cb.checked = shouldBeChecked;
                        }
                    });

                    const allowedSubagents = Array.isArray(agent.subagents)
                        ? agent.subagents
                        : (agent.id === 'architect' ? ['action', 'browser'] : (agent.id === 'action' ? ['browser'] : []));
                    card.querySelectorAll('.cap-column input[data-subagent-id]').forEach(cb => {
                        const sid = cb.dataset.subagentId;
                        const shouldBeChecked = allowedSubagents.includes(sid);
                        if (cb.checked !== shouldBeChecked) {
                            cb.checked = shouldBeChecked;
                        }
                    });

                    const linkedRules = Array.isArray(agent.rules) ? agent.rules : [];
                    card.querySelectorAll('.cap-column input[data-rule-id]').forEach(cb => {
                        const rid = cb.dataset.ruleId;
                        const shouldBeChecked = linkedRules.includes(rid);
                        if (cb.checked !== shouldBeChecked) {
                            cb.checked = shouldBeChecked;
                        }
                    });
                }
                } // end capabilities else
            }

            // Enforce order
            const currentChild = agentsList.children[i];
            if (currentChild !== card) {
                agentsList.insertBefore(card, currentChild || null);
            }
        }

        // Remove leftover cards
        const newIds = new Set(filtered.map(a => a.id));
        for (const card of existingCards) {
            const id = card.getAttribute('data-agent-id');
            if (id && !newIds.has(id)) {
                card.remove();
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RENDER: RULES
    // ═══════════════════════════════════════════════════════════════════════
    function getRuleCardHTML(rule, searchQuery = '') {
        const isReadonly = rule.isDefault;
        const badgeText = isReadonly ? 'Built-in' : 'Workspace';
        const badgeClass = isReadonly ? 'badge-default' : 'badge-workspace';
        const disabledAttr = isReadonly ? 'disabled' : '';
        const charCount = rule.content ? rule.content.length : 0;
        const scopeLabel = scopeLabelMap[rule.scope] || rule.scope;

        const displayName = highlightText(rule.name, searchQuery);

        return `
            <div class="rule-card-header">
                <div class="rule-card-name-row">
                    <div class="agent-avatar">▤&#xFE0E;</div>
                    <div class="agent-name-wrapper rule-name-wrapper ${isReadonly ? 'readonly' : 'clickable'}" data-rule-id="${rule.id}">
                        <span class="agent-name-display rule-name-display">${displayName}</span>
                        ${!isReadonly ? `<input type="text" class="agent-name-input rule-name-input edit-mode" value="${escHtml(rule.name)}" placeholder="Rule name" data-rule-id="${rule.id}" data-field="name" style="display:none;">` : ''}
                    </div>
                    <span class="agent-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="rule-card-meta-row">
                    <div class="rule-card-meta-left">
                        <div id="rule-scope-${rule.id}" class="tool-status-pill clickable state-${rule.scope}" onclick="hubCycleRuleScope('${rule.id}')" title="Click to cycle: Global → Linked → Disabled">
                            <span class="cycle-icon">⟳&#xFE0E;</span>
                            <span class="status-label">${scopeLabel}</span>
                        </div>
                        <span class="rule-char-count">${charCount} / 2000</span>
                    </div>
                    <div class="rule-card-actions">
                        <button class="hub-btn secondary small" onclick="hubEditRuleFile('${rule.id}')">
                            ✎&#xFE0E; Edit
                        </button>
                        ${!isReadonly ? `
                        <button class="hub-btn icon-only danger" title="Delete" onclick="hubDeleteRule('${rule.id}')">
                            ×
                        </button>
                        ` : ''}
                    </div>
                </div>
            </div>`;
    }

    function bindRuleCardEvents(card) {
        const nameWrapper = card.querySelector('.rule-name-wrapper');
        const nameDisplay = card.querySelector('.rule-name-display');
        const nameInput = card.querySelector('.rule-name-input');

        if (nameWrapper && nameInput && nameDisplay) {
            nameWrapper.addEventListener('click', (e) => {
                if (e.target === nameInput) return;
                if (nameWrapper.classList.contains('readonly')) return;

                nameDisplay.style.display = 'none';
                nameInput.style.display = 'inline-block';
                nameInput.focus();
                nameInput.select();
            });

            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    nameInput.blur();
                }
                if (e.key === 'Escape') {
                    nameInput.value = nameDisplay.textContent; // revert
                    nameInput.blur();
                }
            });

            nameInput.addEventListener('blur', (e) => {
                nameDisplay.style.display = 'inline-block';
                nameInput.style.display = 'none';

                const rule = rules.find(r => r.id === e.target.dataset.ruleId);
                if (rule && rule.name !== e.target.value) {
                    rule.name = e.target.value;
                    renderRules();
                    vscode.postMessage({ command: 'updateRule', data: { id: e.target.dataset.ruleId, field: 'name', value: e.target.value } });
                }
            });
        }
    }

    function renderRules() {
        if (!rulesList) return;

        const searchQuery = (ruleSearch?.value || '').trim().toLowerCase();
        const filterOrigin = ruleFilterOrigin?.value || 'all';
        const filterScope = ruleFilterScope?.value || 'all';

        const filtered = rules.filter(rule => {
            if (searchQuery) {
                const nameMatch = (rule.name || '').toLowerCase().includes(searchQuery);
                const contentMatch = (rule.content || '').toLowerCase().includes(searchQuery);
                const idMatch = (rule.id || '').toLowerCase().includes(searchQuery);
                if (!nameMatch && !contentMatch && !idMatch) return false;
            }
            if (filterOrigin !== 'all') {
                if (filterOrigin === 'builtin' && !rule.isDefault) return false;
                if (filterOrigin === 'workspace' && rule.isDefault) return false;
            }
            if (filterScope !== 'all') {
                if (filterScope !== rule.scope) return false;
            }
            return true;
        });

        if (ruleCountEl) ruleCountEl.textContent = String(filtered.length);

        if (filtered.length === 0) {
            rulesList.innerHTML = '';
            if (rulesEmpty) {
                rulesList.appendChild(rulesEmpty);
                rulesEmpty.style.display = 'flex';
            }
            return;
        }

        if (rulesEmpty) rulesEmpty.style.display = 'none';

        const existingCards = Array.from(rulesList.querySelectorAll('.agent-card'));
        const cardMap = new Map(existingCards.map(el => [el.getAttribute('data-rule-id'), el]));

        for (let i = 0; i < filtered.length; i++) {
            const rule = filtered[i];
            let card = cardMap.get(rule.id);
            if (!card) {
                card = document.createElement('div');
                card.className = `agent-card ${rule.isDefault ? 'readonly' : ''}`;
                card.setAttribute('data-rule-id', rule.id);
                card.innerHTML = getRuleCardHTML(rule, searchQuery);
                bindRuleCardEvents(card);
            } else {
                // If isDefault changed (built-in → workspace override or vice versa), full rebuild
                const cardIsDefault = card.classList.contains('readonly');
                if (cardIsDefault !== !!rule.isDefault) {
                    card.className = `agent-card ${rule.isDefault ? 'readonly' : ''}`;
                    card.innerHTML = getRuleCardHTML(rule, searchQuery);
                    bindRuleCardEvents(card);
                } else {
                    const nameInput = card.querySelector('.rule-name-input');
                    if (nameInput && document.activeElement !== nameInput && nameInput.value !== rule.name) {
                        nameInput.value = rule.name;
                    }
                    const charBadge = card.querySelector('.rule-char-count');
                    if (charBadge) {
                        charBadge.textContent = `${rule.content ? rule.content.length : 0} / 2000`;
                    }
                    const scopePill = card.querySelector(`.tool-status-pill`);
                    if (scopePill && !scopePill.classList.contains(`state-${rule.scope}`)) {
                        scopePill.className = `tool-status-pill clickable state-${rule.scope}`;
                        scopePill.querySelector('.status-label').textContent = scopeLabelMap[rule.scope] || rule.scope;
                    }
                    const nameDisplay = card.querySelector('.rule-name-display');
                    if (nameDisplay) {
                        nameDisplay.innerHTML = highlightText(rule.name, searchQuery);
                    }
                }
            }

            // Enforce order
            const currentChild = rulesList.children[i];
            if (currentChild !== card) {
                rulesList.insertBefore(card, currentChild || null);
            }
        }

        // Remove cards not in filtered set
        const filteredIds = new Set(filtered.map(r => r.id));
        for (const card of existingCards) {
            const id = card.getAttribute('data-rule-id');
            if (id && !filteredIds.has(id)) {
                card.remove();
            }
        }
    }

    // ─── RENDER PROVIDERS ────────────────────────────────────────────────
    function renderProviders() {
        if (!providersList) return;

        const searchQuery = (providerSearch?.value || '').trim().toLowerCase();
        const filterOrigin = providerFilterOrigin?.value || 'all';

        const filtered = Object.values(providers).filter(p => {
            if (searchQuery) {
                const nameMatch = (p.name || '').toLowerCase().includes(searchQuery);
                const idMatch = (p.id || '').toLowerCase().includes(searchQuery);
                const urlMatch = (p.baseUrl || '').toLowerCase().includes(searchQuery);
                if (!nameMatch && !idMatch && !urlMatch) return false;
            }
            if (filterOrigin !== 'all') {
                if (filterOrigin === 'builtin' && !p.isDefault) return false;
                if (filterOrigin === 'custom' && p.isDefault) return false;
            }
            return true;
        });

        if (providerCountEl) providerCountEl.textContent = String(filtered.length);

        if (filtered.length === 0) {
            providersList.innerHTML = '';
            if (providersEmpty) {
                providersList.appendChild(providersEmpty);
                providersEmpty.style.display = 'flex';
            }
            return;
        }

        if (providersEmpty) providersEmpty.style.display = 'none';
        providersList.innerHTML = '';

        for (const p of filtered) {
            const card = document.createElement('div');
            card.className = `agent-card ${p.isDefault ? 'readonly' : ''}`;
            card.setAttribute('data-provider-id', p.id);

            const textCount = p.models?.text?.length || 0;
            const imageCount = p.models?.image?.length || 0;
            const ps = providerSettings[p.name] || {};
            const currentKey = ps.apiKey || '';
            const displayName = highlightText(p.name, searchQuery);

            card.innerHTML = `
                <div class="agent-card-header">
                    <div class="agent-card-left">
                        <span class="agent-badge ${p.isDefault ? 'badge-default' : 'badge-workspace'}">${p.isDefault ? 'Built-in' : 'Workspace'}</span>
                        <span class="agent-name-display">${displayName}</span>
                    </div>
                    <div class="agent-card-actions">
                        <button class="hub-btn icon-only" title="${p.isDefault ? 'Override in workspace' : 'Edit YAML'}" onclick="hubEditProviderFile('${p.id}')">✎&#xFE0E;</button>
                        ${!p.isDefault ? `<button class="hub-btn icon-only danger" title="Delete" onclick="hubDeleteProvider('${p.id}')">×</button>` : ''}
                    </div>
                </div>
                <div class="provider-details">
                    <span title="Base URL" style="word-break:break-all;">◐&#xFE0E; ${escHtml(p.baseUrl || '(default)')}</span>
                    <span style="margin-left:auto;">${textCount} text · ${imageCount} image</span>
                </div>
                <div class="provider-config">
                    <label>API Key</label>
                    <div class="provider-key-wrapper">
                        <input type="password" placeholder="sk-..." value="${escHtml(currentKey)}" data-provider="${escHtml(p.name)}" onchange="hubUpdateProviderKey(this)">
                        <button class="provider-eye-btn" onclick="hubToggleKeyVisibility(this)" title="Toggle visibility" type="button">◉&#xFE0E;</button>
                    </div>
                </div>`;

            providersList.appendChild(card);
        }
    }
    // ─── RENDER MODELS ───────────────────────────────────────────────────
    function renderModels() {
        if (!modelsList) return;

        // Build flat model list from all providers
        const allModels = [];
        for (const [provName, p] of Object.entries(providers)) {
            const textModels = p.models?.text || [];
            const imageModels = p.models?.image || [];
            const allModelNames = new Set([...textModels, ...imageModels]);

            for (const modelName of allModelNames) {
                const types = [];
                if (textModels.includes(modelName)) types.push('text');
                if (imageModels.includes(modelName)) types.push('image');
                const tier = p.tiers?.[modelName] || 'mid';
                const reasoning = (p.supportsReasoning || []).includes(modelName);
                allModels.push({ modelName, providerName: provName, providerId: p.id, types, tier, reasoning, isDefault: p.isDefault });
            }
        }

        // Dynamically populate Provider dropdown
        if (modelFilterProvider) {
            const currentSelected = modelFilterProvider.value || 'all';
            const providerNames = Object.keys(providers);
            const currentOptions = Array.from(modelFilterProvider.options).map(o => o.value);
            const neededOptions = ['all', ...providerNames];

            const changed = currentOptions.length !== neededOptions.length || 
                            neededOptions.some((val, idx) => currentOptions[idx] !== val);

            if (changed) {
                modelFilterProvider.innerHTML = '<option value="all">All Providers</option>' +
                    providerNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
                modelFilterProvider.value = providerNames.includes(currentSelected) ? currentSelected : 'all';
            }
        }

        // Read active filters
        const searchQuery = (modelSearch?.value || '').trim().toLowerCase();
        const filterProvider = modelFilterProvider?.value || 'all';
        const filterType = modelFilterType?.value || 'all';
        const filterTier = modelFilterTier?.value || 'all';
        const filterStatus = modelFilterStatus?.value || 'all';

        // Apply filters
        const filtered = allModels.filter(m => {
            // Search query
            if (searchQuery) {
                const nameMatch = m.modelName.toLowerCase().includes(searchQuery);
                const providerMatch = m.providerName.toLowerCase().includes(searchQuery);
                if (!nameMatch && !providerMatch) return false;
            }

            // Provider
            if (filterProvider !== 'all' && m.providerName !== filterProvider) {
                return false;
            }

            // Type
            if (filterType !== 'all') {
                if (filterType === 'reasoning') {
                    if (!m.reasoning) return false;
                } else {
                    if (!m.types.includes(filterType)) return false;
                }
            }

            // Tier
            if (filterTier !== 'all' && m.tier !== filterTier) {
                return false;
            }

            // Status
            if (filterStatus !== 'all') {
                const isActive = !inactiveModels.includes(m.modelName);
                if (filterStatus === 'active' && !isActive) return false;
                if (filterStatus === 'inactive' && isActive) return false;
            }

            return true;
        });

        currentFilteredModels = filtered.map(m => m.modelName);

        // Update the master toggle checkbox checked state
        if (toggleAllModels) {
            if (currentFilteredModels.length === 0) {
                toggleAllModels.checked = false;
                toggleAllModels.disabled = true;
            } else {
                toggleAllModels.disabled = false;
                toggleAllModels.checked = currentFilteredModels.every(name => !inactiveModels.includes(name));
            }
        }

        if (modelCountEl) modelCountEl.textContent = String(filtered.length);

        if (filtered.length === 0) {
            modelsList.innerHTML = '';
            if (modelsEmpty) {
                modelsList.appendChild(modelsEmpty);
                modelsEmpty.style.display = 'flex';
            }
            return;
        }

        if (modelsEmpty) modelsEmpty.style.display = 'none';
        modelsList.innerHTML = '';

        for (const m of filtered) {
            const isActive = !inactiveModels.includes(m.modelName);
            const card = document.createElement('div');
            card.className = `agent-card model-row${!isActive ? ' inactive' : ''}`;
            card.setAttribute('data-model-name', m.modelName);

            const tierText = m.tier ? ` (${m.tier})` : '';
            const reasoningText = m.reasoning ? ' \u00B7 reasoning' : '';

            card.innerHTML = `
                <span class="model-col model-col-name">${highlightText(m.modelName, searchQuery)}<span class="model-tier-label">${tierText}</span></span>
                <span class="model-col model-col-provider"><span class="agent-badge badge-default">${highlightText(m.providerName, searchQuery)}</span></span>
                <span class="model-col model-col-type">${m.types.join(' \u00B7 ')}${reasoningText}</span>
                <span class="model-col model-col-actions">
                    <label class="model-toggle" title="${isActive ? 'Visible in chat' : 'Hidden from chat'}">
                        <input type="checkbox" ${isActive ? 'checked' : ''} onchange="hubToggleModel('${escHtml(m.modelName)}', this.checked)">
                        <span class="model-toggle-slider"></span>
                    </label>
                </span>`;

            modelsList.appendChild(card);
        }
    }
    // ─── HELPERS ─────────────────────────────────────────────────────────
    function escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function highlightText(text, query) {
        const escaped = escHtml(text);
        if (!query) return escaped;
        const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`(${escapedQuery})`, 'gi');
        return escaped.replace(regex, '<span class="highlight-text">$1</span>');
    }

    // ─── ACTIONS ─────────────────────────────────────────────────────────
    window.hubEditAgentFile = function (id) {
        vscode.postMessage({ command: 'editAgentFile', data: { id } });
    };

    window.hubEditRuleFile = function (id) {
        vscode.postMessage({ command: 'editRuleFile', data: { id } });
    };

    window.hubDeleteAgent = async function (id) {
        const agent = agents.find(a => a.id === id);
        const name = agent ? agent.name : 'this agent';
        const confirmed = await showModal('Delete Agent', `Are you sure you want to delete ${name}? This will permanently delete its workspace markdown file.`);
        if (confirmed) {
            // Optimistically remove from local state immediately
            agents = agents.filter(a => a.id !== id);
            renderAgents();
            // Tell backend, then pull fresh state to confirm
            vscode.postMessage({ command: 'deleteAgent', data: { id } });
            setTimeout(refreshAgents, 300);
        }
    };

    window.hubDeleteRule = async function (id) {
        const rule = rules.find(r => r.id === id);
        const name = rule ? rule.name : 'this rule';
        const confirmed = await showModal('Delete Rule', `Are you sure you want to delete "${name}"? This will permanently delete its workspace markdown file.`);
        if (confirmed) {
            // Optimistically remove from local state immediately
            rules = rules.filter(r => r.id !== id);
            renderRules();
            // Tell backend, then pull fresh state to confirm
            vscode.postMessage({ command: 'deleteRule', data: { id } });
            setTimeout(refreshRules, 300);
        }
    };

    // ─── PROVIDER ACTIONS ────────────────────────────────────────────────
    window.hubEditProviderFile = function (id) {
        vscode.postMessage({ command: 'editProviderFile', data: { id } });
    };

    window.hubDeleteProvider = async function (id) {
        const pArr = Object.values(providers);
        const p = pArr.find(x => x.id === id);
        const name = p ? p.name : 'this provider';
        const confirmed = await showModal('Delete Provider', `Are you sure you want to delete "${name}"? This will permanently delete its workspace YAML file.`);
        if (confirmed) {
            // Optimistic remove
            const updated = {};
            for (const [k, v] of Object.entries(providers)) {
                if (v.id !== id) updated[k] = v;
            }
            providers = updated;
            renderProviders();
            renderModels();
            vscode.postMessage({ command: 'deleteProvider', data: { id } });
            setTimeout(refreshProviders, 300);
        }
    };

    window.hubRemoveModel = async function (providerId, modelName) {
        const confirmed = await showModal('Remove Model', `Remove "${modelName}" from this provider?`);
        if (confirmed) {
            vscode.postMessage({ command: 'removeModel', data: { providerId, modelName } });
            setTimeout(refreshProviders, 300);
        }
    };

    window.hubUpdateProviderKey = function (inputEl) {
        const providerName = inputEl.getAttribute('data-provider');
        const apiKey = inputEl.value || '';
        vscode.postMessage({ command: 'updateProviderApiKey', data: { providerName, apiKey } });
    };

    window.hubToggleKeyVisibility = function (btnEl) {
        const input = btnEl.previousElementSibling;
        if (input) {
            if (input.type === 'password') {
                input.type = 'text';
            } else {
                input.type = 'password';
            }
        }
    };

    window.hubToggleModel = function (modelName, isActive) {
        vscode.postMessage({ command: 'toggleModelActive', data: { modelName, isActive } });
    };

    window.hubToggleCapabilities = function (id) {
        const body = document.getElementById(`cap-body-${id}`);
        const icon = document.getElementById(`cap-toggle-${id}`);
        if (body && icon) {
            const isCollapsed = body.classList.toggle('hidden');
            collapsedState[id] = !isCollapsed;
            icon.innerHTML = isCollapsed ? '▶&#xFE0E;' : '▼&#xFE0E;';
        }
    };

    window.hubCycleRuleScope = function (id) {
        const rule = rules.find(r => r.id === id);
        if (!rule) return;

        const states = ['global', 'agent', 'disabled'];
        const idx = states.indexOf(rule.scope);
        const nextVal = states[(idx + 1) % states.length];

        vscode.postMessage({ command: 'updateRule', data: { id, field: 'scope', value: nextVal } });
        rule.scope = nextVal;

        // Trigger micro-animation
        const pill = document.getElementById(`rule-scope-${id}`);
        if (pill) {
            pill.classList.remove('cycling');
            void pill.offsetWidth; // trigger reflow
            pill.classList.add('cycling');

            pill.className = `tool-status-pill clickable state-${nextVal}`;
            pill.querySelector('.status-label').textContent = scopeLabelMap[nextVal] || nextVal;
        }

        // Pull fresh state shortly after to confirm backend write
        setTimeout(refreshRules, 400);
    };

    // ─── SAVE ON CLOSE ───────────────────────────────────────────────────
    function triggerSaveOnClose() {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
    }
    window.addEventListener('beforeunload', triggerSaveOnClose);
    window.addEventListener('blur', triggerSaveOnClose);

    // ─── VISIBILITY REFRESH ──────────────────────────────────────────────
    // When the user switches back to this panel, pull fresh data.
    // postMessage from extension to webview is dropped when the panel
    // is not the active tab, so we must re-request on focus.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            refreshAgents();
            refreshRules();
            refreshProviders();
            refreshSettings();
        }
    });

    // ─── INIT ────────────────────────────────────────────────────────────
    vscode.postMessage({ command: 'requestAgents' });
    vscode.postMessage({ command: 'requestRules' });
    vscode.postMessage({ command: 'requestProviders' });
    vscode.postMessage({ command: 'requestSettings' });
})();
