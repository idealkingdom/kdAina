function getActiveTurn() {
    // The active (newest) turn is the last .chat-turn
    const lastTurn = getLastChatTurn();
    if (lastTurn) {
        return lastTurn;
    }
    // No existing turn — create one and insert before the spacer
    const newTurn = document.createElement('div');
    newTurn.className = 'chat-turn';
    chatbox.appendChild(newTurn);
    return newTurn;
}

function hideLoadingIndicator() {
    document.querySelectorAll('.loading-indicator').forEach(el => el.remove());
}

function showLoadingIndicator() {
    hideLoadingIndicator();
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading-indicator';
    loadingDiv.innerHTML = `<div class="generating-text" style="opacity: 0.5; font-size: 0.9em; margin-bottom: 8px;">Generating...</div>`;
    withAutoScroll(() => getActiveTurn().appendChild(loadingDiv));
}


// --- MESSAGE HANDLING ---

/**
 * Formats and inserts user chat bubble elements into log view.
 */
function appendUserMessage(message, images = [], files = [], isHistory = false) {
    let finalHTML = processMessageContent(message);

    if (files && files.length > 0) {
        files.forEach(file => {
            const id = "file-pill-hist-" + Date.now() + Math.floor(Math.random() * 1000);
            window.inlineFilesMap[id] = file;

            // #46: Match the marker with the pill text. URL pills use ◆, local files use [▪ ]
            const isUrl = file.path && (file.path.startsWith('http://') || file.path.startsWith('https://'));
            const marker = isUrl ? `◆ ${escapeHtml(file.name)}` : `[▪ ${escapeHtml(file.name)}]`;

            const pillHTML = `<span class="inline-attachment-pill file-pill ${isUrl ? 'url-pill scraped' : ''}" contenteditable="false" data-file-id="${id}" onclick="requestOpenFile(this.dataset.fileId)" title="Attached file: ${escapeHtml(file.name)}">${marker}</span>`;

            if (finalHTML.includes(marker)) {
                finalHTML = finalHTML.replace(marker, pillHTML);
            } else {
                finalHTML += ` ${pillHTML}`;
            }
        });
    }

    if (images && images.length > 0) {
        images.forEach(image => {
            const openPath = image.path || image.dataUrl;
            const marker = `[${escapeHtml(image.name)}]`;
            // Link UI logic
            const pillHTML = `<span class="inline-attachment-pill" contenteditable="false" onclick="requestOpenImage('${openPath.replace(/\\/g, '\\\\')}')" title="Click to view image">[${escapeHtml(image.name)}]</span>`;

            if (finalHTML.includes(marker)) {
                finalHTML = finalHTML.replace(marker, pillHTML);
            } else {
                finalHTML += ` ${pillHTML}`;
            }
        });
    }

    const userResponseHTML = `<div class="user-message-wrapper">
        <div class="user-message" data-raw-text="${encodeURIComponent(message)}">
          <div class="user-prompt-header">
            <span class="user-prompt-date">${getCurrentDate()}</span>
            <div class="user-message-actions" style="margin-left: auto;">
                <button class="msg-action-btn retry-btn" title="Retry" onclick="retryLastMessage(this)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>
                  Retry
                </button>
                <button class="msg-action-btn edit-btn" title="Edit & Send" onclick="editUserMessage(this)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  Edit
                </button>
            </div>
          </div>
          <div class="message-content">
            <span class="message-text">${finalHTML}</span>
          </div>
        </div>
      </div>`;

    if (!chatWelcomeMessage.classList.contains('hidden')) {
        chatWelcomeMessage.classList.add('hidden');
        document.querySelector('.chat-container').classList.remove('new-chat');
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = userResponseHTML;
    const turnDiv = document.createElement('div');
    turnDiv.className = 'chat-turn';
    chatbox.appendChild(turnDiv);
    turnDiv.appendChild(tempDiv.firstElementChild);

    // Important: Since we injected new <pre> blocks inside the details, 
    // we might want to re-run syntax highlighting or copy buttons
    if (message.includes("--- ATTACHED CONTEXT ---")) {
        setTimeout(() => {
            hljs.highlightAll();
            addAllCopyButtons();
        }, 0);
    }
    if (!isHistory) {
        // Anchor the view to this new message — sets min-height so it fills the screen
        anchorToNewMessage();
    }
}


function getOrCreateAgentStepsGroup(isHistory) {
    if (isHistory) {
        // History: Return steps container inside details.agent-steps-group (already finalized/historical)
        let detailsEl = chatbox.querySelector('details.agent-steps-group[data-history="true"]:not([data-finalized="true"])');
        if (!detailsEl) {
            detailsEl = document.createElement('details');
            detailsEl.className = 'agent-steps-group';
            detailsEl.open = false; // History groups start collapsed
            detailsEl.dataset.startTime = Date.now();
            detailsEl.dataset.history = 'true';

            const summary = document.createElement('summary');
            summary.className = 'agent-steps-summary';
            summary.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="9 18 15 12 9 6"></polyline></svg> <span class="summary-text">Completed steps</span>`;
            detailsEl.appendChild(summary);

            const stepsContainer = document.createElement('div');
            stepsContainer.className = 'agent-steps-container';
            stepsContainer.dataset.finalized = 'true';
            detailsEl.appendChild(stepsContainer);

            const activeTurn = getActiveTurn();
            const loadingIndicator = activeTurn.querySelector('.loading-indicator');
            if (loadingIndicator) {
                activeTurn.insertBefore(detailsEl, loadingIndicator);
            } else {
                activeTurn.appendChild(detailsEl);
            }
            return stepsContainer;
        }
        return detailsEl.querySelector('.agent-steps-container');
    }

    // Live Execution: Return a flat div.agent-steps-container. No parent details/timer wrapper is shown yet.
    let container = chatbox.querySelector('div.agent-steps-container:not([data-finalized="true"])');
    if (!container) {
        container = document.createElement('div');
        container.className = 'agent-steps-container';
        container.dataset.startTime = String(Date.now());

        const activeTurn = getActiveTurn();
        const loadingIndicator = activeTurn.querySelector('.loading-indicator');
        if (loadingIndicator) {
            activeTurn.insertBefore(container, loadingIndicator);
        } else {
            activeTurn.appendChild(container);
        }
    }
    return container;
}


// ─── WAITING INDICATOR ──────────────────────────────────────────────────────
// Shows a pulsing "Analyzing..." between tool completions and the model's
// next action. Fills the visual dead zone so the user never sees a frozen UI.
