function updateStagingBar(count) {
    const stagingBar = document.getElementById('staging-bar');
    const stagingCount = document.getElementById('staging-count');
    const pillReviews = document.getElementById('pill-reviews');

    if (!stagingBar || !stagingCount) {
        return;
    }

    if (count > 0) {
        stagingBar.classList.remove('hidden');
        stagingCount.textContent = `${count} File${count > 1 ? 's' : ''} With Changes`;
        if (pillReviews) pillReviews.classList.add('glow');
    } else {
        stagingBar.classList.remove('hidden');
        stagingCount.textContent = `0 Files With Changes`;
        if (pillReviews) pillReviews.classList.remove('glow');
    }
}

// Global button listeners (can stay at top level but wrapped in check)
document.addEventListener('DOMContentLoaded', () => {
    const stagingReviewBtn = document.getElementById('staging-review-btn');
    const stagingApproveBtn = document.getElementById('staging-approve-btn');
    const stagingDiscardBtn = document.getElementById('staging-discard-btn');

    if (stagingReviewBtn) {
        stagingReviewBtn.onclick = () => sendMessage('chatReviewDiff', { isGlobalReview: true });
    }
    if (stagingApproveBtn) {
        stagingApproveBtn.onclick = () => sendMessage('chatToolApproval', { approved: true });
    }
    if (stagingDiscardBtn) {
        stagingDiscardBtn.onclick = () => sendMessage('chatToolApproval', { approved: false });
    }

    // Initialize Generate Button
    initGenerateButton();
});

function initGenerateButton() {
    const generateBtn = document.getElementById('generateButton');
    if (generateBtn) {
        generateBtn.onclick = () => {
            const input = document.getElementById('messageInput');
            if (!input) {
                console.error('messageInput not found');
                return;
            }
            const prompt = input.innerText.trim();

            generateBtn.classList.add('loading');

            if (!prompt) {
                // Empty input — suggest prompt ideas
                console.log('Sending suggestPrompts request...');
                sendMessage('suggestPrompts', {});
            } else {
                // Has text — improve the existing prompt
                console.log('Sending improvePrompt request...');
                sendMessage('improvePrompt', { prompt });
            }
        };
    } else {
        console.warn('generateButton not found in DOM during init');
    }
}


window.approveTool = (toolCallId, approved) => {
    sendMessage('chatToolApproval', { toolCallId, approved });
    // Local update for immediate feedback
    updateCardApproval(toolCallId, approved);
};

function updateCardApproval(toolCallId, approved) {
    // Find the button or use direct lookup for the card
    // We look for common elements that contain the toolCallId
    const btn = document.querySelector(`.approve-btn[onclick*="${toolCallId}"], .deny-btn[onclick*="${toolCallId}"], .review-btn[onclick*="${toolCallId}"]`);
    if (btn) {
        const card = btn.closest('.agent-step-card');
        if (card) {
            card.classList.remove('approval-pending');
            const status = card.querySelector('.step-status');
            if (status) {
                status.textContent = approved ? 'Approved' : 'Denied';
                status.className = `step-status ${approved ? 'approved' : 'denied'}`;
            }
            const actions = card.querySelector('.step-actions');
            if (actions) { actions.remove(); }
        }
    }
}

window.reviewDiff = (toolCallId, toolName) => {
    try {
        console.log('Initiating ReviewDiff for:', toolCallId, toolName);
        const args = window.pendingToolArgs ? window.pendingToolArgs[toolCallId] : null;
        if (args) {
            sendMessage('chatReviewDiff', { toolCallId, toolName, args });
        } else {
            console.error('No pending args found for toolCallId:', toolCallId);
        }
    } catch (e) {
        console.error('Failed to initiate diff review', e);
    }
};

// ─── HUNK REVIEW PANEL ───────────────────────────────────────────────
let hunkReviewState = null; // { files: [...], undoStack: [], currentNavIndex: 0 }

