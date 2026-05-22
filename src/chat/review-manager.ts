import * as vscode from 'vscode';

/**
 * PendingEdit — Tracks a single AI edit that was written directly to a file.
 */
export interface PendingEdit {
    /** The original text that was replaced */
    originalContent: string;
    /** The new text that replaced it */
    newContent: string;
    /** Start line of the change (0-indexed) */
    startLine: number;
    /** End line of the change (0-indexed, inclusive) */
    endLine: number;
    /** Which tool made this edit */
    toolName?: string;
    /** Timestamp */
    timestamp: number;
    chatId?: string;
    userMsgIdx?: number;
}

/**
 * ReviewManager — Direct-Write Model (#43)
 * 
 * The AI agent writes changes directly to files using WorkspaceEdit.
 * This manager tracks what was changed so it can be:
 * - Highlighted with decorations (green)
 * - Shown with CodeLens (Accept/Revert)
 * - Reverted on demand
 */
export class ReviewManager {
    private static instance: ReviewManager;
    
    private _onDidUpdateStaging = new vscode.EventEmitter<number>();
    readonly onDidUpdateStaging = this._onDidUpdateStaging.event;

    /** Map<fileUriStr, PendingEdit[]> — edits awaiting user accept/reject */
    private pendingEdits = new Map<string, PendingEdit[]>();

    /** Original full-file content, stored when the first edit is made to a file in this turn */
    private originalSnapshots = new Map<string, string>();

    /** Guard: prevents auto-accept when the AI itself saves a file */
    private _isSaving = false;
    public get isSaving() { return this._isSaving; }

    private _isTerminalRunning = false;
    public setTerminalRunning(val: boolean) { this._isTerminalRunning = val; }

    private workspaceState?: vscode.Memento;
    private isInitializing = false;

    private activeChatId: string | null = null;
    private activeUserMsgIdx: number | null = null;

    public setActiveMessageContext(chatId: string | null, userMsgIdx: number | null) {
        this.activeChatId = chatId;
        this.activeUserMsgIdx = userMsgIdx;
    }

    public initialize(context: vscode.ExtensionContext) {
        this.workspaceState = context.workspaceState;
        this.loadFromStorage();
    }

    private loadFromStorage() {
        if (!this.workspaceState) return;
        this.isInitializing = true;
        try {
            const storedEdits = this.workspaceState.get<[string, PendingEdit[]][]>('kdaina.pendingEdits');
            const storedSnapshots = this.workspaceState.get<[string, string][]>('kdaina.originalSnapshots');
            
            if (storedEdits) {
                this.pendingEdits = new Map<string, PendingEdit[]>(storedEdits);
            }
            if (storedSnapshots) {
                this.originalSnapshots = new Map<string, string>(storedSnapshots);
            }
            
            const hasPending = this.getTotalPendingCount() > 0;
            vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', hasPending);
            this._onDidUpdateStaging.fire(this.getTotalPendingCount());
            this.refreshActiveDecorations();
        } catch (err) {
            console.error('[ReviewManager] Failed to load pending changes from storage:', err);
        } finally {
            this.isInitializing = false;
        }
    }

    private async saveToStorage() {
        if (this.isInitializing || !this.workspaceState) return;
        try {
            const storedEdits = Array.from(this.pendingEdits.entries());
            const storedSnapshots = Array.from(this.originalSnapshots.entries());
            
            await this.workspaceState.update('kdaina.pendingEdits', storedEdits);
            await this.workspaceState.update('kdaina.originalSnapshots', storedSnapshots);
        } catch (err) {
            console.error('[ReviewManager] Failed to save pending changes to storage:', err);
        }
    }

