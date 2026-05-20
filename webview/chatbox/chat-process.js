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



/**
 * Retry: keep the user message, remove only all AI messages following it.
 */
function retryLastMessage(btn) {
    const userMsgEl = btn ? btn.closest('.user-message') : null;
    const allMessages = Array.from(chatbox.querySelectorAll('.user-message, .system-message'));

    // Determine where to start removing AI messages
    let startIdx = -1;
    let targetUserMsg = userMsgEl;
    if (targetUserMsg) {
        startIdx = allMessages.indexOf(targetUserMsg) + 1;
    } else {
        // Fallback for non-button invocation (e.g. command palette)
        // Find the LAST user message in the chat
        const reversed = [...allMessages].reverse();
        targetUserMsg = reversed.find(el => el.classList.contains('user-message'));
        startIdx = targetUserMsg ? allMessages.indexOf(targetUserMsg) + 1 : allMessages.length - 1;
    }

    // Calculate precise userMsgIdx for robust backend deletion
    const allUserMessages = Array.from(chatbox.querySelectorAll('.user-message'));
    const userMsgIdx = targetUserMsg ? allUserMessages.indexOf(targetUserMsg) : allUserMessages.length - 1;

    if (startIdx <= 0 || startIdx > allMessages.length) { return; }

    // Count system-messages (AI responses) after this user message
    const messagesAfter = allMessages.length - startIdx;
    // Minimum count is 2: the user message itself + at least 1 bot response (even if empty/error)
    const removedCount = Math.max(2, messagesAfter + 1);

    // Blast away all DOM nodes that come after targetUserMsg
    if (targetUserMsg) {
        let wrapper = targetUserMsg.closest('.user-message-wrapper') || targetUserMsg;
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
    } else {
        for (let i = startIdx; i < allMessages.length; i++) {
            allMessages[i].remove();
        }
    }

    showLoadingIndicator();
    toggleSendButton('disabled');
    sendMessage(CHAT_COMMANDS.CHAT_RETRY, {
        chat_id: chatLog.dataset.chatId,
        count: removedCount,
        userMsgIdx: userMsgIdx >= 0 ? userMsgIdx : undefined,
        agentId: activeAgentId
    });
}

/**
 * Edit: swap user message bubble with an inline editable textarea.
 * On cancel, restore the original bubble.
 */
function editUserMessage(btn) {
    const userMsgEl = btn.closest('.user-message');
    const rawText = decodeURIComponent(userMsgEl.dataset.rawText || '');

    // Find exact user message index for robust backend deletion
    const allUserMessages = Array.from(chatbox.querySelectorAll('.user-message'));
    const userMsgIdx = allUserMessages.indexOf(userMsgEl);

    // Count formal AI/user messages for the legacy backend history trim
    const allMessages = Array.from(chatbox.querySelectorAll('.user-message, .system-message'));
    const startIdx = allMessages.indexOf(userMsgEl);
    const messagesAfter = allMessages.slice(startIdx + 1);
    const removedCount = messagesAfter.length + 1; // +1 = the user msg itself for history delete

    // Blast away all DOM nodes that come after userMsgEl
    let wrapper = userMsgEl.closest('.user-message-wrapper') || userMsgEl;
    let turnDiv = wrapper.closest('.chat-turn') || wrapper;

    let removedNodes = [];

    // 1. Remove siblings inside the turn
    let nextNode = wrapper.nextSibling;
    while (nextNode) {
        const toRemove = nextNode;
        nextNode = nextNode.nextSibling;
        removedNodes.push({ parent: turnDiv, node: toRemove });
        toRemove.remove();
    }

    // 2. Remove subsequent turns
    let nextTurn = turnDiv.nextSibling;
    while (nextTurn) {
        const toRemove = nextTurn;
        nextTurn = nextTurn.nextSibling;
        removedNodes.push({ parent: chatbox, node: toRemove });
        toRemove.remove();
    }

    // Swap the text span for a textarea, IN-PLACE inside the existing bubble
    const textSpan = userMsgEl.querySelector('.message-text');
    const footer = userMsgEl.querySelector('.message-footer');
    const actionsDiv = userMsgEl.querySelector('.user-message-actions');

    // Build textarea to replace text span
    const ta = document.createElement('textarea');
    ta.className = 'edit-textarea';
    ta.value = rawText;
    ta.rows = Math.max(2, rawText.split('\n').length);
    textSpan.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    // Auto-grow helper (fallback for browsers without field-sizing support)
    function autoGrow() {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
    }
    ta.addEventListener('input', () => {
        autoGrow();
        sendBtn.disabled = !ta.value.trim();
    });
    autoGrow(); // run once on init

    // Swap action buttons to Cancel/Send
    const originalActionsHTML = actionsDiv.innerHTML;
    actionsDiv.innerHTML = `
        <button class="edit-cancel-btn">Cancel</button>
        <button class="edit-send-btn" ${!rawText.trim() ? 'disabled' : ''}>Send</button>`;

    const sendBtn = actionsDiv.querySelector('.edit-send-btn');

    // Cancel: restore everything, put back AI messages
    actionsDiv.querySelector('.edit-cancel-btn').addEventListener('click', () => {
        ta.replaceWith(textSpan);
        actionsDiv.innerHTML = originalActionsHTML;
        // Re-attach action button listeners (onclick attributes are restored via innerHTML)
        removedNodes.forEach(item => item.parent.appendChild(item.node));
    });

    // Send: update bubble text, remove AI history, re-submit
    sendBtn.addEventListener('click', () => {
        const newText = ta.value.trim();
        if (!newText) { return; }

        // Restore bubble to display mode with updated text
        textSpan.innerHTML = escapeHtml(newText).replace(/\n/g, '<br>');
        ta.replaceWith(textSpan);
        userMsgEl.dataset.rawText = encodeURIComponent(newText);
        actionsDiv.innerHTML = originalActionsHTML;

        showLoadingIndicator();
        toggleSendButton('disabled');
        sendMessage(CHAT_COMMANDS.CHAT_RETRY, {
            chat_id: chatLog.dataset.chatId,
            count: removedCount,
            userMsgIdx: userMsgIdx >= 0 ? userMsgIdx : undefined,
            overrideMessage: newText,
            agentId: activeAgentId
        });
    });

    scrollToBottom();
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

    // Update Condition: Check for files too
    if (messageText || dynamicAttachedImages.length > 0 || allFiles.length > 0) {

        // --- PREPARE PAYLOAD ---
        const payload = {
            message: messageText,
            images: dynamicAttachedImages,

            // CRITICAL: Send the attached files to the backend
            files: allFiles,

            agentId: activeAgentId,

            chat_id: chatLog.dataset.chatId,
            timestamp: new Date().toISOString()
        };

        // --- SEND ---
        sendMessage(CHAT_COMMANDS.CHAT_REQUEST, payload);

        // --- UI CLEANUP ---
        hideQuestionBanner(); // #48: Dismiss question banner on reply
        showLoadingIndicator(); // Show dots while waiting for backend echo
        toggleSendButton("disabled");

        chatMessage.innerHTML = "";

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
            sendButton.click();
        }
    });

    input.addEventListener("input", (event) => {
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

