/**
 * Appends system/AI messages to the active chat bubble block.
 */
function appendAIMessage(response) {
    const parsedResponse = marked.parse(response);
    const systemResponseHTML = `<div class="system-message">
            <div class="message-content">
                <span class="message-text">${parsedResponse}</span>
                <div class="message-footer">
                    <div class="message-time">${getCurrentDate()}</div>
                </div>
            </div>
            </div>`;


    if (!chatWelcomeMessage.classList.contains('hidden')) {
        chatWelcomeMessage.classList.add('hidden');
        document.querySelector('.chat-container').classList.remove('new-chat');
    }


    const tempDiv = document.createElement('div');


    tempDiv.innerHTML = systemResponseHTML;

    const newMessageElement = tempDiv.firstElementChild;

    withAutoScroll(() => {
        const activeTurn = getActiveTurn();
        activeTurn.appendChild(newMessageElement);
        hljs.highlightAll();
        addAllCopyButtons();
        if (response && response.trim() !== "") {
            appendFilesSummary(activeTurn);
            appendFollowUpSuggestions(activeTurn, response);
        }
    });
}


function chatRequest(content) {
    sendMessage('chatRequest', content);
    appendUserMessage(content.message, content.images, content.files, false);
}



function resetChat(content) {
    // Clear any outstanding group timers before wiping the DOM
    // to prevent leaked setInterval callbacks referencing detached nodes
    document.querySelectorAll('details.agent-steps-group').forEach(group => {
        if (group.dataset.timer) {
            clearInterval(parseInt(group.dataset.timer));
        }
    });
    document.querySelectorAll('.agent-thinking-block').forEach(block => {
        if (block.dataset.thinkTimer) {
            clearInterval(parseInt(block.dataset.thinkTimer));
        }
    });
    clearWaitingIndicator();
    chatMessages.innerHTML = '';

    chatLog.dataset.chatId = content.uid;
    isGenerating = false;
    toggleSendButton("off");
    attachedImages = [];
    attachedFiles = [];
    renderAttachments();

    // Reset token usage display
    const tokenPill = document.getElementById('count-tokens');
    if (tokenPill) {
        tokenPill.textContent = '0';
    }

    chatWelcomeMessage.classList.remove('hidden');
    document.querySelector('.chat-container').classList.add('new-chat');
    showChatView(); // Make sure we're on the chat view
    chatMessage.focus();

    // Only reset agent if the content explicitly provides one (e.g. loading from history)
    // New chat should preserve whatever agent the user currently has selected
    if (content.agentId !== undefined) {
        updateActiveAgentUI(content.agentId);
    }
}



let currentUndoButton = null;

/**
 * Undo: open a warning confirmation modal before proceeding.
 */
function undoMessage(btn) {
    currentUndoButton = btn;
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.classList.add('active');
    }
}

/**
 * Execute the undo: copy message to input box, discard workspace changes, truncate DB.
 */
function executeUndo(btn) {
    const userMsgEl = btn.closest('.user-message');
    if (!userMsgEl) return;

    const rawText = decodeURIComponent(userMsgEl.dataset.rawText || '');

    // Find exact user message index for robust backend deletion
    const allUserMessages = Array.from(chatbox.querySelectorAll('.user-message'));
    const userMsgIdx = allUserMessages.indexOf(userMsgEl);

    // Blast away all DOM nodes that come after and include targetUserMsg
    let wrapper = userMsgEl.closest('.user-message-wrapper') || userMsgEl;
    let turnDiv = wrapper.closest('.chat-turn') || wrapper;

    // 1. Remove all siblings after the user message inside the turnDiv
    let nextNode = wrapper.nextSibling;
    while (nextNode) {
        const toRemove = nextNode;
        nextNode = nextNode.nextSibling;
        toRemove.remove();
    }

    // 2. Remove all subsequent turnDivs
    let nextTurn = turnDiv.nextSibling;
    while (nextTurn) {
        const toRemove = nextTurn;
        nextTurn = nextTurn.nextSibling;
        toRemove.remove();
    }

    // 3. Remove the turnDiv itself
    turnDiv.remove();

    // If chat is empty, show welcome message
    if (chatbox.children.length === 0 && chatWelcomeMessage) {
        chatWelcomeMessage.classList.remove('hidden');
        const chatContainer = document.querySelector('.chat-container');
        if (chatContainer) chatContainer.classList.add('new-chat');
    }

    // Copy text to input box
    chatMessage.innerText = rawText;
    chatMessage.focus();

    // Move caret to end of input box
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(chatMessage);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    // Trigger input event to resize/toggle send button
    if (typeof toggleSendButton === 'function') {
        toggleSendButton("off"); // enables send button if text is present
    }

    // Send message to backend to delete from database and discard all pending workspace changes
    sendMessage(CHAT_COMMANDS.CHAT_UNDO, {
        chat_id: chatLog.dataset.chatId,
        userMsgIdx: userMsgIdx >= 0 ? userMsgIdx : undefined
    });
}