    private constructor() {
        // Automatically save to workspaceState whenever staging changes occur
        this._onDidUpdateStaging.event(() => {
            this.saveToStorage();
        });

        // Track file creations while terminal is running
        vscode.workspace.onDidCreateFiles(async (e) => {
            if (this._isTerminalRunning) {
                for (const uri of e.files) {
                    // Ignore noisy directories
                    if (uri.fsPath.includes('node_modules') || uri.fsPath.includes('.git') || uri.fsPath.includes('__pycache__')) continue;
                    
                    try {
                        const stat = await vscode.workspace.fs.stat(uri);
                        if (stat.type === vscode.FileType.File) {
                            const content = await vscode.workspace.fs.readFile(uri);
                            this.trackTerminalCreate(uri, Buffer.from(content).toString('utf-8'));
                        }
                    } catch (err) {}
                }
            }
        });

        // Update the content of tracked terminal creations if they are modified by the terminal
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this._isTerminalRunning && !this._isSaving) {
                const key = e.document.uri.toString();
                const edits = this.pendingEdits.get(key);
                if (edits) {
                    const termEdit = edits.find(edit => edit.toolName === 'terminal');
                    if (termEdit) {
                        termEdit.newContent = e.document.getText();
                        termEdit.endLine = termEdit.newContent.split('\n').length - 1;
                    }
                }
            }
        });
    }

    public static getInstance(): ReviewManager {
        if (!ReviewManager.instance) {
            ReviewManager.instance = new ReviewManager();
        }
        return ReviewManager.instance;
    }

    /**
     * Start a new agent turn — clears all tracked edits.
     */
    public startTurn() {
        this.pendingEdits.clear();
        this.originalSnapshots.clear();
        vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', false);
        this._onDidUpdateStaging.fire(0);
    }

    /**
     * Snapshot the file content before the first edit in this turn.
     */
    public async snapshotOriginal(uri: vscode.Uri): Promise<string> {
        const key = uri.toString();
        if (!this.originalSnapshots.has(key)) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const content = doc.getText();
                this.originalSnapshots.set(key, content);
                return content;
            } catch {
                this.originalSnapshots.set(key, '');
                return '';
            }
        }
        return this.originalSnapshots.get(key)!;
    }

    /**
     * Apply an edit directly to the file using WorkspaceEdit.
     * Tracks the change for CodeLens / decoration / revert.
     */
    public async applyDirectEdit(
        uri: vscode.Uri,
        targetContent: string,
        replacementContent: string,
        toolName?: string
    ): Promise<{ success: boolean; error?: string }> {
        const key = uri.toString();

        // Snapshot original if not already done
        await this.snapshotOriginal(uri);

        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const fullText = doc.getText();

            // Normalize line endings: VS Code internally uses LF, but the AI model
            // may send CRLF in targetContent. Normalize both to LF for matching.
            const normTarget = targetContent.replace(/\r\n/g, '\n');
            const normReplacement = replacementContent.replace(/\r\n/g, '\n');

            // Try exact match first, then normalized match
            let matchTarget = targetContent;
            let matchReplacement = replacementContent;
            if (!fullText.includes(targetContent) && fullText.includes(normTarget)) {
                matchTarget = normTarget;
                matchReplacement = normReplacement;
            }

            if (!fullText.includes(matchTarget)) {
                // Check if replacement is already present (idempotent)
                if (fullText.includes(normReplacement) || fullText.includes(replacementContent)) {
                    return { success: true };
                }

                // ─── FUZZY WHITESPACE MATCHING ──────────────────────────
                // AI models frequently get indentation wrong (tabs vs spaces,
                // 4 spaces vs 6 spaces, trailing whitespace). Try matching by
                // normalizing leading whitespace on each line.
                const fuzzyResult = this.fuzzyWhitespaceMatch(fullText, normTarget);
                if (fuzzyResult) {
                    // Found via fuzzy match — use the actual file content range
                    matchTarget = fuzzyResult.matchedText;
                    matchReplacement = normReplacement;
                } else {
                    return { success: false, error: 'Target content not found in file. This is usually caused by a whitespace/indentation mismatch or stale content. Use read_line_range to see the EXACT current text, then retry with the precise content.' };
                }
            }

            // Check for unique match
            const count = fullText.split(matchTarget).length - 1;
            if (count > 1) {
                return { success: false, error: `Found ${count} occurrences. Provide more context.` };
            }

            // Find the position
            const startOffset = fullText.indexOf(matchTarget);
            const endOffset = startOffset + matchTarget.length;
            const startPos = doc.positionAt(startOffset);
            const endPos = doc.positionAt(endOffset);

            // Apply the edit via WorkspaceEdit
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(startPos, endPos), matchReplacement);
            const success = await vscode.workspace.applyEdit(edit);

            if (!success) {
                return { success: false, error: 'WorkspaceEdit.applyEdit returned false.' };
            }

            // Save the file (guarded so onDidSaveTextDocument won't auto-accept)
            try {
                this._isSaving = true;
                const updatedDoc = await vscode.workspace.openTextDocument(uri);
                await updatedDoc.save();
            } catch (saveErr) {
                // Non-fatal — edit was applied, save can be manual
            } finally {
                this._isSaving = false;
            }

            // Track the pending edit for CodeLens/decoration
            const newLineCount = matchReplacement.split('\n').length;
            const pendingEdit: PendingEdit = {
                originalContent: matchTarget,
                newContent: matchReplacement,
                startLine: startPos.line,
                endLine: startPos.line + newLineCount - 1,
                toolName,
                timestamp: Date.now(),
                chatId: this.activeChatId || undefined,
                userMsgIdx: this.activeUserMsgIdx !== null ? this.activeUserMsgIdx : undefined
            };

            if (!this.pendingEdits.has(key)) {
                this.pendingEdits.set(key, []);
            }
            this.pendingEdits.get(key)!.push(pendingEdit);

            vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', true);
            this._onDidUpdateStaging.fire(this.getTotalPendingCount());

            // Refresh decorations on the active editor
            this.refreshActiveDecorations();

            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    }

    /**
     * Apply a create-file operation.
     */
    public async applyDirectCreate(
        uri: vscode.Uri,
        content: string,
        toolName?: string
    ): Promise<{ success: boolean; error?: string }> {
        const key = uri.toString();

        try {
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(uri, { overwrite: true });
            edit.insert(uri, new vscode.Position(0, 0), content);
            const success = await vscode.workspace.applyEdit(edit);

            if (!success) {
                return { success: false, error: 'Failed to create file.' };
            }

            try {
                this._isSaving = true;
                const doc = await vscode.workspace.openTextDocument(uri);
                await doc.save();
            } catch { /* non-fatal */ } finally {
                this._isSaving = false;
            }

            const lineCount = content.split('\n').length;
            const pendingEdit: PendingEdit = {
                originalContent: '',
                newContent: content,
                startLine: 0,
                endLine: lineCount - 1,
                toolName,
                timestamp: Date.now(),
                chatId: this.activeChatId || undefined,
                userMsgIdx: this.activeUserMsgIdx !== null ? this.activeUserMsgIdx : undefined
            };

            this.originalSnapshots.set(key, '');
            if (!this.pendingEdits.has(key)) {
                this.pendingEdits.set(key, []);
            }
            this.pendingEdits.get(key)!.push(pendingEdit);

            vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', true);
            this._onDidUpdateStaging.fire(this.getTotalPendingCount());

            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    }

    /**
     * Track a file created via terminal command.
     */
    public trackTerminalCreate(uri: vscode.Uri, content: string) {
        const key = uri.toString();
        const lineCount = content.split('\n').length;
        const pendingEdit: PendingEdit = {
            originalContent: '',
            newContent: content,
            startLine: 0,
            endLine: Math.max(0, lineCount - 1),
            toolName: 'terminal',
            timestamp: Date.now(),
            chatId: this.activeChatId || undefined,
            userMsgIdx: this.activeUserMsgIdx !== null ? this.activeUserMsgIdx : undefined
        };

        this.originalSnapshots.set(key, '');
        if (!this.pendingEdits.has(key)) {
            this.pendingEdits.set(key, []);
        }
        this.pendingEdits.get(key)!.push(pendingEdit);

        vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', true);
        this._onDidUpdateStaging.fire(this.getTotalPendingCount());
    }

    /**
     * Get pending edits for a file (used by CodeLens and Decorations).
     */
    public getPendingEdits(uriStr: string): PendingEdit[] {
        return this.pendingEdits.get(uriStr) || [];
    }

    /**
     * Accept a single edit (clear it from tracking, keep the change).
     */
    public acceptEdit(uriStr: string, editIndex: number) {
        const edits = this.pendingEdits.get(uriStr);
        if (edits && editIndex >= 0 && editIndex < edits.length) {
            edits.splice(editIndex, 1);
            if (edits.length === 0) {
                this.pendingEdits.delete(uriStr);
                this.originalSnapshots.delete(uriStr);
            }
        }
        
        if (this.getTotalPendingCount() === 0) {
            vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', false);
        }
        this._onDidUpdateStaging.fire(this.getTotalPendingCount());
        this.refreshActiveDecorations();
    }

    /**
     * Internal helper to revert a single edit without updating vscode context/decorations.
     */
    private async revertSingleEditInternal(uriStr: string, editIndex: number) {
        const edits = this.pendingEdits.get(uriStr);
        if (!edits || editIndex < 0 || editIndex >= edits.length) { return; }

        const edit = edits[editIndex];
        const uri = vscode.Uri.parse(uriStr);

        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const fullText = doc.getText();

            let matchNewContent = edit.newContent;
            let matchOriginalContent = edit.originalContent;
            if (!fullText.includes(matchNewContent) && fullText.includes(edit.newContent.replace(/\r\n/g, '\n'))) {
                matchNewContent = edit.newContent.replace(/\r\n/g, '\n');
                matchOriginalContent = edit.originalContent.replace(/\r\n/g, '\n');
            }

            if (fullText.includes(matchNewContent)) {
                const wsEdit = new vscode.WorkspaceEdit();
                const startOffset = fullText.indexOf(matchNewContent);
                const endOffset = startOffset + matchNewContent.length;
                wsEdit.replace(uri, new vscode.Range(
                    doc.positionAt(startOffset),
                    doc.positionAt(endOffset)
                ), matchOriginalContent);
                
                const success = await vscode.workspace.applyEdit(wsEdit);
                if (success) {
                    try { await doc.save(); } catch { /* non-fatal */ }
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to revert change: ${err}`);
        }

        // Remove from tracking
        edits.splice(editIndex, 1);
        if (edits.length === 0) {
            this.pendingEdits.delete(uriStr);
            this.originalSnapshots.delete(uriStr);
        }
    }

    /**
     * Revert a single edit — restore the original text.
     */
    public async revertEdit(uriStr: string, editIndex: number) {
        await this.revertSingleEditInternal(uriStr, editIndex);

        const hasPending = this.getTotalPendingCount() > 0;
        vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', hasPending);
        this._onDidUpdateStaging.fire(this.getTotalPendingCount());
        this.refreshActiveDecorations();
    }

    /**
     * Discard all edits and created files associated with the specified chatId and having userMsgIdx >= targetUserMsgIdx.
     */
    public async discardEditsPastMessage(chatId: string, userMsgIdx: number) {
        for (const uriStr of Array.from(this.pendingEdits.keys())) {
            const edits = this.pendingEdits.get(uriStr) || [];
            const targetEdits = edits.filter(e => e.chatId === chatId && e.userMsgIdx !== undefined && e.userMsgIdx >= userMsgIdx);
            if (targetEdits.length === 0) continue;

            // Check if this file was created at or after targetMsgIdx
            const isCreatedFile = edits[0]?.originalContent === '' && edits[0]?.chatId === chatId && edits[0]?.userMsgIdx !== undefined && edits[0]?.userMsgIdx >= userMsgIdx;
            if (isCreatedFile && targetEdits.length === edits.length) {
                // Delete the file
                const uri = vscode.Uri.parse(uriStr);
                try {
                    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
                } catch (err) {
                    console.error(`[ReviewManager] Failed to delete created file ${uriStr}:`, err);
                }
                this.pendingEdits.delete(uriStr);
                this.originalSnapshots.delete(uriStr);
                continue;
            }

            // Otherwise, revert edits in reverse order
            for (let i = edits.length - 1; i >= 0; i--) {
                const e = edits[i];
                if (e.chatId === chatId && e.userMsgIdx !== undefined && e.userMsgIdx >= userMsgIdx) {
                    await this.revertSingleEditInternal(uriStr, i);
                }
            }
        }

        const hasPending = this.getTotalPendingCount() > 0;
        vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', hasPending);
        this._onDidUpdateStaging.fire(this.getTotalPendingCount());
        this.refreshActiveDecorations();
    }

    /**
     * Accept all edits for a file.
     */
    public acceptAllForFile(uriStr: string) {
        this.pendingEdits.delete(uriStr);
        this.originalSnapshots.delete(uriStr);

        if (this.getTotalPendingCount() === 0) {
            vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', false);
        }
        this._onDidUpdateStaging.fire(this.getTotalPendingCount());
        this.refreshActiveDecorations();
    }

    /**
     * Revert all edits for a file.
     */
    public async revertAllForFile(uriStr: string) {
        const originalContent = this.originalSnapshots.get(uriStr);
        if (originalContent === undefined) {
            // No snapshot — just clear tracking
            this.pendingEdits.delete(uriStr);
            return;
        }

        const uri = vscode.Uri.parse(uriStr);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const wsEdit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            wsEdit.replace(uri, fullRange, originalContent);
            const success = await vscode.workspace.applyEdit(wsEdit);
            if (success) {
                try { await doc.save(); } catch { /* non-fatal */ }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to revert file: ${err}`);
        }

        this.pendingEdits.delete(uriStr);
        this.originalSnapshots.delete(uriStr);

        if (this.getTotalPendingCount() === 0) {
            vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', false);
        }
        this._onDidUpdateStaging.fire(this.getTotalPendingCount());
        this.refreshActiveDecorations();
    }

    /**
     * Accept all pending edits across all files.
     */
    public async commitAll() {
        this.pendingEdits.clear();
        this.originalSnapshots.clear();
        vscode.commands.executeCommand('setContext', 'kdaina.reviewPending', false);
        this._onDidUpdateStaging.fire(0);
        this.refreshActiveDecorations();
        return true;
    }

    /**
     * Revert all pending edits across all files.
     */
    public async discardAll() {
        for (const uriStr of Array.from(this.pendingEdits.keys())) {
            await this.revertAllForFile(uriStr);
        }
        this.startTurn();
    }

    /**
     * Get total number of pending edits across all files.
     */
    public getTotalPendingCount(): number {
        let count = 0;
        for (const edits of this.pendingEdits.values()) {
            count += edits.length;
        }
        return count;
    }

    /**
     * Get URIs with pending edits.
     */
    public getStagedUris(): vscode.Uri[] {
        return Array.from(this.pendingEdits.keys()).map(s => vscode.Uri.parse(s));
    }

    /**
     * Get the original snapshot content of the file.
     */
    public getOriginalContent(uri: vscode.Uri): string | undefined {
        return this.originalSnapshots.get(uri.toString());
    }

    /**
     * Get the current file content (for the agent to read latest state).
     */
    public async getCurrentContent(uri: vscode.Uri): Promise<string> {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            return doc.getText();
        } catch {
            return '';
        }
    }

    /**
     * Refresh decorations on the currently active editor.
     */
    private refreshActiveDecorations() {
        // Dynamically import to avoid circular dependency
        const { ReviewDecorationProvider } = require('./review-codelens');
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            ReviewDecorationProvider.updateDecorations(editor);
        }
    }

    /**
     * Fuzzy whitespace matching for chunk_replace.
     * 
     * AI models frequently get indentation wrong (tabs vs spaces, 4 spaces vs 6,
     * trailing whitespace, etc.). This method normalizes leading whitespace on each
     * line and uses a sliding window to find the matching block in the file.
     * 
     * Returns the ACTUAL file text for the matched range (not the normalized version),
     * so the replacement targets the real content.
     */
    private fuzzyWhitespaceMatch(
        fullText: string,
        target: string
    ): { matchedText: string; startLine: number; endLine: number } | null {
        const fileLines = fullText.split('\n');
        const targetLines = target.split('\n');

        if (targetLines.length === 0 || targetLines.length > fileLines.length) {
            return null;
        }

        // Normalize: collapse leading whitespace to a single space, trim trailing
        const normalize = (line: string) => line.replace(/^\s+/, ' ').trimEnd();
        const normTargetLines = targetLines.map(normalize);

        // Sliding window search
        const windowSize = targetLines.length;
        for (let i = 0; i <= fileLines.length - windowSize; i++) {
            let match = true;
            for (let j = 0; j < windowSize; j++) {
                if (normalize(fileLines[i + j]) !== normTargetLines[j]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                // Verify uniqueness — check there's no second match
                let secondMatch = false;
                for (let k = i + 1; k <= fileLines.length - windowSize; k++) {
                    let isMatch = true;
                    for (let j = 0; j < windowSize; j++) {
                        if (normalize(fileLines[k + j]) !== normTargetLines[j]) {
                            isMatch = false;
                            break;
                        }
                    }
                    if (isMatch) {
                        secondMatch = true;
                        break;
                    }
                }
                if (secondMatch) {
                    return null; // Ambiguous — multiple fuzzy matches
                }

                // Return the actual file content for this range
                const matchedText = fileLines.slice(i, i + windowSize).join('\n');
                return { matchedText, startLine: i, endLine: i + windowSize - 1 };
            }
        }

        return null;
    }

    // ─── LEGACY COMPAT (kept for webview staging bar) ─────────────────────

    /** @deprecated Use applyDirectEdit instead */
    public async ensureInitialized(_uri: vscode.Uri) {
        await this.snapshotOriginal(_uri);
    }

    /** @deprecated Use getCurrentContent instead */
    public getShadowContent(uri: vscode.Uri): string {
        // In direct-write model, the "shadow" IS the live file
        try {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            return doc?.getText() || '';
        } catch {
            return '';
        }
    }

    /** @deprecated Use applyDirectEdit instead */
    public updateShadow(_uri: vscode.Uri, _content: string) {
        // No-op in direct-write model — changes go directly to file
    }
}
