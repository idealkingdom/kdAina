let _waitingIndicatorTimer = null;

/** Strip ANSI escape sequences from terminal output for clean rendering */
function stripAnsi(str) {
    if (!str) { return ''; }
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function getFileExtensionBadgeColor(ext) {
    const colors = {
        'js': '#f1e05a',
        'ts': '#3178c6',
        'tsx': '#3178c6',
        'jsx': '#f1e05a',
        'css': '#c752c7',
        'html': '#e34c26',
        'json': '#00bcd4',
        'py': '#3572A5',
        'md': '#083fa1',
        'sh': '#89e051',
        'go': '#00add8',
        'yml': '#cb171e',
        'yaml': '#cb171e',
        'toml': '#9c4221'
    };
    return colors[ext.toLowerCase()] || '#888888';
}

function clearWaitingIndicator() {
    if (_waitingIndicatorTimer) {
        clearTimeout(_waitingIndicatorTimer);
        _waitingIndicatorTimer = null;
    }
    const existing = document.querySelector('.agent-waiting-indicator');
    if (existing) { existing.remove(); }
}

function scheduleWaitingIndicator() {
    clearWaitingIndicator();
    _waitingIndicatorTimer = setTimeout(() => {
        // Only show if there isn't already a streaming thinking block
        if (document.querySelector('.agent-thinking-block:not([data-finalized="true"])')) { return; }

        const indicator = document.createElement('div');
        indicator.className = 'agent-waiting-indicator';
        indicator.innerHTML = `
            <div class="waiting-dots">
                <span></span><span></span><span></span>
            </div>
            <span class="waiting-label">Analyzing...</span>
        `;
        const group = getOrCreateAgentStepsGroup();
        withAutoScroll(() => group.appendChild(indicator));
    }, 1000); // 1s delay — short enough to feel responsive, long enough to avoid flicker
}

const AGENT_ICONS = {
    'list_workspace': '○',
    'read_file_skeleton': '▢',
    'read_line_range': '▤',
    'chunk_replace': '◇',
    'create_file': '▷',
    'find_symbol': '◎',
    'run_command': '▸',
    'search_workspace': '◈',
    'scrape_url': '◉',
    'web_search': '⌕',
    'manage_artifact': '🗄',
    'read_artifact': '🗎',
    'list_background_processes': '▦',
    'stop_background_process': '■',
    'get_background_output': '▥'
};

const AGENT_TOOL_LABELS = {
    'list_workspace': { running: 'Listing Workspace', done: 'Listed Workspace' },
    'read_file_skeleton': { running: 'Reading File Skeleton', done: 'Read File Skeleton' },
    'read_line_range': { running: 'Reading Lines', done: 'Read Lines' },
    'chunk_replace': { running: 'Editing File', done: 'Edited File' },
    'create_file': { running: 'Creating File', done: 'Created File' },
    'find_symbol': { running: 'Finding Symbol', done: 'Found Symbol' },
    'run_command': { running: 'Running Command', done: 'Ran Command' },
    'search_workspace': { running: 'Searching Workspace', done: 'Searched Workspace' },
    'scrape_url': { running: 'Scraping URL', done: 'Scraped URL' },
    'web_search': { running: 'Searching Web', done: 'Searched Web' },
    'manage_artifact': { running: 'Managing Artifact', done: 'Managed Artifact' },
    'read_artifact': { running: 'Reading Artifact', done: 'Read Artifact' },
    'list_background_processes': { running: 'Listing Processes', done: 'Listed Processes' },
    'stop_background_process': { running: 'Stopping Process', done: 'Stopped Process' },
    'get_background_output': { running: 'Reading Output', done: 'Read Output' }
};

/**
 * Renders an Agent tool step card in the chat log.
 * Shows what the agent is doing (reading, editing, searching, etc.)
 */
function renderAgentStep(step) {
    if (!step) { return; }

    // Always clear the waiting indicator when any new step arrives
    clearWaitingIndicator();

    if (step.type === 'thinking') {
        // Differentiate between status messages and actual reasoning tokens
        const isStatusMessage = step.text && (
            step.text.startsWith('Agent completed') ||
            step.text.startsWith('■') ||
            step.text.startsWith('✕')
        );

        if (isStatusMessage) {
            // Status messages render as simple inline cards (existing behavior)
            const activeContainer = chatbox.querySelector('div.agent-steps-container:not([data-finalized="true"])');
            if (activeContainer && activeContainer.children.length === 0) {
                activeContainer.remove();
            }

            const thinkingEl = document.createElement('div');
            thinkingEl.className = 'agent-step-card thinking';
            thinkingEl.innerHTML = `
                <div class="step-header">
                    <span class="step-icon">✦</span>
                    <span class="step-tool-name">${step.text}</span>
                </div>
            `;
            withAutoScroll(() => getActiveTurn().appendChild(thinkingEl));
            return;
        }

        // #44: Handle __TOKENS__ sentinel (token count only, no text)
        const tokenMatch = step.text && step.text.match(/^__TOKENS__(\d+)$/);
        if (tokenMatch) {
            const tokenCount = parseInt(tokenMatch[1], 10);
            // Find ANY thinking block (non-finalized first, then most recent finalized)
            let thinkingBlock = chatbox.querySelector('.agent-thinking-block:not([data-finalized="true"])');
            if (!thinkingBlock) {
                // Post-stream token count — find the most recent finalized block
                const all = chatbox.querySelectorAll('.agent-thinking-block');
                thinkingBlock = all.length > 0 ? all[all.length - 1] : null;
            }
            if (thinkingBlock) {
                const prev = parseInt(thinkingBlock.dataset.tokens || '0', 10);
                const total = prev + tokenCount;
                thinkingBlock.dataset.tokens = String(total);
                // Update label with token count
                const label = thinkingBlock.querySelector('.thinking-label');
                if (label) {
                    label.textContent = `Thought for ${total} tokens`;
                }
            }
            return;
        }

        // SVG icon for reasoning (sparkle/brain style — matches design system)
        const thinkingIconSVG = `<span class="thinking-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707"/><circle cx="12" cy="12" r="4"/></svg></span>`;

        // #44: Actual reasoning text — stream into a collapsible block
        let thinkingBlock = chatbox.querySelector('.agent-thinking-block:not([data-finalized="true"])');
        if (!thinkingBlock) {
            thinkingBlock = document.createElement('details');
            thinkingBlock.className = 'agent-thinking-block streaming';
            thinkingBlock.open = true; // auto-open during streaming
            thinkingBlock.dataset.tokens = '0';
            thinkingBlock.dataset.stepCount = '0';
            thinkingBlock.dataset.thinkStart = String(Date.now());

            const summary = document.createElement('summary');
            summary.className = 'thinking-summary';
            summary.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="9 18 15 12 9 6"></polyline></svg>
                ${thinkingIconSVG}
                <span class="thinking-label">Thinking...</span>
            `;
            thinkingBlock.appendChild(summary);

            const content = document.createElement('div');
            content.className = 'thinking-content';
            thinkingBlock.appendChild(content);

            // Live elapsed time timer
            const timerId = setInterval(() => {
                const elapsed = Math.floor((Date.now() - parseInt(thinkingBlock.dataset.thinkStart)) / 1000);
                const label = thinkingBlock.querySelector('.thinking-label');
                if (label && !thinkingBlock.dataset.finalized) {
                    label.textContent = `Thinking for ${elapsed}s`;
                }
            }, 1000);
            thinkingBlock.dataset.thinkTimer = String(timerId);

            getOrCreateAgentStepsGroup(step._isHistory).appendChild(thinkingBlock);
        }

        // Append the reasoning text (if any — empty string for reasoning-start)
        if (step.text) {
            const contentEl = thinkingBlock.querySelector('.thinking-content');
            if (contentEl) {
                withAutoScroll(() => { contentEl.textContent += step.text; });
            }
            // Update label to show it's working
            const label = thinkingBlock.querySelector('.thinking-label');
            if (label) {
                label.textContent = 'Thinking...';
            }
        }
        return;
    }

    // Finalize any open thinking block when a non-thinking step arrives
    const openThinking = chatbox.querySelector('.agent-thinking-block:not([data-finalized="true"])');
    if (openThinking) {
        openThinking.dataset.finalized = 'true';
        openThinking.classList.remove('streaming');
        openThinking.open = false; // auto-collapse when done

        // Stop the elapsed time timer
        if (openThinking.dataset.thinkTimer) {
            clearInterval(parseInt(openThinking.dataset.thinkTimer));
        }

        const label = openThinking.querySelector('.thinking-label');
        const tokens = parseInt(openThinking.dataset.tokens || '0', 10);
        const startTime = parseInt(openThinking.dataset.thinkStart || '0', 10);
        const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
        const contentEl = openThinking.querySelector('.thinking-content');
        const hasText = contentEl && contentEl.textContent.trim();

        if (label) {
            let labelText = elapsed > 0 ? `Thought for ${elapsed}s` : 'Thought process';
            if (tokens > 0) {
                labelText += ` · ${tokens} tokens`;
            }
            label.textContent = labelText;
        }
    }

    // Helper is defined below
    const stepsContainer = getOrCreateAgentStepsGroup(step._isHistory);

    // Tools that go inside category groups don't need expand/collapse — use a simple div
    const groupedTools = ['list_workspace', 'read_file_skeleton', 'read_line_range', 'find_symbol',
        'search_workspace', 'get_workspace_problems', 'read_artifact', 'chunk_replace',
        'create_file', 'manage_artifact', 'scrape_url', 'web_search',
        'list_background_processes', 'stop_background_process', 'get_background_output'];
    const isGroupedTool = groupedTools.includes(step.toolName);

    let stepEl = null;
    if (step.toolCallId) {
        stepEl = stepsContainer.querySelector(`[data-tool-call-id="${step.toolCallId}"]`);
    }
    // Only use toolName fallback when there's NO toolCallId (streaming preview).
    // If toolCallId exists but didn't match, the card is new — don't reuse another.
    if (!stepEl && !step.toolCallId && step.toolName) {
        const candidates = stepsContainer.querySelectorAll(`[data-tool-name="${step.toolName}"] .step-status.running`);
        if (candidates.length > 0) {
            stepEl = candidates[candidates.length - 1].closest('.agent-step-card');
        }
    }
    if (!stepEl) {
        stepEl = document.createElement(isGroupedTool ? 'div' : 'details');
    }

    if (!stepEl.parentNode) {
        stepEl.className = 'agent-step-card';
    }
    if (step.toolName) {
        stepEl.dataset.toolName = step.toolName;
    }
    if (step.args) {
        const pathArg = step.args.filePath || step.args.directory || step.args.TargetFile || step.args.AbsolutePath || step.args.SearchPath || step.args.DirectoryPath;
        if (typeof pathArg === 'string') {
            stepEl.dataset.filePath = pathArg;
        }
    }

    if (step.type === 'tool_call') {
        const icon = AGENT_ICONS[step.toolName] || '◆';
        const labelObj = AGENT_TOOL_LABELS[step.toolName];
        let displayName = labelObj ? labelObj.running : step.toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        let argsPreview = step.args ? JSON.stringify(step.args).substring(0, 120) : '';
        if (step.args) {
            // Attempt to extract a target name to append to the display name for transparency
            let targetName = null;
            const pathArg = step.args.filePath || step.args.directory || step.args.TargetFile || step.args.AbsolutePath || step.args.SearchPath || step.args.DirectoryPath;

            if (typeof pathArg === 'string' && pathArg.trim() !== '') {
                targetName = pathArg.split(/[\\/]/).pop();
                if (!targetName || targetName === '.' || targetName === '..') {
                    targetName = 'Root';
                }
            } else if (step.toolName === 'list_workspace') {
                targetName = 'Root';
            } else if ((step.toolName === 'read_artifact' || step.toolName === 'manage_artifact') && typeof step.args.name === 'string') {
                targetName = step.args.name;
            }

            if (targetName) {
                if (step.toolName === 'list_workspace') {
                    displayName += ` (${targetName})`;
                } else {
                    displayName += ` - ${targetName}`;
                }
            }
            if (step.toolName === 'web_search' && step.args.query) {
                argsPreview = `<span style="opacity: 0.8;">Query:</span> <strong style="color: var(--vscode-textLink-foreground);">${step.args.query}</strong>`;
            } else if (step.toolName === 'scrape_url' && step.args.url) {
                argsPreview = `<span style="opacity: 0.8;">URL:</span> <a href="${step.args.url}" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: none;">${step.args.url}</a>`;
            } else if (step.toolName === 'run_command' && step.args.command) {
                argsPreview = `<code style="background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px; font-size: 0.9em;">$ ${step.args.command}</code>`;
            } else if (step.toolName === 'read_artifact' && step.args.name) {
                argsPreview = `<span style="opacity: 0.8;">${step.args.scope || 'session'}:</span> <strong style="color: var(--vscode-textLink-foreground); cursor: pointer;" onclick="vscode.postMessage({command: 'openArtifact', data: {name: '${step.args.name}', chatId: chatLog.dataset.chatId}})">${step.args.name}</strong>`;
            } else if (step.toolName === 'plan_task' || step.toolName === 'update_task_progress' || step.toolName === 'verify_completion') {
                const previewStr = JSON.stringify(step.args).replace(/["'{}[\]]/g, '').substring(0, 80) + '...';
                argsPreview = `<span style="opacity: 0.8;">${previewStr}</span> <strong style="color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; margin-left: 8px;" onclick="vscode.postMessage({command: 'openArtifact', data: {name: 'task.md', chatId: chatLog.dataset.chatId}})">View Progress</strong>`;
            }
        }

        // All tools now show as "Running" initially. 
        // Write tools will quickly flip to "Done" (Staged) when the result arrives.
        // History steps render directly as "done" — no pulse animation needed.
        const initialStatus = step._isHistory ? 'done' : 'running';
        if (isGroupedTool) {
            // Grouped tools: simple inline header, no expand/collapse needed
            stepEl.innerHTML = `
                <div class="step-header">
                    <span class="step-icon">${icon}</span>
                    <span class="step-tool-name">${displayName}</span>
                    <span class="step-status ${initialStatus}"></span>
                </div>
            `;
        } else {
            // Ungrouped tools (run_command, plan_task, etc): expandable with content area
            stepEl.innerHTML = `
                <summary class="step-header">
                    <span class="step-icon">${icon}</span>
                    <span class="step-tool-name">${displayName}</span>
                    <span class="step-status ${initialStatus}"></span>
                    <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </summary>
                <div class="step-content">
                    <div class="step-args">${argsPreview}</div>
                </div>
            `;
            // Auto-open if there is something to show
            if (argsPreview) {
                stepEl.open = true;
            }
        }

        if (step.toolCallId) {
            stepEl.dataset.toolCallId = step.toolCallId;
            stepEl.dataset.toolName = step.toolName;
            // Store args for later review
            window.pendingToolArgs = window.pendingToolArgs || {};
            window.pendingToolArgs[step.toolCallId] = step.args;

            if (step.approvalRequired && !step.diffReviewRequired) {
                stepEl.classList.add('approval-pending');
                const actionsEl = document.createElement('div');
                actionsEl.className = 'step-actions';
                actionsEl.innerHTML = `
                    <button class="approve-btn staging-btn primary" style="padding: 2px 8px; font-size: 11px;" onclick="approveTool('${step.toolCallId}', true)">Approve</button>
                    <button class="deny-btn staging-btn danger" style="padding: 2px 8px; font-size: 11px;" onclick="approveTool('${step.toolCallId}', false)">Deny</button>
                `;
                stepEl.appendChild(actionsEl);

                const statusEl = stepEl.querySelector('.step-status');
                if (statusEl) {
                    statusEl.classList.remove('running');
                    statusEl.classList.add('pending');
                }
            }
        }

    } else if (step.type === 'tool_result') {
        // Find the specific card by toolCallId, then try toolName fallback
        let targetCard = null;
        if (step.toolCallId) {
            targetCard = stepsContainer.querySelector(`[data-tool-call-id="${step.toolCallId}"]`);
        }
        // Fallback: if toolCallId didn't match (e.g. streaming used a temp ID),
        // find the last card with this toolName that's still "running"
        if (!targetCard && step.toolName) {
            const candidates = stepsContainer.querySelectorAll(`[data-tool-name="${step.toolName}"] .step-status.running`);
            if (candidates.length > 0) {
                targetCard = candidates[candidates.length - 1].closest('.agent-step-card');
            }
        }

        const statusEl = (targetCard || stepsContainer).querySelector('.step-status');
        if (statusEl) {
            const isStaged = step.result && (typeof step.result.message === 'string' && step.result.message.includes('staged'));
            if (isStaged) statusEl.textContent = 'Staged';
            statusEl.classList.remove('running');
            statusEl.classList.add('done');

            // The user requested to keep the present tense verb (e.g., "Running Command") 
            // permanently, so we no longer flip it to past tense here.

            if (targetCard && step.result) {
                targetCard.dataset.result = JSON.stringify(step.result);
                targetCard.dataset.toolName = step.toolName;
            }

            // Custom layout for chunk_replace / create_file diff preview
            if (targetCard && (step.toolName === 'chunk_replace' || step.toolName === 'create_file') && step.result && step.result.success) {
                const filePath = step.result.file || (step.args && step.args.filePath) || 'file';
                const absPath = step.result.absolutePath || (step.args && step.args.filePath) || '';
                const additions = typeof step.result.additions === 'number' ? step.result.additions : 0;
                const deletions = typeof step.result.deletions === 'number' ? step.result.deletions : 0;

                const filename = filePath.split(/[\\/]/).pop();
                const ext = filename.split('.').pop() || '';
                const badgeColor = getFileExtensionBadgeColor(ext);
                const actionLabel = step.toolName === 'create_file' ? 'Created' : 'Edited';

                const header = targetCard.querySelector('.step-header');
                if (header) {
                    header.className = 'step-header file-edit-step-header';
                    header.innerHTML = `
                        <div class="file-edit-row" onclick="vscode.postMessage({command: 'openFile', data: {path: '${absPath.replace(/\\/g, '\\\\')}'}})">
                            <span class="file-edit-action">${actionLabel}</span>
                            <span class="file-edit-badge" style="color: ${badgeColor};">${ext}</span>
                            <span class="file-edit-name">${filename}</span>
                            <span class="file-edit-diff">
                                <span class="diff-add">+${additions}</span>
                                <span class="diff-del">-${deletions}</span>
                            </span>
                        </div>
                        <span class="step-status done"></span>
                    `;
                }
            }

            // Custom layout for read_file_skeleton / read_line_range
            if (targetCard && (step.toolName === 'read_file_skeleton' || step.toolName === 'read_line_range') && step.result && !step.result.error) {
                const filePath = step.result.file || (step.args && (step.args.filePath || step.args.file)) || 'file';
                const absPath = step.result.absolutePath || (step.args && (step.args.filePath || step.args.file)) || '';

                const filename = filePath.split(/[\\/]/).pop();
                const ext = filename.split('.').pop() || '';
                const badgeColor = getFileExtensionBadgeColor(ext);
                const actionLabel = 'Read';

                let rangeLabel = '';
                if (step.toolName === 'read_line_range' && step.result.range) {
                    rangeLabel = `<span class="file-read-range" style="opacity: 0.5; font-size: 11px; margin-left: 6px;">L${step.result.range}</span>`;
                }

                const header = targetCard.querySelector('.step-header');
                if (header) {
                    header.className = 'step-header file-edit-step-header';
                    header.innerHTML = `
                        <div class="file-edit-row" onclick="vscode.postMessage({command: 'openFile', data: {path: '${absPath.replace(/\\/g, '\\\\')}'}})">
                            <span class="file-edit-action">${actionLabel}</span>
                            <span class="file-edit-badge" style="color: ${badgeColor};">${ext}</span>
                            <span class="file-edit-name">${filename}</span>
                            ${rangeLabel}
                        </div>
                        <span class="step-status done"></span>
                    `;
                }
            }

            // Special styling for manage_artifact result
            if (targetCard && step.toolName === 'manage_artifact' && step.result && step.result._artifactManaged) {
                targetCard.style.borderLeft = '3px solid var(--vscode-focusBorder)';
                const header = targetCard.querySelector('.step-header');
                if (header) {
                    header.style.color = 'var(--vscode-focusBorder)';
                }
                const argsPreview = targetCard.querySelector('.step-args');
                if (argsPreview) {
                    const am = step.result._artifactManaged;
                    argsPreview.innerHTML = `<strong>${am.action.toUpperCase()}</strong>: <code>${am.scope}/${am.name}</code>`;
                }
            }

            // run_command: render terminal snippet in the step-content div
            if (targetCard && step.toolName === 'run_command' && step.result && typeof step.result.output === 'string') {
                const commandArgs = window.pendingToolArgs && window.pendingToolArgs[step.toolCallId];
                const commandExecuted = (step.result && step.result._commandExecuted) || (commandArgs ? commandArgs.command : 'command');

                const terminalSnippet = document.createElement('div');
                terminalSnippet.className = 'terminal-snippet';

                let outputText = stripAnsi(step.result.output).trim();
                if (outputText.length > 2000) {
                    outputText = outputText.substring(0, 2000) + '\n... (output truncated)';
                }
                if (!outputText) {
                    outputText = '(no output)';
                }

                const escapedOutput = outputText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const cwdText = '~/.../workspace';

                terminalSnippet.innerHTML = `
                    <div class="terminal-prompt"><span class="terminal-cwd">${cwdText}</span> $ ${commandExecuted}</div>
                    <div class="terminal-output">${escapedOutput}</div>
                `;
                // Ensure the card is open so the terminal snippet is visible
                targetCard.open = true;

                if (targetCard.style.display === 'none') {
                    targetCard.style.display = '';
                }

                const contentDiv = targetCard.querySelector('.step-content') || targetCard;
                withAutoScroll(() => {
                    contentDiv.appendChild(terminalSnippet);
                });
            }

            // get_background_output: render a premium purple-themed terminal log snippet
            if (targetCard && step.toolName === 'get_background_output' && step.result && typeof step.result.output === 'string') {
                const escapeHtml = (s) => s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
                const safeLabel = escapeHtml(step.result.label || 'unknown');
                const safeSearch = escapeHtml(step.args?.search);
                const searchArg = safeSearch ? ` | grep -i &quot;${safeSearch}&quot;` : '';
                const linesArg = step.args?.lines || 50;

                const terminalSnippet = document.createElement('div');
                terminalSnippet.className = 'terminal-snippet';

                let outputText = stripAnsi(step.result.output).trim();
                if (outputText.length > 2000) {
                    outputText = outputText.substring(0, 2000) + '\n... (output truncated)';
                }
                if (!outputText) {
                    outputText = '(no output)';
                }

                const escapedOutput = outputText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                terminalSnippet.innerHTML = `
                    <div class="terminal-prompt">
                        <span class="terminal-cwd">[Logs: ${safeLabel}]</span> $ tail -n ${linesArg}${searchArg}
                    </div>
                    <div class="terminal-output">${escapedOutput}</div>
                `;

                // Style the parent card
                targetCard.open = true;
                if (targetCard.style.display === 'none') {
                    targetCard.style.display = '';
                }

                const contentDiv = targetCard.querySelector('.step-content') || targetCard;
                withAutoScroll(() => {
                    contentDiv.appendChild(terminalSnippet);
                });
            }
        }

        // Schedule the waiting indicator — will show "Analyzing..." if
        // the model takes >1s to decide its next action.
        // Skip during history replay — all results are already present.
        if (!step._isHistory) { scheduleWaitingIndicator(); }
        return;
    }

    if (!stepEl.parentNode) {
        const categories = {
            'list_workspace': 'explore',
            'read_file_skeleton': 'explore',
            'read_line_range': 'explore',
            'find_symbol': 'explore',
            'search_workspace': 'explore',
            'get_workspace_problems': 'explore',
            'read_artifact': 'explore',
            'chunk_replace': 'edit',
            'create_file': 'edit',
            'manage_artifact': 'edit',
            'scrape_url': 'web',
            'web_search': 'web'
        };
        const categoryLabels = {
            'explore': 'Explored',
            'edit': 'Edited',
            'web': 'Searched'
        };

        const cat = categories[step.toolName];

        if (cat) {
            // Find the last actual group in stepsContainer
            let lastChild = stepsContainer.lastElementChild;
            if (lastChild && lastChild.classList.contains('agent-waiting-indicator')) {
                lastChild = lastChild.previousElementSibling;
            }

            if (lastChild && lastChild.tagName === 'DETAILS' && lastChild.dataset.category === cat) {
                // Append to existing group
                const count = parseInt(lastChild.dataset.count || '0') + 1;
                lastChild.dataset.count = String(count);
                const labelEl = lastChild.querySelector('.group-label');
                if (labelEl) {
                    const suffix = cat === 'edit' ? (count === 1 ? 'file' : 'files') : (count === 1 ? 'item' : 'items');
                    labelEl.textContent = `${categoryLabels[cat]} ${count} ${suffix}`;
                }
                const groupContent = lastChild.querySelector('.group-content');
                if (groupContent) {
                    groupContent.appendChild(stepEl);
                } else {
                    lastChild.appendChild(stepEl);
                }
            } else {
                // Create new group
                const groupEl = document.createElement('details');
                groupEl.className = 'agent-step-group-sub agent-step-card';
                groupEl.dataset.category = cat;
                groupEl.dataset.count = "1";
                groupEl.open = true;
                const suffix = cat === 'edit' ? 'file' : 'item';
                groupEl.innerHTML = `
                    <summary class="step-header">
                        <span class="step-icon">◂</span>
                        <span class="group-label step-tool-name">${categoryLabels[cat]} 1 ${suffix}</span>
                        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </summary>
                    <div class="group-content step-content" style="padding-left: 12px; border-left: 1px solid rgba(255, 255, 255, 0.1);"></div>
                `;
                groupEl.querySelector('.group-content').appendChild(stepEl);
                stepsContainer.appendChild(groupEl);
            }
        } else {
            // Un-grouped items (e.g. run_command)
            stepsContainer.appendChild(stepEl);
        }
    }

    scrollToBottom();
}

/**
 * Gathers all files processed/modified during a chat turn and appends interactive pills.
 */
function appendFilesSummary(turnEl) {
    if (!turnEl) return;

    // Prevent duplicate summaries
    if (turnEl.querySelector('.files-summary-section')) return;

    const messageContent = turnEl.querySelector('.system-message .message-content');
    if (!messageContent) return;

    // Find all step cards in this turn
    const stepCards = turnEl.querySelectorAll('.agent-step-card');

    const modifiedFiles = new Map(); // path -> { file, absolutePath, additions, deletions }
    const readFiles = new Map(); // path -> { file, absolutePath }

    stepCards.forEach(card => {
        const toolName = card.dataset.toolName;
        const resultStr = card.dataset.result;
        if (!resultStr) return;

        try {
            const result = JSON.parse(resultStr);
            if (result.error) return;

            const filePath = result.file || card.dataset.filePath || '';
            const absPath = result.absolutePath || card.dataset.filePath || filePath || '';
            if (!filePath) return;

            if (toolName === 'chunk_replace' || toolName === 'create_file') {
                if (result.success) {
                    const additions = typeof result.additions === 'number' ? result.additions : 0;
                    const deletions = typeof result.deletions === 'number' ? result.deletions : 0;

                    if (modifiedFiles.has(filePath)) {
                        const existing = modifiedFiles.get(filePath);
                        existing.additions += additions;
                        existing.deletions += deletions;
                    } else {
                        modifiedFiles.set(filePath, {
                            file: filePath,
                            absolutePath: absPath,
                            additions: additions,
                            deletions: deletions
                        });
                    }
                }
            } else if (toolName === 'read_file_skeleton' || toolName === 'read_line_range') {
                if (!readFiles.has(filePath)) {
                    readFiles.set(filePath, {
                        file: filePath,
                        absolutePath: absPath
                    });
                }
            }
        } catch (e) {
            console.error('Failed to parse tool result for files summary', e);
        }
    });

    // Remove read files that are also modified (modification takes priority)
    modifiedFiles.forEach((info, filePath) => {
        readFiles.delete(filePath);
    });

    if (modifiedFiles.size === 0 && readFiles.size === 0) return;

    // Build the files summary container
    const summarySection = document.createElement('div');
    summarySection.className = 'files-summary-section';

    let headerLabel = 'Files Processed';
    let count = 0;
    let listHTML = '';

    if (modifiedFiles.size > 0) {
        headerLabel = 'Files Modified';
        count = modifiedFiles.size;

        modifiedFiles.forEach((info) => {
            const filename = info.file.split(/[\\/]/).pop();
            const ext = filename.split('.').pop() || '';
            const badgeColor = getFileExtensionBadgeColor(ext);
            const pathEscaped = info.absolutePath.replace(/\\/g, '\\\\');

            listHTML += `
                <div class="file-summary-pill">
                    <span class="file-summary-ext" style="color: ${badgeColor};">${ext}</span>
                    <span class="file-summary-name" onclick="vscode.postMessage({command: 'openFile', data: {path: '${pathEscaped}'}})">${filename}</span>
                    <span class="file-summary-diff">
                        <span class="diff-add">+${info.additions}</span>
                        <span class="diff-del">-${info.deletions}</span>
                    </span>
                </div>
            `;
        });
    } else if (readFiles.size > 0) {
        headerLabel = 'Files Processed';
        count = readFiles.size;

        readFiles.forEach((info) => {
            const filename = info.file.split(/[\\/]/).pop();
            const ext = filename.split('.').pop() || '';
            const badgeColor = getFileExtensionBadgeColor(ext);
            const pathEscaped = info.absolutePath.replace(/\\/g, '\\\\');

            listHTML += `
                <div class="file-summary-pill">
                    <span class="file-summary-ext" style="color: ${badgeColor};">${ext}</span>
                    <span class="file-summary-name" onclick="vscode.postMessage({command: 'openFile', data: {path: '${pathEscaped}'}})">${filename}</span>
                </div>
            `;
        });
    }

    summarySection.innerHTML = `
        <div class="files-summary-header">
            <span>${headerLabel}</span>
            <span class="files-summary-count">${count}</span>
        </div>
        <div class="files-summary-container">
            ${listHTML}
        </div>
    `;

    // Append to messageContent, before the footer
    const footer = messageContent.querySelector('.message-footer');
    if (footer) {
        messageContent.insertBefore(summarySection, footer);
    } else {
        messageContent.appendChild(summarySection);
    }
}

/**
 * Appends suggested follow-up chips at the bottom of the AI response.
 * Supports both parsing <suggestions> tags and generating fallback contextual questions.
 */
function appendFollowUpSuggestions(turnEl, responseText) {
    if (!turnEl || !responseText) return;

    // Prevent duplicate suggestions in the same turn
    if (turnEl.querySelector('.follow-up-suggestions-section')) return;

    const messageContent = turnEl.querySelector('.system-message .message-content');
    if (!messageContent) return;

    let suggestions = [];

    // 1. Attempt to parse structured suggestions from the response: <suggestions>["Q1", "Q2"]</suggestions>
    const suggestionsTagRegex = /<suggestions>([\s\S]*?)<\/suggestions>/i;
    const match = responseText.match(suggestionsTagRegex);
    if (match && match[1]) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (Array.isArray(parsed)) {
                suggestions = parsed;
            }
        } catch (e) {
            // If JSON parse fails, split by newline or list dashes
            suggestions = match[1]
                .split('\n')
                .map(line => line.replace(/^[-*•\d.]\s*/, '').trim())
                .filter(Boolean);
        }
    }

    // Clean up suggestions markup from display if the text node hasn't been completely updated
    const messageTextEl = messageContent.querySelector('.message-text');
    if (messageTextEl && messageTextEl.innerHTML.includes('&lt;suggestions&gt;')) {
        messageTextEl.innerHTML = messageTextEl.innerHTML.replace(/&lt;suggestions&gt;[\s\S]*?&lt;\/suggestions&gt;/gi, '');
    }

    // 2. Generate fallback recommendations if none were provided by the model
    if (suggestions.length === 0) {
        // Gather context from tools run
        const stepCards = Array.from(turnEl.querySelectorAll('.agent-step-card'));
        const toolNames = stepCards.map(card => card.dataset.toolName).filter(Boolean);
        
        // Collect files from the files summary
        const summaryPills = turnEl.querySelectorAll('.file-summary-pill .file-summary-name');
        const fileNames = Array.from(summaryPills).map(el => el.textContent.trim());
        const primaryFile = fileNames[0] || '';
        const ext = primaryFile ? primaryFile.split('.').pop().toLowerCase() : '';

        // Check if any command failed
        let commandFailed = false;
        stepCards.forEach(card => {
            if (card.dataset.toolName === 'run_command') {
                const termOutput = card.querySelector('.terminal-output');
                if (termOutput && (termOutput.textContent.toLowerCase().includes('error') || termOutput.textContent.toLowerCase().includes('fail') || termOutput.textContent.toLowerCase().includes('exit status'))) {
                    commandFailed = true;
                }
            }
        });

        const resTextLower = responseText.toLowerCase();

        if (commandFailed) {
            suggestions.push(`Troubleshoot the command failure.`);
            suggestions.push(`Can you run a different command to verify?`);
            suggestions.push(`Show me the logs and error details.`);
        } else if (fileNames.length > 0) {
            suggestions.push(`Explain the changes made to ${primaryFile} in detail.`);
            if (ext === 'css' || ext === 'scss') {
                suggestions.push(`Let's refine the styling or layout of this UI.`);
                suggestions.push(`Is the style responsive and compatible across browsers?`);
            } else if (ext === 'html' || ext === 'vue' || ext === 'jsx' || ext === 'tsx') {
                suggestions.push(`Can you verify the HTML accessibility (a11y)?`);
                suggestions.push(`Can you check if there are any console warnings or errors?`);
            } else {
                if (resTextLower.includes('test') || resTextLower.includes('spec')) {
                    suggestions.push(`Can you run tests to verify this fix?`);
                } else {
                    suggestions.push(`Can you write unit tests for ${primaryFile}?`);
                }
                suggestions.push(`Are there any potential side effects or edge cases in this implementation?`);
            }
        } else if (resTextLower.includes('error') || resTextLower.includes('fail') || resTextLower.includes('exception') || resTextLower.includes('crash')) {
            suggestions.push(`Explain the root cause of this error.`);
            suggestions.push(`What is the recommended fix for this issue?`);
            suggestions.push(`How can I troubleshoot this error further?`);
        } else if (toolNames.includes('web_search') || toolNames.includes('scrape_url')) {
            suggestions.push(`Can you explore other search results for more details?`);
            suggestions.push(`What are the alternative libraries or approaches for this?`);
            suggestions.push(`Explain how to integrate the retrieved documentation.`);
        } else if (responseText.includes('```')) {
            suggestions.push(`Explain how to integrate and run this code.`);
            if (resTextLower.includes('perform') || resTextLower.includes('slow') || resTextLower.includes('optimiz')) {
                suggestions.push(`Can you optimize this code snippet for performance?`);
            } else {
                suggestions.push(`Can you simplify or clean up this code?`);
            }
            suggestions.push(`What are the key parameters and configuration options?`);
        } else {
            suggestions.push(`Can you explain this response in more detail?`);
            suggestions.push(`Are there any alternative approaches to this?`);
            suggestions.push(`What are the next steps for this implementation?`);
        }
    }

    // Cap suggestions at 3 items to avoid cluttering UI
    suggestions = suggestions.slice(0, 3);

    if (suggestions.length === 0) return;

    if (typeof renderPromptSuggestions === 'function') {
        renderPromptSuggestions(suggestions, "Suggested Follow-ups");
    }
}

/** ─── STAGING BAR LOGIC ─── **/