// 1. Send Button Click
sendButton.addEventListener("click", event => {
    if (isGenerating) {
        // Cancel ongoing request
        vscode.postMessage({
            command: 'cancelChatRequest',
            data: { chat_id: chatLog.dataset.chatId }
        });
        isGenerating = false;
        toggleSendButton("off");
        hideLoadingIndicator();

        // Immediate visual feedback: append a stopped badge
        if (activeStreamNode) {
            const stopBadge = document.createElement('div');
            stopBadge.className = 'status-badge status-stopped';
            stopBadge.style.marginTop = '8px';
            stopBadge.innerHTML = `■ Generation stopped by user`;
            activeStreamNode.parentElement.appendChild(stopBadge);
        }
        return;
    }
    const imagePills = chatMessage.querySelectorAll('.inline-attachment-pill[data-image="true"]');
    const dynamicAttachedImages = [];
    const usedNames = new Set();

    imagePills.forEach(pill => {
        let name = pill.dataset.name;
        let originalName = name;
        let counter = 1;
        while (usedNames.has(name)) {
            const dotRegex = /(.*)(\.[a-zA-Z0-9]+)$/;
            const match = originalName.match(dotRegex);
            if (match) {
                name = `${match[1]}_${counter}${match[2]}`;
            } else {
                name = `${originalName}_${counter}`;
            }
            counter++;
        }
        usedNames.add(name);

        if (pill.dataset.name !== name) {
            pill.dataset.name = name;
            pill.innerHTML = `[${escapeHtml(name)}]`;
        }

        dynamicAttachedImages.push({
            name: name,
            dataUrl: pill.dataset.url
        });
    });

    const filePills = chatMessage.querySelectorAll('.inline-attachment-pill[data-file="true"]');
    const dynamicAttachedFiles = [];
    filePills.forEach(pill => {
        const fileId = pill.dataset.fileId;
        const fileData = window.inlineFilesMap && window.inlineFilesMap[fileId];
        if (fileData) {
            dynamicAttachedFiles.push(fileData);
        }
    });

    const messageText = chatMessage.innerText.trim();

    // Combine inline files and externally attached files (if any still use the old method)
    const allFiles = attachedFiles.concat(dynamicAttachedFiles);

    const blueprintChip = document.querySelector('.essence-suggestion-chip[data-file-id="blueprint"]');
    const skillChip = document.querySelector('.essence-suggestion-chip[data-file-id="skill"]');
    const createBlueprint = blueprintChip ? blueprintChip.classList.contains('selected') : false;
    const createSkill = skillChip ? skillChip.classList.contains('selected') : false;

    // Build a visible display message when only essence chips are selected
    let displayMessage = messageText;
    if (!displayMessage && (createBlueprint || createSkill)) {
        const parts = [];
        if (createBlueprint) parts.push('blueprint.md');
        if (createSkill) parts.push('skill.md');
        displayMessage = `Create ${parts.join(' and ')}`;
    }

    // Update Condition: Check for files and essence selections too
    if (messageText || dynamicAttachedImages.length > 0 || allFiles.length > 0 || createBlueprint || createSkill) {

        // --- PREPARE PAYLOAD ---
        const payload = {
            message: displayMessage,
            images: dynamicAttachedImages,

            // CRITICAL: Send the attached files to the backend
            files: allFiles,

            agentId: activeAgentId,

            chat_id: chatLog.dataset.chatId,
            timestamp: new Date().toISOString(),

            createBlueprint: createBlueprint,
            createSkill: createSkill
        };

        // --- SEND ---
        sendMessage(CHAT_COMMANDS.CHAT_REQUEST, payload);

        // --- UI CLEANUP ---
        hideQuestionBanner(); // #48: Dismiss question banner on reply
        showLoadingIndicator(); // Show dots while waiting for backend echo
        toggleSendButton("disabled");

        chatMessage.innerHTML = "";

        // Remove essence suggestions container immediately
        const suggestionsContainer = document.querySelector('.essence-suggestions-container');
        if (suggestionsContainer) {
            suggestionsContainer.remove();
        }

        // Clear files array
        attachedFiles = [];
        // No need to clear attachedImages since they are dynamically populated

        renderAttachments(); // Removes the file pills from the screen
    }
});