function openHunkReviewPanel(filesData) {
    // Initialize state (allow empty filesData for forced open)
    hunkReviewState = {
        files: (filesData || []).map(f => ({
            ...f,
            hunks: (f.hunks || []).map(h => ({ ...h, accepted: true }))
        })),
        undoStack: [], // Stack of { fileIdx, hunkIdx, prevState }
        currentNavIndex: 0
    };

    renderHunkReviewPanel();
}

function closeHunkReviewPanel() {
    hunkReviewState = null;
    const overlay = document.getElementById('hunk-review-overlay');
    if (overlay) { overlay.remove(); }
}

function renderHunkReviewPanel() {
    if (!hunkReviewState) { return; }

    // Remove existing if present
    let overlay = document.getElementById('hunk-review-overlay');
    const wasOpen = !!overlay;
    const scrollPos = wasOpen ? overlay.querySelector('.hunk-review-body').scrollTop : 0;

    if (overlay) { overlay.remove(); }

    overlay = document.createElement('div');
    overlay.id = 'hunk-review-overlay';
    overlay.className = 'hunk-review-overlay';

    // Calculate total additions/deletions for header
    let additions = 0;
    let deletions = 0;
    hunkReviewState.files.forEach(file => {
        file.hunks.forEach(hunk => {
            hunk.lines.forEach(line => {
                if (line.startsWith('+')) additions++;
                else if (line.startsWith('-')) deletions++;
            });
        });
    });

    const bodyContent = hunkReviewState.files.length === 0
        ? `<div class="hunk-empty-state">
             <div class="empty-icon">✓</div>
             <div class="empty-text">No pending changes</div>
             <div class="empty-subtext">All changes have been accepted or reverted.</div>
           </div>`
        : hunkReviewState.files.map((file, fileIdx) => renderFileSection(file, fileIdx)).join('');

    overlay.innerHTML = `
        <div class="hunk-review-header">
            <button class="back-btn" onclick="closeHunkReviewPanel()" title="Back to Chat">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
            </button>
            <h2>
                Review Changes 
                <span class="index-count" style="font-family: var(--font-editor); margin-left: 4px;">(${hunkReviewState.files.length} file${hunkReviewState.files.length !== 1 ? 's' : ''})</span>
                <span class="diff-stat" style="margin-left: 8px;">
                    <span class="add">+${additions}</span>
                    <span class="del">-${deletions}</span>
                </span>
            </h2>
            ${hunkReviewState.files.length > 0 ? renderNavigator() : ''}
            <div class="header-actions">
                <button class="mono-btn" onclick="discardAllHunks()" ${hunkReviewState.files.length === 0 ? 'disabled' : ''}>Reject All</button>
                <button class="mono-btn primary" onclick="commitSelectedHunks()" ${hunkReviewState.files.length === 0 ? 'disabled' : ''}>Commit</button>
            </div>
        </div>
        <div class="hunk-review-body" id="hunk-review-body">
            ${bodyContent}
        </div>
    `;

    document.body.appendChild(overlay);
    if (wasOpen) {
        overlay.querySelector('.hunk-review-body').scrollTop = scrollPos;
    }
}

function renderNavigator() {
    const total = hunkReviewState.files.length;
    const current = hunkReviewState.currentNavIndex || 0;

    return `
        <div class="hunk-navigator" style="display:flex; align-items:center; gap:8px; padding: 4px 8px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent);">
            <button class="nav-btn" onclick="navigateHunk(-1)" ${current <= 0 ? 'disabled' : ''} style="background:none; border:none; color:inherit; cursor:pointer; font-size:11px; opacity:${current <= 0 ? '0.35' : '0.85'}; display:flex; align-items:center;">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>
            </button>
            <span class="nav-counter" style="font-size:11px; font-weight:500; font-family:var(--font-editor, monospace); opacity:0.75;">${current + 1} / ${total}</span>
            <button class="nav-btn" onclick="navigateHunk(1)" ${current >= total - 1 ? 'disabled' : ''} style="background:none; border:none; color:inherit; cursor:pointer; font-size:11px; opacity:${current >= total - 1 ? '0.35' : '0.85'}; display:flex; align-items:center;">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
            </button>
        </div>
    `;
}

