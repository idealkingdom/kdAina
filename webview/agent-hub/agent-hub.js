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

    // ─── DOM REFS ────────────────────────────────────────────────────────
    const btnAddAgent = document.getElementById('btn-add-agent');
    const agentCountEl = document.getElementById('agent-count');
    const activeCountEl = document.getElementById('active-agent-count');
    const agentsList = document.getElementById('agents-list');
    const agentsEmpty = document.getElementById('agents-empty');

    const btnAddRule = document.getElementById('btn-add-rule');
    const ruleCountEl = document.getElementById('rule-count');
    const globalRuleCountEl = document.getElementById('global-rule-count');
    const rulesList = document.getElementById('rules-list');
    const rulesEmpty = document.getElementById('rules-empty');

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
        });
    });

    // ─── RULES: ADD ──────────────────────────────────────────────────────
    btnAddRule?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addRule' });
    });

    // ─── AGENTS: ADD ─────────────────────────────────────────────────────
    btnAddAgent?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addAgent' });
    });

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
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // RENDER: AGENTS
    // ═══════════════════════════════════════════════════════════════════════
    function renderAgents() {
        if (!agentsList) return;

        if (agentCountEl) agentCountEl.textContent = String(agents.length);
        if (activeCountEl) activeCountEl.textContent = String(agents.filter(a => a.isActive).length);

        if (agents.length === 0) {
            agentsList.innerHTML = '';
            if (agentsEmpty) {
                agentsList.appendChild(agentsEmpty);
                agentsEmpty.style.display = 'flex';
            }
            return;
        }

        if (agentsEmpty) agentsEmpty.style.display = 'none';

        // Parse models string
        let modelOptionsHtml = '<option value="">Default (From Chatbox)</option>';
        if (window.VS_MODELS) {
            try {
                const providers = typeof window.VS_MODELS === 'string' ? JSON.parse(window.VS_MODELS) : window.VS_MODELS;
                Object.keys(providers).forEach(pName => {
                    const p = providers[pName];
                    if (p.models && p.models.text) {
                        p.models.text.forEach(modelName => {
                            modelOptionsHtml += `<option value="${modelName}">${modelName} (${pName})</option>`;
                        });
                    }
                });
            } catch (e) {
                console.error('Error loading models in Agent Hub UI:', e);
            }
        }

        agentsList.innerHTML = agents.map((agent) => {
            const isReadonly = agent.isDefault;
            const badgeText = isReadonly ? 'Built-in' : 'Workspace';
            const badgeClass = isReadonly ? 'badge-default' : 'badge-workspace';
            const disabledAttr = isReadonly ? 'disabled' : '';

            // Selected model options
            let agentModelOptions = modelOptionsHtml;
            if (agent.model) {
                // Ensure the selected model is marked selected
                agentModelOptions = agentModelOptions.replace(`value="${agent.model}"`, `value="${agent.model}" selected`);
            }

            return `
            <div class="agent-card ${isReadonly ? 'readonly' : ''}" data-agent-id="${agent.id}">
                <div class="agent-card-top">
                    <div class="agent-card-top-left">
                        <div class="agent-avatar">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </div>
                        <input type="text" class="agent-name-input" value="${escHtml(agent.name)}" placeholder="Agent name" data-agent-id="${agent.id}" data-field="name" ${disabledAttr}>
                        <span class="agent-badge ${badgeClass}">${badgeText}</span>
                    </div>
                    <div class="agent-card-actions">
                        <button class="hub-btn secondary small" onclick="hubEditAgentFile('${agent.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                            Edit Prompt
                        </button>
                        <label class="agent-toggle" title="${agent.isActive ? 'Active' : 'Inactive'}">
                            <input type="checkbox" ${agent.isActive ? 'checked' : ''} data-agent-id="${agent.id}" data-field="active" ${disabledAttr}>
                            <span class="agent-toggle-slider"></span>
                        </label>
                        ${!isReadonly ? `
                        <button class="hub-btn icon-only danger" title="Delete" onclick="hubDeleteAgent('${agent.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                        ` : ''}
                    </div>
                </div>

                <div class="agent-settings-grid">
                    <div class="agent-setting-item">
                        <label class="agent-temp-label">Temperature</label>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <input type="range" class="agent-temp-slider" min="0" max="100" value="${Math.round((agent.temperature ?? 0.15) * 100)}" data-agent-id="${agent.id}" data-field="temperature" ${disabledAttr}>
                            <span class="agent-temp-value" data-agent-id="${agent.id}">${(agent.temperature ?? 0.15).toFixed(2)}</span>
                        </div>
                    </div>

                    <div class="agent-setting-item">
                        <label class="agent-checkbox-label">
                            <input type="checkbox" class="agent-callable-checkbox" ${agent.callable ? 'checked' : ''} data-agent-id="${agent.id}" data-field="callable" ${disabledAttr}>
                            <span>Subagent (Callable)</span>
                        </label>
                    </div>

                    <div class="agent-setting-item subagent-only-field" style="display: ${agent.callable ? 'block' : 'none'};">
                        <label class="agent-temp-label">Subagent Model</label>
                        <select class="agent-model-select" data-agent-id="${agent.id}" data-field="model" ${disabledAttr}>
                            ${agentModelOptions}
                        </select>
                    </div>

                    <div class="agent-setting-item subagent-only-field" style="display: ${agent.callable ? 'block' : 'none'};">
                        <label class="agent-temp-label">Step Budget</label>
                        <input type="number" class="agent-budget-input" min="1" max="100" value="${agent.stepBudget ?? 30}" data-agent-id="${agent.id}" data-field="stepBudget" ${disabledAttr}>
                    </div>

                    <div class="agent-setting-item subagent-only-field" style="display: ${agent.callable ? 'block' : 'none'};">
                        <label class="agent-checkbox-label">
                            <input type="checkbox" class="agent-browser-checkbox" ${agent.browserSubagent ? 'checked' : ''} data-agent-id="${agent.id}" data-field="browserSubagent" ${disabledAttr}>
                            <span>Enable Browser Subagent</span>
                        </label>
                    </div>
                </div>
            </div>`;
        }).join('');

        // Save handlers
        agentsList.querySelectorAll('.agent-name-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                const agent = agents.find(a => a.id === e.target.dataset.agentId);
                if (agent && agent.name !== e.target.value) {
                    agent.name = e.target.value;
                    vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'name', value: e.target.value } });
                }
            });
        });

        agentsList.querySelectorAll('.agent-toggle input').forEach(cb => {
            cb.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'isActive', value: e.target.checked } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.isActive = e.target.checked;
                if (activeCountEl) activeCountEl.textContent = String(agents.filter(a => a.isActive).length);
            });
        });

        agentsList.querySelectorAll('.agent-temp-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const val = (parseInt(e.target.value, 10) / 100).toFixed(2);
                const label = agentsList.querySelector(`.agent-temp-value[data-agent-id="${e.target.dataset.agentId}"]`);
                if (label) label.textContent = val;
            });
            slider.addEventListener('change', (e) => {
                const val = parseFloat((parseInt(e.target.value, 10) / 100).toFixed(2));
                const agent = agents.find(a => a.id === e.target.dataset.agentId);
                if (agent) agent.temperature = val;
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'temperature', value: val } });
            });
        });

        // Callable toggle shows/hides subagent fields
        agentsList.querySelectorAll('.agent-callable-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const id = e.target.dataset.agentId;
                const card = agentsList.querySelector(`.agent-card[data-agent-id="${id}"]`);
                const subagentFields = card.querySelectorAll('.subagent-only-field');
                subagentFields.forEach(field => {
                    field.style.display = e.target.checked ? 'block' : 'none';
                });
                vscode.postMessage({ command: 'updateAgent', data: { id, field: 'callable', value: e.target.checked } });
                const a = agents.find(a => a.id === id);
                if (a) a.callable = e.target.checked;
            });
        });

        agentsList.querySelectorAll('.agent-model-select').forEach(sel => {
            sel.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'model', value: e.target.value } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.model = e.target.value;
            });
        });

        agentsList.querySelectorAll('.agent-budget-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                const val = parseInt(e.target.value, 10) || 30;
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'stepBudget', value: val } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.stepBudget = val;
            });
        });

        agentsList.querySelectorAll('.agent-browser-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'updateAgent', data: { id: e.target.dataset.agentId, field: 'browserSubagent', value: e.target.checked } });
                const a = agents.find(a => a.id === e.target.dataset.agentId);
                if (a) a.browserSubagent = e.target.checked;
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RENDER: RULES
    // ═══════════════════════════════════════════════════════════════════════
    function renderRules() {
        if (!rulesList) return;

        if (ruleCountEl) ruleCountEl.textContent = String(rules.length);
        if (globalRuleCountEl) globalRuleCountEl.textContent = String(rules.filter(r => r.scope === 'global').length);

        if (rules.length === 0) {
            rulesList.innerHTML = '';
            if (rulesEmpty) {
                rulesList.appendChild(rulesEmpty);
                rulesEmpty.style.display = 'flex';
            }
            return;
        }

        if (rulesEmpty) rulesEmpty.style.display = 'none';

        rulesList.innerHTML = rules.map(rule => {
            const isReadonly = rule.isDefault;
            const badgeText = isReadonly ? 'Built-in' : 'Workspace';
            const badgeClass = isReadonly ? 'badge-default' : 'badge-workspace';
            const disabledAttr = isReadonly ? 'disabled' : '';

            return `
            <div class="agent-card ${isReadonly ? 'readonly' : ''}" data-rule-id="${rule.id}">
                <div class="agent-card-top">
                    <div class="agent-card-top-left">
                        <div class="agent-avatar">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        </div>
                        <input type="text" class="agent-name-input rule-name-input" value="${escHtml(rule.name)}" placeholder="Rule name" data-rule-id="${rule.id}" data-field="name" ${disabledAttr}>
                        <span class="agent-badge ${badgeClass}">${badgeText}</span>
                    </div>
                    <div class="agent-card-actions">
                        <button class="hub-btn secondary small" onclick="hubEditRuleFile('${rule.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                            Edit Rule
                        </button>
                        <select class="rule-scope-select" data-rule-id="${rule.id}" data-field="scope" title="Scope" ${disabledAttr}>
                            <option value="global" ${rule.scope === 'global' ? 'selected' : ''}>Global</option>
                            <option value="workspace" ${rule.scope === 'workspace' ? 'selected' : ''}>Workspace</option>
                            <option value="assignable" ${rule.scope === 'assignable' ? 'selected' : ''}>Assignable</option>
                        </select>
                        ${!isReadonly ? `
                        <button class="hub-btn icon-only danger" title="Delete" onclick="hubDeleteRule('${rule.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                        ` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');

        rulesList.querySelectorAll('.rule-name-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                const rule = rules.find(r => r.id === e.target.dataset.ruleId);
                if (rule && rule.name !== e.target.value) {
                    rule.name = e.target.value;
                    vscode.postMessage({ command: 'updateRule', data: { id: e.target.dataset.ruleId, field: 'name', value: e.target.value } });
                }
            });
        });

        rulesList.querySelectorAll('.rule-scope-select').forEach(sel => {
            sel.addEventListener('change', (e) => {
                vscode.postMessage({ command: 'updateRule', data: { id: e.target.dataset.ruleId, field: 'scope', value: e.target.value } });
                const r = rules.find(r => r.id === e.target.dataset.ruleId);
                if (r) r.scope = e.target.value;
                if (globalRuleCountEl) globalRuleCountEl.textContent = String(rules.filter(r => r.scope === 'global').length);
            });
        });
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────
    function escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
            vscode.postMessage({ command: 'deleteAgent', data: { id } });
        }
    };

    window.hubDeleteRule = async function (id) {
        const rule = rules.find(r => r.id === id);
        const name = rule ? rule.name : 'this rule';
        const confirmed = await showModal('Delete Rule', `Are you sure you want to delete "${name}"? This will permanently delete its workspace markdown file.`);
        if (confirmed) {
            vscode.postMessage({ command: 'deleteRule', data: { id } });
        }
    };

    // ─── INIT ────────────────────────────────────────────────────────────
    vscode.postMessage({ command: 'requestAgents' });
    vscode.postMessage({ command: 'requestRules' });
})();
