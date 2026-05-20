// --- SCROLL MANAGEMENT ---

// Returns the last .chat-turn element
function getLastChatTurn() {
    const turns = chatbox.querySelectorAll('.chat-turn');
    return turns.length > 0 ? turns[turns.length - 1] : null;
}

let _prevMinHeightTurn = null;

function updateLastTurnMinHeight() {
    const lastTurn = getLastChatTurn();
    const viewportHeight = chatLog.clientHeight;

    if (_prevMinHeightTurn && _prevMinHeightTurn !== lastTurn) {
        _prevMinHeightTurn.style.minHeight = '';
    }

    if (!lastTurn) return;

    const stickyHeader = lastTurn.querySelector('.user-message-wrapper');
    const stickyHeight = stickyHeader ? stickyHeader.offsetHeight : 0;

    lastTurn.style.minHeight = (viewportHeight - stickyHeight) + 'px';
    _prevMinHeightTurn = lastTurn;
}

const _chatMutationObserver = new MutationObserver(() => {
    updateLastTurnMinHeight();
});
_chatMutationObserver.observe(chatbox, { childList: true, subtree: true, characterData: true });
new ResizeObserver(() => updateLastTurnMinHeight()).observe(chatLog);
updateLastTurnMinHeight();

// --- VIEWPORT / SCROLL HELPERS ---

function shouldAutoScroll() {
    const distanceFromBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight;
    return distanceFromBottom <= 150;
}

function anchorToNewMessage() {
    updateLastTurnMinHeight();
    const lastTurn = getLastChatTurn();
    if (lastTurn) {
        lastTurn.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Fixed: Only scroll to bottom if the content has actually grown past the viewport
// Otherwise, keep it anchored to the top of the turn.
function scrollToStreamingContent() {
    const lastTurn = getLastChatTurn();
    if (lastTurn) {
        // Calculate the actual height of the content inside the turn
        // by looking at the last element inside it (usually the AI message)
        const lastChild = lastTurn.lastElementChild;
        if (lastChild) {
            const childRect = lastChild.getBoundingClientRect();
            const logRect = chatLog.getBoundingClientRect();
            
            // childRect.bottom is relative to viewport. logRect.bottom is the visible bottom of the scroll container.
            if (childRect.bottom > logRect.bottom - 20) {
                // Scroll down by the difference + 20px padding
                chatLog.scrollTop += (childRect.bottom - logRect.bottom) + 20;
            }
        }
    }
}

function showLastChat() {
    scrollToStreamingContent();
}

function withAutoScroll(callback) {
    var shouldSnap = shouldAutoScroll();
    callback();
    if (shouldSnap) {
        scrollToStreamingContent();
    }
}

function scrollToBottom(force = false) {
    if (force) {
        scrollToStreamingContent();
    }
}

