import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';


// import output channel for logging errors
import { outputChannel } from './logger';


//CONSTANTS
import { EXTENSION_NAME } from './constants';
import { ChatViewProvider } from './chat/chat-view-provider';
import { CHAT_COMMANDS } from './chat/chat-constants';
import { chatMessageListener } from './chat/chat-message-listener';
import { SettingsManager } from './services/settings-manager';
import { SettingsView } from './settings/settings-view';
import { DiffContentProvider } from './chat/diff-content-provider';
import { ReviewManager } from './chat/review-manager';

import { ReviewCodeLensProvider, ReviewDecorationProvider } from './chat/review-codelens';
import { PopupManager } from './chat/popup-manager';
import { AgentHubView } from './agent-hub/agent-hub-view';

import { FileConfigService } from './services/file-config-service';

// editor
const editor = vscode.window.activeTextEditor;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    // Initialize FileConfigService
    FileConfigService.getInstance().initialize(context);

    // 1. Initialize Logging
    // show the extension output channel
    outputChannel.show();
    outputChannel.appendLine(`Congratulations, your extension ${EXTENSION_NAME} is now active!`);

    // ── Migration: rename legacy .ai-companion → .kdaina ──────────────
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const legacyDir = path.join(workspaceRoot, '.ai-companion');
        const newDir = path.join(workspaceRoot, '.kdaina');
        if (fs.existsSync(legacyDir) && !fs.existsSync(newDir)) {
            try {
                fs.renameSync(legacyDir, newDir);
                outputChannel.appendLine(`[Migration] Renamed .ai-companion → .kdaina`);
            } catch (e) {
                outputChannel.appendLine(`[Migration] Failed to rename .ai-companion: ${e}`);
            }
        }
    }

    // Migrate settings storage key
    const legacyKey = 'aiCompanion.customSettings';
    const newKey = 'kdaina.customSettings';
    const legacySettings = context.globalState.get(legacyKey);
    if (legacySettings && !context.globalState.get(newKey)) {
        context.globalState.update(newKey, legacySettings);
        context.globalState.update(legacyKey, undefined);
        outputChannel.appendLine(`[Migration] Migrated settings from ${legacyKey} → ${newKey}`);
    }

    // 2. Initialize the Webview Provider
    // The Provider now handles the Services (History/Core) internally
    const provider = ChatViewProvider.getInstance(context);

    // 3. Register the provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Track workspace index updates and push to webview live
    const { WorkspaceIndexService } = require('./services/workspace-index');
    WorkspaceIndexService.getInstance().onDidUpdate((count: number) => {
        provider.postMessage({
            command: 'indexUpdate',
            content: { fileCount: count, lastUpdated: new Date().toISOString() }
        });

        // Also push essence status (uses cached values — no I/O)
        const wsIndex = WorkspaceIndexService.getInstance();
        provider.postMessage({
            command: 'essenceStatus',
            content: wsIndex.getEssenceStatus()
        });
    });

    // Apply SSL Verification Setting
    const applySslConfig = () => {
        const config = vscode.workspace.getConfiguration('kdaina');
        const disableSsl = config.get<boolean>('disableSslVerification');
        if (disableSsl) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            outputChannel.appendLine('[Config] SSL Certificate Verification Disabled.');
        } else {
            // Restore default behavior
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            outputChannel.appendLine('[Config] SSL Certificate Verification Enabled.');
        }
    };
    applySslConfig();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kdaina.disableSslVerification')) {
                applySslConfig();
            }
        })
    );

    // 4. Register Virtual Document Provider for Diffs
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DiffContentProvider.scheme,
            DiffContentProvider.getInstance()
        )
    );

    // Register Load History Command
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_NAME}.${CHAT_COMMANDS.HISTORY_LOAD}`, () => {
            const view = ChatViewProvider.getView();
            if (view) {
                chatMessageListener({ command: CHAT_COMMANDS.HISTORY_LOAD });
            }
        })
    );

    // Register New Chat Command
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_NAME}.${CHAT_COMMANDS.CHAT_RESET}`, () => {
            // Send a signal to the Webview: "User clicked New Chat Button"
            const view = ChatViewProvider.getView();
            if (view) {
                chatMessageListener({ command: CHAT_COMMANDS.CHAT_RESET });
            }
        })
    );

    // Register UI Settings Command
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_NAME}.updateUISettings`, (uiData) => {
            const view = ChatViewProvider.getView();
            if (view && view.webview) {
                view.webview.postMessage({
                    command: 'uiSettingsUpdate',
                    ui: uiData
                });
            }
        })
    );

    // Register Settings Command
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXTENSION_NAME}.openSettings`, () => {
            const settingsManager = new SettingsManager(context);
            SettingsView.createOrShow(context, settingsManager);
        })
    );

    // 5. Register Review Manager Commands — #43 Direct-Write Model
    const reviewManager = ReviewManager.getInstance();
    reviewManager.initialize(context);

    // Helper: sync review state from ReviewManager → chatbox webview
    const syncReviewToWebview = async () => {
        const count = reviewManager.getTotalPendingCount();
        if (count === 0) {
            await ChatViewProvider.getInstance().postMessage({
                command: CHAT_COMMANDS.REVIEW_HUNKS_DATA,
                content: []
            });
            await ChatViewProvider.getInstance().postMessage({
                command: 'chatStagingUpdate',
                content: { stagedFilesCount: 0 }
            });
        } else {
            const uris = reviewManager.getStagedUris();
            const filesData = uris.map(u => ({
                fileName: path.basename(u.fsPath),
                uri: u.toString(),
                isNewFile: false,
                hunks: (reviewManager.getPendingEdits(u.toString()) || []).map(e => ({ accepted: true }))
            }));
            await ChatViewProvider.getInstance().postMessage({
                command: CHAT_COMMANDS.REVIEW_HUNKS_DATA,
                content: filesData
            });
            await ChatViewProvider.getInstance().postMessage({
                command: 'chatStagingUpdate',
                content: { stagedFilesCount: filesData.length }
            });
        }
    };

    context.subscriptions.push(
        reviewManager.onDidUpdateStaging(() => {
            syncReviewToWebview();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kdaina.acceptEdit', async (uriStr: string, editIndex: number) => {
            reviewManager.acceptEdit(uriStr, editIndex);
            vscode.window.showInformationMessage('Change accepted.');
            await syncReviewToWebview();
        }),
        vscode.commands.registerCommand('kdaina.revertEdit', async (uriStr: string, editIndex: number) => {
            await reviewManager.revertEdit(uriStr, editIndex);
            vscode.window.showInformationMessage('Change reverted.');
            await syncReviewToWebview();
        }),
        vscode.commands.registerCommand('kdaina.openDiff', async (uriStr: string) => {
            const fileUri = vscode.Uri.parse(uriStr);
            const pendingEdits = reviewManager.getPendingEdits(uriStr);
            if (pendingEdits && pendingEdits.length > 0) {
                const originalUri = fileUri.with({ scheme: DiffContentProvider.scheme });
                const originalContent = reviewManager.getOriginalContent(fileUri) ?? '';
                DiffContentProvider.getInstance().updateContent(originalUri, originalContent);
                
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    originalUri,
                    fileUri,
                    `${path.basename(fileUri.fsPath)} (Review Changes)`
                );
            } else {
                await vscode.window.showTextDocument(fileUri);
            }
        }),
        vscode.commands.registerCommand('kdaina.acceptAll', async (uriStr?: string) => {
            if (uriStr) {
                reviewManager.acceptAllForFile(uriStr);
            } else {
                await reviewManager.commitAll();
            }
            vscode.window.showInformationMessage('All changes accepted.');
            await syncReviewToWebview();
        }),
        vscode.commands.registerCommand('kdaina.rejectAll', async (uriStr?: string) => {
            if (uriStr) {
                await reviewManager.revertAllForFile(uriStr);
            } else {
                await reviewManager.discardAll();
            }
            vscode.window.showInformationMessage('All changes reverted.');
            await syncReviewToWebview();
        })
    );

    // 6. Direct In-File Review Features (CodeLens + Decorations)
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new ReviewCodeLensProvider())
    );

    const shouldAutoSaveDocument = (doc: vscode.TextDocument): boolean => {
        if (!doc.isDirty) {
            return false;
        }
        const filePath = doc.uri.fsPath.replace(/\\/g, '/');
        return (
            filePath.includes('.kdaina/agents/') ||
            filePath.includes('resources/agents/') ||
            filePath.includes('.kdaina/rules/') ||
            filePath.includes('resources/rules/')
        ) && filePath.endsWith('.md');
    };

    // Update decorations when editor changes, and save dirty agent/rule files on focus loss
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                ReviewDecorationProvider.updateDecorations(editor);
            }
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.isDirty && doc !== editor?.document && shouldAutoSaveDocument(doc)) {
                    await doc.save();
                }
            }
        }),
        vscode.workspace.onDidCloseTextDocument(async (doc) => {
            if (shouldAutoSaveDocument(doc)) {
                await doc.save();
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                ReviewDecorationProvider.updateDecorations(editor);
            }
        })
    );

    // 7. Auto-accept edits when the user saves a file (save = user approves the changes)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            // Skip if the ReviewManager itself is saving (AI-initiated save)
            if (reviewManager.isSaving) return;
            
            const uriStr = doc.uri.toString();
            const pending = reviewManager.getPendingEdits(uriStr);
            if (pending && pending.length > 0) {
                reviewManager.acceptAllForFile(uriStr);
                outputChannel.appendLine(`[Review] Auto-accepted ${pending.length} edit(s) on save: ${path.basename(doc.uri.fsPath)}`);
                await syncReviewToWebview();
            }
        })
    );

    if (vscode.window.activeTextEditor) {
        ReviewDecorationProvider.updateDecorations(vscode.window.activeTextEditor);
    }

    // Register Popup Toggle (Detach Chat)
    context.subscriptions.push(
        vscode.commands.registerCommand('kdaina.togglePopup', () => {
            // Ask the sidebar frontend to initiate the detach
            // (it checks isGenerating and handles the flow)
            const view = ChatViewProvider.getView();
            if (view) {
                view.webview.postMessage({ command: 'requestDetach' });
            }
        })
    );

    // Register Agent Hub
    context.subscriptions.push(
        vscode.commands.registerCommand('kdaina.openAgentHub', () => {
            AgentHubView.createOrShow(context);
        })
    );

    // DEV: Reset all stored data to simulate a fresh install
    context.subscriptions.push(
        vscode.commands.registerCommand('kdaina.resetAllData', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'This will wipe ALL kdAina data (settings, chat history, agents). Continue?',
                { modal: true },
                'Yes, Reset Everything'
            );
            if (confirm !== 'Yes, Reset Everything') { return; }
            const keys = context.globalState.keys();
            for (const key of keys) {
                await context.globalState.update(key, undefined);
            }
            vscode.window.showInformationMessage('kdAina: All data cleared. Reload window to apply.');
        })
    );

}


// This method is called when your extension is deactivated
export function deactivate() { }