function navigateHunk(direction) {
    if (!hunkReviewState) return;
    const total = hunkReviewState.files.length;
    let idx = (hunkReviewState.currentNavIndex || 0) + direction;
    idx = Math.max(0, Math.min(idx, total - 1));
    hunkReviewState.currentNavIndex = idx;

    const section = document.querySelector(`.hunk-file-section[data-file-idx="${idx}"]`);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Update counter & button states in-place (no full re-render = no flicker)
    const counter = document.querySelector('.nav-counter');
    if (counter) { counter.textContent = `${idx + 1} / ${total}`; }
    const prevBtn = document.querySelector('.nav-btn[onclick="navigateHunk(-1)"]');
    const nextBtn = document.querySelector('.nav-btn[onclick="navigateHunk(1)"]');
    if (prevBtn) { prevBtn.disabled = idx <= 0; prevBtn.style.opacity = idx <= 0 ? '0.3' : '1'; }
    if (nextBtn) { nextBtn.disabled = idx >= total - 1; nextBtn.style.opacity = idx >= total - 1 ? '0.3' : '1'; }

    // Update current section highlights
    document.querySelectorAll('.hunk-file-section').forEach((s, i) => {
        const isCurrent = i === idx;
        s.classList.toggle('current', isCurrent);
    });
}

function renderFileSection(file, fileIdx) {
    let fileAdditions = 0;
    let fileDeletions = 0;
    file.hunks.forEach(hunk => {
        hunk.lines.forEach(line => {
            if (line.startsWith('+')) fileAdditions++;
            else if (line.startsWith('-')) fileDeletions++;
        });
    });

    const isCurrent = hunkReviewState.currentNavIndex === fileIdx;

    return `
        <div class="hunk-file-section ${isCurrent ? 'current' : ''}" data-file-idx="${fileIdx}">
            <div class="hunk-file-header" onclick="toggleFileSection(${fileIdx})">
                <div class="hunk-file-name" title="Click to expand/collapse">
                    <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.2s; transform: rotate(90deg);"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    <span>${escapeHtml(file.fileName)}</span>
                    <span class="diff-stat">
                        <span class="add">+${fileAdditions}</span>
                        <span class="del">-${fileDeletions}</span>
                    </span>
                    ${file.savedByUser ? '<span style="font-size: 0.65rem; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent); opacity: 0.6; padding: 1px 6px; border-radius: 3px;">SAVED</span>' : ''}
                </div>
                <div class="file-action-buttons" onclick="event.stopPropagation()">
                    <button class="mono-file-btn" onclick="sendMessage('chatOpenFile', { uri: '${file.uri}' })" title="Open Diff View">Diff</button>
                    <button class="mono-icon-btn reject" onclick="sendMessage('rejectFile', { uri: '${file.uri}' })" title="Reject File Changes">✕</button>
                    <button class="mono-icon-btn accept" onclick="sendMessage('acceptFile', { uri: '${file.uri}' })" title="Accept File Changes">✓</button>
                </div>
            </div>
            <div class="hunk-file-content">
                ${(file.hunks || []).map((hunk, hunkIdx) => renderHunkCard(hunk, fileIdx, hunkIdx)).join('')}
            </div>
        </div>
    `;
}

function renderHunkCard(hunk, fileIdx, hunkIdx) {
    const isAccepted = hunk.accepted;
    const cardClass = isAccepted ? '' : 'rejected';
    const location = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

    const linesHtml = hunk.lines.map(line => {
        const prefix = line.charAt(0);
        let lineClass = 'context';
        let prefixChar = ' ';
        let contentStr = line;

        if (prefix === '+') {
            lineClass = 'added';
            prefixChar = '+';
            contentStr = line.substring(1);
        } else if (prefix === '-') {
            lineClass = 'removed';
            prefixChar = '-';
            contentStr = line.substring(1);
        } else if (prefix === ' ') {
            prefixChar = ' ';
            contentStr = line.substring(1);
        }

        return `<div class="hunk-diff-line ${lineClass}"><span class="diff-prefix">${prefixChar}</span><span class="diff-content">${escapeHtml(contentStr)}</span></div>`;
    }).join('');

    return `
        <div class="hunk-card ${cardClass}" data-file-idx="${fileIdx}" data-hunk-idx="${hunkIdx}">
            <div class="hunk-card-header">
                <span>${location}</span>
                <div class="hunk-card-actions">
                    <button class="mono-toggle-btn accept ${isAccepted ? 'active' : ''}" onclick="toggleHunk(${fileIdx}, ${hunkIdx}, true)">Keep</button>
                    <button class="mono-toggle-btn reject ${!isAccepted ? 'active' : ''}" onclick="toggleHunk(${fileIdx}, ${hunkIdx}, false)">Skip</button>
                </div>
            </div>
            <div class="hunk-diff-lines">
                ${linesHtml}
            </div>
        </div>
    `;
}