/**
 * Parses raw message text to separate user message from file attachments.
 * Returns HTML string with collapsible details.
 */
function processMessageContent(rawText) {
    const splitMarker = "--- ATTACHED CONTEXT ---";

    // 1. If no attachments, just return formatted text
    if (!rawText.includes(splitMarker)) {
        return escapeHtml(rawText).replace(/\n/g, "<br>");
    }

    // 2. Split: [User Text, The Big Code Block]
    const parts = rawText.split(splitMarker);
    const userMessage = parts[0].trim();
    const contextBlock = parts[1];

    // 3. Format User Message
    let html = escapeHtml(userMessage).replace(/\n/g, "<br>");

    // 4. Return just the user message
    return html;
}


window.addEventListener('DOMContentLoaded', () => {
    sendMessage("ChatWebviewReady");
    initGenerateButton();

    // Initialize Undo Warning Modal buttons
    const modal = document.getElementById('confirm-modal');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            if (modal) modal.classList.remove('active');
            currentUndoButton = null;
        });
    }
    
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            if (modal) modal.classList.remove('active');
            if (currentUndoButton) {
                executeUndo(currentUndoButton);
                currentUndoButton = null;
            }
        });
    }

    const input = document.getElementById("messageInput");

    input.addEventListener("keydown", (event) => {
        if (autocompleteActive) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                selectedIndex = (selectedIndex + 1) % filteredItems.length;
                renderAutocomplete();
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                selectedIndex = (selectedIndex - 1 + filteredItems.length) % filteredItems.length;
                renderAutocomplete();
                return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                confirmAutocompleteSelection();
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                hideAutocomplete();
                return;
            }
        }

        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!sendButton.classList.contains('disabled')) {
                sendButton.click();
            }
        }
    });

    input.addEventListener("input", (event) => {
        if (typeof toggleSendButton === 'function') {
            toggleSendButton("off");
        }
        // Remove suggestions chips on typing if the input is not empty
        if (input.innerText.trim() !== '') {
            const existing = document.querySelector('.prompt-suggestion-chips');
            if (existing) existing.remove();
        }


        const text = input.innerText;
        const cursorPosition = getCaretPosition(input);
        const textBeforeCursor = text.substring(0, cursorPosition);

        // Find the last trigger character before the cursor
        const lastAt = textBeforeCursor.lastIndexOf('@');
        const lastSlash = textBeforeCursor.lastIndexOf('/');
        const lastTriggerIdx = Math.max(lastAt, lastSlash);

        if (lastTriggerIdx !== -1) {
            const potentialTrigger = textBeforeCursor[lastTriggerIdx];
            // Check if trigger is at start or preceded by whitespace
            const charBeforeTrigger = textBeforeCursor[lastTriggerIdx - 1];
            if (!charBeforeTrigger || /\s/.test(charBeforeTrigger)) {
                autocompleteType = potentialTrigger;
                triggerQuery = textBeforeCursor.substring(lastTriggerIdx + 1);

                // Query shouldn't contain spaces (if it does, user moved past the command)
                if (!/\s/.test(triggerQuery)) {
                    updateAutocompleteItems(triggerQuery);
                    return;
                }
            }
        }

        if (autocompleteActive) {
            hideAutocomplete();
        }
    });

    input.addEventListener("focusout", () => {
        if (!input.textContent.trim().length) {
            input.textContent = "";
        }
    });


    input.addEventListener("paste", (event) => {
        // 1. Stop all native pasting
        event.preventDefault();
        const clipboardData = event.clipboardData || window.clipboardData;

        // 2. Handle images
        if (clipboardData.files && clipboardData.files.length > 0) {
            if (Array.from(clipboardData.files).some(file => file.type.startsWith('image/'))) {
                handleImageFiles(clipboardData.files, 'paste');
                return;
            }
        }

        // 3. Handle Text
        const text = clipboardData.getData('text/plain');
        if (!text) { return; };

        // #46: Detect if the pasted text is a URL
        const urlPattern = /^https?:\/\/[^\s]+$/i;
        if (urlPattern.test(text.trim())) {
            const url = text.trim();
            const urlId = 'url-' + Date.now();
            const pill = `<span class="inline-attachment-pill url-pill" contenteditable="false" data-url="${url}" data-url-id="${urlId}" title="Click to scrape: ${url}" onclick="handleUrlScrape(this)">◆ ${new URL(url).hostname}${new URL(url).pathname.substring(0, 30)}</span>&nbsp;`;

            // Wrap in setTimeout to avoid "execCommand() ... called recursively" error
            setTimeout(() => {
                document.execCommand('insertHTML', false, pill);
                // URL stays as a clickable pill — user can click to scrape manually
            }, 0);
            return;
        }

        // 4. Escape the text for HTML
        const escapedText = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        // Note: We don't replace \n with <br> because our CSS
        // 'white-space: pre-wrap' already handles newlines correctly.

        // 5. Use 'insertHTML'. This command inserts our plain, escaped text
        //    and correctly adds the action to the undo/redo stack.
        setTimeout(() => {
            document.execCommand('insertHTML', false, escapedText);
        }, 50);

    });


    imageUploadInput.addEventListener('change', (e) => {
        if (e.target.files) {
            handleImageFiles(e.target.files, 'upload');
            e.target.value = null;
        }
    });


    // --- End of Listeners ---

    renderAttachments();
    input.focus();

    // Configure marked
    marked.setOptions({
        highlight: function (code, lang) {
            if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
            }
            return hljs.highlightAuto(code).value;
        },
        langPrefix: 'hljs language-',
        gfm: true,
        breaks: true
    });


    // Toggle Menu
    attachBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent immediate closing
        contextMenu.classList.toggle('hidden');
        if (modelOptionsMenu) modelOptionsMenu.classList.add('hidden');
        if (permsOptionsMenu) permsOptionsMenu.classList.add('hidden');
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target) && e.target !== attachBtn) {
            contextMenu.classList.add('hidden');
        }

        // Hide autocomplete if clicking outside
        if (autocompleteActive && !autocompleteMenu.contains(e.target) && e.target !== input) {
            hideAutocomplete();
        }
    });

    // Handle Item Clicks
    contextMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.context-item');
        if (!item) {
            return;
        }

        const type = item.dataset.type;

        // 1. Media — open file picker (browser input)
        if (type === 'media') {
            imageUploadInput.click();
        }
        // 2. Mentions — insert @ into input to trigger autocomplete
        else if (type === 'mentions') {
            // Defer to avoid race with document click handler that closes autocomplete
            setTimeout(() => {
                chatMessage.focus();
                document.execCommand('insertText', false, '@');
                // Directly trigger autocomplete logic
                autocompleteType = '@';
                triggerQuery = '';
                updateAutocompleteItems('');
            }, 50);
        }

        // Close menu
        contextMenu.classList.add('hidden');
    });
});

/**
 * Request the extension to open the image.
 * @param {string} dateUrlOrPath 
 */
function requestOpenImage(dateUrlOrPath) {
    // If it's base64, we CAN now send it. The backend will save it to temp.
    // if (dateUrlOrPath.startsWith('data:')) { ... }

    sendMessage(CHAT_COMMANDS.OPEN_IMAGE, { path: dateUrlOrPath });
}

function requestOpenFile(fileId) {
    const fileData = window.inlineFilesMap && window.inlineFilesMap[fileId];
    if (fileData) {
        const isUrl = fileData.path && (fileData.path.startsWith('http://') || fileData.path.startsWith('https://'));
        if (fileData.path && !isUrl) {
            // Local file — open directly
            sendMessage('openFile', { path: fileData.path });
        } else if (isUrl && !fileData.content) {
            // URL without content (old history) — open URL externally
            sendMessage('openExternal', { url: fileData.path });
        } else {
            // URL with content or virtual file — show in editor
            sendMessage('openVirtualFile', {
                name: fileData.name,
                text: fileData.content,
                language: fileData.language
            });
        }
    }
}


let activeStreamAccumulator = "";
let activeStreamNode = null;

