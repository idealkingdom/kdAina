/**
 * Webview message listeners, history loaders, and window stream events handler.
 */
// --- EVENT LISTENERS ---
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'focus':
            // Only autofocus if the user isn't using another input (like search)
            if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                if (chatMessage && !chatMessage.disabled) {
                    chatMessage.focus();
                }
                setTimeout(() => {
                    if (chatMessage && !chatMessage.disabled) {
                        chatMessage.focus();
                    }
                }, 100);
            }
            break;
        case 'searchFilesResult':
            {
                if (autocompleteType !== '@') { break; }
                const fileResults = message.results || [];
                // Merge: keep any matched commands at the top, then add file results
                const commandMatches = filteredItems.filter(item => item.label && !item.path);
                filteredItems = [...commandMatches, ...fileResults];
                if (filteredItems.length === 0) {
                    hideAutocomplete();
                    break;
                }
                selectedIndex = 0;
                renderAutocomplete();
                break;
            }
        case CHAT_COMMANDS.CHAT_ID_UPDATE:
            // When a new chat is started, backend replies with the assigned UUID
            // We MUST set this immediately so if the user clicks "Stop Request"
            // during the first turn, the abort command sends the correct ID.
            chatLog.dataset.chatId = message.content.uid;
            break;
        case CHAT_COMMANDS.CHAT_REQUEST:
            hideLoadingIndicator();
            if (message.role === ROLE.USER) {
                appendUserMessage(message.content, message.images, message.files);
                if (!message.isHistory) {
                    showLoadingIndicator();
                }
            } else {
                if (message.agentSteps && message.agentSteps.length > 0) {
                    for (const step of message.agentSteps) {
                        // Tag steps so renderAgentStep knows to skip the live timer
                        if (message.isHistory) { step._isHistory = true; }
                        renderAgentStep(step);
                    }
                    finalizeAgentStepsForHistory();
                }
                if (message.content) {
                    appendAIMessage(message.content);
                }
            }
            // Re-enable send button
            toggleSendButton("off");
            break;

        case CHAT_COMMANDS.CHAT_STREAM_START:
            isGenerating = true;
            toggleSendButton("generating");
            activeStreamAccumulator = "";
            activeStreamNode = null;
            break;

        case CHAT_COMMANDS.CHAT_STREAM_CHUNK:
            if (!activeStreamNode) {
                appendAIMessage(""); // Create empty blank message

                // Get reference to the newly created blank message
                const aiMessages = chatbox.querySelectorAll('.system-message .message-text');
                if (aiMessages.length > 0) {
                    activeStreamNode = aiMessages[aiMessages.length - 1];
                }
            }

            if (activeStreamNode) {
                activeStreamAccumulator += message.content;

                // Batch markdown re-parse: only once per animation frame
                if (!activeStreamNode._renderPending) {
                    activeStreamNode._renderPending = true;
                    const runShowLastChat = shouldAutoScroll();
                    requestAnimationFrame(() => {
                        if (activeStreamNode) {
                            activeStreamNode.innerHTML = marked.parse(activeStreamAccumulator);
                            activeStreamNode._renderPending = false;
                            if (runShowLastChat) showLastChat();
                        }
                    });
                }
            }

            // ALWAYS send ACK back — even if rendering failed
            // Without this, the backend hangs forever waiting for the ACK → deadlock
            if (message.seq) {
                sendMessage(CHAT_COMMANDS.CHAT_CHUNK_ACK, { seq: message.seq });
            }
            break;

        case CHAT_COMMANDS.CHAT_STREAM_END:
            hideLoadingIndicator(); // Always hide loading, even if no chunks arrived
            clearWaitingIndicator(); // Remove any between-step indicator

            // Finalize open agent groups by wrapping them in details
            document.querySelectorAll('div.agent-steps-container:not([data-finalized="true"])').forEach(container => {
                if (container.children.length === 0) {
                    container.remove();
                } else {
                    const startTime = parseInt(container.dataset.startTime || '0', 10);
                    const ms = startTime ? Date.now() - startTime : 0;
                    const secs = Math.floor(ms / 1000);

                    // Create the wrapper details element
                    const details = document.createElement('details');
                    details.className = 'agent-steps-group';
                    details.open = false; // Collapse by default after completion
                    details.dataset.finalized = "true";

                    const summary = document.createElement('summary');
                    summary.className = 'agent-steps-summary';
                    
                    let label = '';
                    if (secs === 0) {
                        label = 'Completed steps';
                    } else if (secs >= 60) {
                        const mins = Math.floor(secs / 60);
                        const remainingSecs = secs % 60;
                        label = `Worked for ${mins}m${remainingSecs > 0 ? ` ${remainingSecs}s` : ''}`;
                    } else {
                        label = `Worked for ${secs}s`;
                    }
                    
                    summary.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="9 18 15 12 9 6"></polyline></svg> <span class="summary-text">${label}</span>`;
                    
                    details.appendChild(summary);

                    // Insert details wrapper and move container inside it
                    const parent = container.parentNode;
                    if (parent) {
                        parent.insertBefore(details, container);
                        details.appendChild(container);
                    }

                    container.dataset.finalized = "true";
                }
            });

            // #44: Finalize any open thinking blocks
            document.querySelectorAll('.agent-thinking-block:not([data-finalized="true"])').forEach(thinkingBlock => {
                thinkingBlock.dataset.finalized = 'true';
                thinkingBlock.classList.remove('streaming');
                thinkingBlock.open = false;

                // Stop elapsed timer
                if (thinkingBlock.dataset.thinkTimer) {
                    clearInterval(parseInt(thinkingBlock.dataset.thinkTimer));
                }

                const label = thinkingBlock.querySelector('.thinking-label');
                const tokens = parseInt(thinkingBlock.dataset.tokens || '0', 10);
                const startTime = parseInt(thinkingBlock.dataset.thinkStart || '0', 10);
                const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;

                if (label) {
                    let labelText = elapsed > 0 ? `Thought for ${elapsed}s` : 'Thought process';
                    if (tokens > 0) {
                        labelText += ` · ${tokens} tokens`;
                    }
                    label.textContent = labelText;
                }
            });

            if (activeStreamNode) {
                if (!activeStreamAccumulator) {
                    const parentBubble = activeStreamNode.closest('.system-message');
                    if (parentBubble) {
                        parentBubble.remove();
                    }
                } else {
                    // Force a final synchronous render before clearing references
                    activeStreamNode.innerHTML = marked.parse(activeStreamAccumulator);
                    activeStreamNode._renderPending = false;
                    // Capture accumulator text before it's cleared below
                    const finalResponseText = activeStreamAccumulator;
                    setTimeout(() => {
                        hljs.highlightAll();
                        addAllCopyButtons();
                        const systemMsgEl = activeStreamNode ? activeStreamNode.closest('.system-message') : null;
                        if (systemMsgEl) {
                            const timeEl = systemMsgEl.querySelector('.message-time');
                            if (timeEl) {
                                timeEl.textContent = getCurrentDate();
                            }
                        }
                        appendFilesSummary(getActiveTurn());
                        appendFollowUpSuggestions(getActiveTurn(), finalResponseText);
                        scrollToBottom(true);
                    }, 0);
                }
            }

            // #48: Check if AI ended with a question
            if (activeStreamAccumulator && detectsQuestion(activeStreamAccumulator)) {
                // Find active agent name
                const agentLabel = document.querySelector('.agent-selector-label');
                const agentName = agentLabel ? agentLabel.textContent.trim() : 'Agent';
                showQuestionBanner(agentName);
            }

            activeStreamNode = null;
            activeStreamAccumulator = "";
            isGenerating = false;
            toggleSendButton("off");
            break;

        case CHAT_COMMANDS.CHAT_CONTINUE_PROMPT:
            {
                const { chatId, agentId, extraSteps, stepsUsed } = message.data;
                // Remove any existing continue banner
                document.querySelectorAll('.continue-banner').forEach(b => b.remove());

                const banner = document.createElement('div');
                banner.className = 'continue-banner';
                banner.innerHTML = `
                    <div class="continue-banner-content">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
                        <span>Agent reached the step limit (${stepsUsed} steps). There may be more work to do.</span>
                        <button class="continue-btn" id="continueAgentBtn">Continue</button>
                        <button class="continue-dismiss-btn" id="dismissContinueBtn">Dismiss</button>
                    </div>
                `;
                withAutoScroll(() => document.getElementById('chatLog').appendChild(banner));

                document.getElementById('continueAgentBtn').addEventListener('click', () => {
                    banner.remove();
                    showLoadingIndicator();
                    isGenerating = true;
                    toggleSendButton("on");
                    sendMessage(CHAT_COMMANDS.CHAT_CONTINUE, {
                        chatId,
                        agentId
                    });
                });

                document.getElementById('dismissContinueBtn').addEventListener('click', () => {
                    banner.remove();
                });
                break;
            }

        // Case: Resetting the view / New Chat
        case CHAT_COMMANDS.CHAT_RESET:
            resetChat(message.content);
            break;

        // Backend asks frontend to initiate detach (from VS Code header button)
        case 'requestDetach':
            if (isGenerating) {
                // Show inline warning — can't detach during active generation
                const warnEl = document.createElement('div');
                warnEl.className = 'detach-warning';
                warnEl.textContent = 'Cannot detach while a request is in progress. Please wait or stop the request first.';
                warnEl.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);background:rgba(220,38,38,0.9);color:#fff;padding:8px 16px;border-radius:8px;font-size:0.82rem;z-index:9999;animation:fadeOut 3s forwards;';
                document.body.appendChild(warnEl);
                setTimeout(() => warnEl.remove(), 3000);
                break;
            }
            {
                const chatId = chatLog?.dataset?.chatId || '';
                // Only detach if there's an actual conversation
                if (chatId && chatMessages.children.length > 0) {
                    sendMessage('detachChat', { chatId });
                } else {
                    // Nothing to detach — just open a blank popup
                    sendMessage('detachChat', {});
                }
            }
            break;

        // Popup: load a conversation by emulating history click
        case 'loadChatInPopup':
            if (message.chatId) {
                sendMessage(CHAT_COMMANDS.CHAT_LOAD, { chatId: message.chatId });
            }
            break;

        case CHAT_COMMANDS.HISTORY_LOAD:
            showHistoryView(message.content); // Call the global function
            break;

        // TODO: Implement file context handling
        case CHAT_COMMANDS.FILE_CONTEXT_ADDED:
            const fileData = message.content;
            insertInlineFile(fileData.name, fileData.text, fileData.language, fileData.path);
            break;

        case CHAT_COMMANDS.IMAGE_CONTEXT_ADDED:
            const imgData = message.content;
            insertInlineImage(imgData.dataUrl, imgData.name);
            break;

        case CHAT_COMMANDS.PROBLEM_CONTEXT_ADDED:
            const problemData = message.content;
            insertInlineFile(problemData.name, problemData.text, problemData.language, problemData.path);
            break;

        case CHAT_COMMANDS.CHAT_AGENT_STEP:
            renderAgentStep(message.content);
            break;

        case CHAT_COMMANDS.CHAT_APPROVAL_UPDATE:
            {
                const { toolCallId, approved } = message.data;
                updateCardApproval(toolCallId, approved);
                break;
            }

        case 'chatStagingUpdate':
            updateStagingBar(message.content.stagedFilesCount);
            // Update header pill
            const reviewPill = document.getElementById('count-reviews');
            if (reviewPill) {
                reviewPill.textContent = message.content.stagedFilesCount;
            }
            break;

        case 'chatUsageUpdate':
            const tokenPill = document.getElementById('count-tokens');
            if (tokenPill && message.usage) {
                const total = message.usage.totalTokens || 0;
                tokenPill.textContent = total > 1000 ? (total / 1000).toFixed(1) + 'k' : total;
            }
            break;

        case 'reviewHunksData':
            if (hunkReviewState) {
                // Update state in place for real-time refresh
                hunkReviewState.files = (message.content || []).map(f => ({
                    ...f,
                    hunks: (f.hunks || []).map(h => ({ ...h, accepted: true }))
                }));
                renderHunkReviewPanel();
            } else if (message.openPanel && message.content && message.content.length > 0) {
                // Explicit user request to open the panel
                openHunkReviewPanel(message.content);
            }
            break;

        case 'uiSettingsUpdate':
            applyUISettings(message.ui);
            break;

        case 'improvedPrompt':
            {
                const generateBtn = document.getElementById('generateButton');
                if (generateBtn) generateBtn.classList.remove('loading');

                const input = document.getElementById('messageInput');
                if (input && message.content) {
                    input.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, message.content);
                }
            }
            break;

        case 'suggestPromptsResult':
            {
                const generateBtn = document.getElementById('generateButton');
                if (generateBtn) generateBtn.classList.remove('loading');

                const suggestions = message.suggestions || [];
                if (suggestions.length > 0) {
                    // Remove existing chips
                    const existing = document.querySelector('.prompt-suggestion-chips');
                    if (existing) existing.remove();

                    const chipsContainer = document.createElement('div');
                    chipsContainer.className = 'prompt-suggestion-chips';

                    suggestions.forEach(text => {
                        const chip = document.createElement('button');
                        chip.className = 'suggestion-chip';
                        chip.textContent = text;
                        chip.addEventListener('click', () => {
                            const input = document.getElementById('messageInput');
                            if (input) {
                                input.innerText = text;
                                input.focus();
                                const range = document.createRange();
                                const sel = window.getSelection();
                                range.selectNodeContents(input);
                                range.collapse(false);
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                            chipsContainer.remove();
                        });
                        chipsContainer.appendChild(chip);
                    });

                    // Insert chips above the input container
                    const editorWrapper = document.querySelector('.editor-wrapper');
                    if (editorWrapper) {
                        editorWrapper.insertBefore(chipsContainer, editorWrapper.querySelector('.unified-input-container'));
                    }
                }
            }
            break;

        case 'fileSaveStatus':
            if (hunkReviewState && message.content) {
                const file = hunkReviewState.files.find(f => f.uri === message.content.uri);
                if (file) {
                    file.savedByUser = true;
                    renderHunkReviewPanel();
                }
            }
            break;

        case 'indexUpdate':
            {
                const indexPill = document.getElementById('count-index');
                if (indexPill && message.content) {
                    indexPill.textContent = message.content.fileCount || '0';
                    const pillEl = document.getElementById('pill-index');
                    if (pillEl) {
                        pillEl.title = `Workspace Index: ${message.content.fileCount} files — Last updated: ${new Date(message.content.lastUpdated).toLocaleTimeString()} — Click to View`;
                    }
                }
                // Store the file list for the viewer
                if (message.content && message.content.fileList) {
                    window._indexedFiles = message.content.fileList;
                    window._indexLastUpdated = message.content.lastUpdated;
                }
                // Open the viewer if requested, or update it in place if it's already open
                const isViewerOpen = !!document.getElementById('index-viewer-overlay');
                if (message.content && (message.content.showViewer || isViewerOpen)) {
                    openIndexViewer(message.content.fileList || [], message.content.fileCount, message.content.lastUpdated);
                }
                break;
            }

        case 'agentsUpdate':
            if (window.VS_CONSTANTS) {
                window.VS_CONSTANTS.AGENTS = message.agents;
            }
            renderAgentDropdown(message.agents);
            // On first load, auto-select the first active agent instead of "Chat"
            if (activeAgentId === 'default' && message.agents && message.agents.length > 0) {
                const firstActive = message.agents.find(a => a.isActive);
                if (firstActive) {
                    activeAgentId = firstActive.id;
                    persistAgentSelection();
                }
            }
            updateActiveAgentUI(activeAgentId, message.agents);
            break;

        case 'modelsUpdate':
            if (message.models) {
                if (window.VS_CONSTANTS) {
                    window.VS_CONSTANTS.MODELS = message.models;
                    if (message.customModels) {
                        window.VS_CONSTANTS.CUSTOM_MODELS = message.customModels;
                    }
                    if (message.availableModels) {
                        window.VS_CONSTANTS.AVAILABLE_MODELS = message.availableModels;
                    }
                }
                MODELS = message.models;
                initModelDropdown();
            }
            break;

        case CHAT_COMMANDS.CHAT_STATE_REHYDRATE:
            rehydrateState(message.content);
            break;

        // Live settings sync — apply all changes immediately from settings panel
        case 'settingsChanged':
            {
                const s = message.settings;
                if (!s) break;

                // 1. Models + Custom Models
                if (s.models) {
                    MODELS = s.models;
                    if (window.VS_CONSTANTS) {
                        window.VS_CONSTANTS.MODELS = s.models;
                    }
                }
                // Always sync customModels (deletions, additions, active toggles)
                if (window.VS_CONSTANTS) {
                    window.VS_CONSTANTS.CUSTOM_MODELS = s.customModels || [];
                }
                // Refresh model dropdown if we have model data
                if (s.models) {
                    initModelDropdown();
                }

                // 2. Permissions
                if (s.permissions) {
                    PERMISSIONS = s.permissions;
                    if (window.VS_CONSTANTS) window.VS_CONSTANTS.PERMISSIONS = s.permissions;
                    // Refresh permission UI
                    const isAP = s.permissions.alwaysProceed === true;
                    if (tbAlwaysProceed) tbAlwaysProceed.checked = isAP;
                    if (tbReadPerm) {
                        tbReadPerm.value = isAP ? 'auto' : (s.permissions.readFilesConfirmation ? 'ask' : 'auto');
                        tbReadPerm.disabled = isAP;
                        tbReadPerm.style.opacity = isAP ? '0.4' : '1';
                    }
                    if (tbWritePerm) {
                        tbWritePerm.value = isAP ? 'auto' : (s.permissions.writeFilesConfirmation ? 'ask' : 'auto');
                        tbWritePerm.disabled = isAP;
                        tbWritePerm.style.opacity = isAP ? '0.4' : '1';
                    }
                    if (tbCmdPerm) {
                        tbCmdPerm.value = isAP ? 'auto' : ((s.permissions.commandSafetyMode && s.permissions.commandSafetyMode !== 'none') ? 'ask' : 'auto');
                        tbCmdPerm.disabled = isAP;
                        tbCmdPerm.style.opacity = isAP ? '0.4' : '1';
                    }
                }

                // 3. Agents
                if (s.prompts) {
                    if (window.VS_CONSTANTS) window.VS_CONSTANTS.AGENTS = s.prompts;
                    renderAgentDropdown(s.prompts);
                    updateActiveAgentUI(activeAgentId, s.prompts);
                }

                // 4. UI (CSS + allowExternalMedia)
                if (s.ui) {
                    applyUISettings(s.ui);
                    applyExternalMediaSetting(s.ui.allowExternalMedia);
                }
            }
            break;

        default:
            console.error('Unknown command:', message.command);
    }
});

function rehydrateState(data) {
    const { chatId, messages, stagedFilesCount, agentId } = data;

    // 1. Reset the UI for the chat ID
    resetChat({ uid: chatId, agentId: agentId });

    // 2. Add all messages
    if (messages && Array.isArray(messages)) {
        messages.forEach(msg => {
            if (msg.role === ROLE.USER) {
                appendUserMessage(msg.message, msg.images || [], msg.files || [], true);
            } else {
                if (msg.agentSteps && msg.agentSteps.length > 0) {
                    for (const step of msg.agentSteps) {
                        step._isHistory = true;
                        renderAgentStep(step);
                    }
                    finalizeAgentStepsForHistory();
                }
                
                if (msg.message || !msg.agentSteps || msg.agentSteps.length === 0) {
                    appendAIMessage(msg.message);
                }
            }
        });
    }

    // 3. Update staging bar
    updateStagingBar(stagedFilesCount);

    // 4. Highlight code
    setTimeout(() => {
        if (typeof hljs !== 'undefined') hljs.highlightAll();
        addAllCopyButtons();

        // Force scroll to bottom when loading history
        scrollToBottom(true);
    }, 50);
}

// ─── SHARED FINALIZATION HELPER ─────────────────────────────────────────────
// Finalizes any open thinking blocks and agent step groups for history rendering.
// Used by both the CHAT_REQUEST (history load) and rehydrateState (VS Code reload) paths.
// NOTE: CHAT_STREAM_END has its own version with live-timer elapsed-time logic.
function finalizeAgentStepsForHistory() {
    document.querySelectorAll('.agent-thinking-block:not([data-finalized="true"])').forEach(thinkingBlock => {
        thinkingBlock.dataset.finalized = 'true';
        thinkingBlock.classList.remove('streaming');
        thinkingBlock.open = false;
        const label = thinkingBlock.querySelector('.thinking-label');
        if (label && !label.textContent.includes('Thought for')) {
            label.textContent = 'Thought process';
        }
    });

    document.querySelectorAll('details.agent-steps-group:not([data-finalized="true"])').forEach(group => {
        if (group.dataset.timer) {
            clearInterval(parseInt(group.dataset.timer));
            delete group.dataset.timer;
        }
        const summaryText = group.querySelector('.summary-text');
        if (summaryText) {
            summaryText.textContent = 'Completed steps';
        }
        group.open = false;
        group.dataset.finalized = "true";
        
        const container = group.querySelector('div.agent-steps-container');
        if (container) {
            container.dataset.finalized = "true";
        }
    });

    document.querySelectorAll('div.agent-steps-container:not([data-finalized="true"])').forEach(container => {
        if (container.children.length === 0) {
            container.remove();
        } else {
            const details = document.createElement('details');
            details.className = 'agent-steps-group';
            details.open = false;
            details.dataset.finalized = "true";

            const summary = document.createElement('summary');
            summary.className = 'agent-steps-summary';
            summary.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="9 18 15 12 9 6"></polyline></svg> <span class="summary-text">Completed steps</span>`;
            details.appendChild(summary);

            const parent = container.parentNode;
            if (parent) {
                parent.insertBefore(details, container);
                details.appendChild(container);
            }
            container.dataset.finalized = "true";
        }
    });
}