function toggleFileSection(fileIdx) {
    const section = document.querySelector(`.hunk-file-section[data-file-idx="${fileIdx}"]`);
    if (section) {
        section.classList.toggle('collapsed');
        const content = section.querySelector('.hunk-file-content');
        if (content) {
            content.style.display = section.classList.contains('collapsed') ? 'none' : 'flex';
        }
        const chevron = section.querySelector('.chevron');
        if (chevron) {
            chevron.style.transform = section.classList.contains('collapsed') ? 'rotate(0deg)' : 'rotate(90deg)';
        }
    }
}

function toggleHunk(fileIdx, hunkIdx, accepted) {
    if (!hunkReviewState) { return; }

    const file = hunkReviewState.files[fileIdx];
    if (!file) { return; }
    const hunk = file.hunks[hunkIdx];
    if (!hunk) { return; }

    // Save to undo stack
    hunkReviewState.undoStack.push({
        fileIdx,
        hunkIdx,
        prevState: hunk.accepted
    });

    hunk.accepted = accepted;

    // Sync with backend
    sendMessage('chatToggleHunk', { uri: file.uri, index: hunk.index, accepted });

    // Update UI in place to prevent flickering
    updateHunkCardUI(fileIdx, hunkIdx, accepted);
}

function undoHunkToggle() {
    if (!hunkReviewState || hunkReviewState.undoStack.length === 0) { return; }

    const last = hunkReviewState.undoStack.pop();
    const file = hunkReviewState.files[last.fileIdx];
    if (file) {
        const hunk = file.hunks[last.hunkIdx];
        if (hunk) {
            hunk.accepted = last.prevState;
            updateHunkCardUI(last.fileIdx, last.hunkIdx, last.prevState);
        }
    }
}

function updateHunkCardUI(fileIdx, hunkIdx, accepted) {
    const card = document.querySelector(`.hunk-card[data-file-idx="${fileIdx}"][data-hunk-idx="${hunkIdx}"]`);
    if (!card) return;

    if (accepted) {
        card.classList.remove('rejected');
    } else {
        card.classList.add('rejected');
    }

    const acceptBtn = card.querySelector('.mono-toggle-btn.accept');
    const rejectBtn = card.querySelector('.mono-toggle-btn.reject');

    if (acceptBtn) acceptBtn.classList.toggle('active', accepted);
    if (rejectBtn) rejectBtn.classList.toggle('active', !accepted);
}

function commitSelectedHunks() {
    if (!hunkReviewState) { return; }

    const selections = hunkReviewState.files.map(file => ({
        uri: file.uri,
        acceptedIndices: file.hunks
            .filter(h => h.accepted)
            .map(h => h.index)
    }));

    sendMessage('commitSelectedHunks', { selections, action: 'commit' });
    closeHunkReviewPanel();
}

function discardAllHunks() {
    sendMessage('commitSelectedHunks', { selections: [], action: 'discard' });
    closeHunkReviewPanel();
}


// Keyboard shortcuts for hunk review panel
document.addEventListener('keydown', (e) => {
    if (!hunkReviewState) { return; }

    // Ctrl+Z / Cmd+Z = Undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undoHunkToggle();
    }

    // Escape = Close panel
    if (e.key === 'Escape') {
        e.preventDefault();
        closeHunkReviewPanel();
        closeIndexViewer();
    }
});

// ─── WORKSPACE INDEX VIEWER ──────────────────────────────────────────

