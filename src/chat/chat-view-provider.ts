import * as vscode from 'vscode';
import * as path from 'path';

import { fetchFilesWebView, getHTMLBase } from '../webviewshared';
import { SettingsManager } from '../services/settings-manager';

// import output channel for logging errors
import { outputChannel } from '../logger';


import { EXTENSION_NAME, getModelProviderOptions } from '../constants';

//CONSTANTS var
import {
    LIBRARY_FOLDER,
    CHATBOX_FOLDER,
    INDEX_HTML,
    FILES_TO_LOAD,
    LIBRARIES_TO_LOAD,
    CHAT_COMMANDS,
    ROLE,
    COMMANDS,
    WORKFLOWS
} from './chat-constants';
import { ApprovalService } from './approval-service';
import { ReviewManager } from './review-manager';


// MESSAGE LISTENER
import { chatMessageListener } from './chat-message-listener';

export class ChatViewProvider implements vscode.WebviewViewProvider {

    private static instance: ChatViewProvider;
    public static readonly viewType = EXTENSION_NAME;
    private static _view?: vscode.WebviewView;
    private static _activeWebviews = new Set<vscode.Webview>();
    private static _context: vscode.ExtensionContext;
    private static _currentSessionId?: string;

    private constructor(private context: vscode.ExtensionContext) {
        outputChannel.appendLine('ChatViewProvider initialized');
        ChatViewProvider._context = context;

        // Subscribe to global updates once
        ApprovalService.getInstance().onDidResolveApproval(({ toolCallId, approved }) => {
            this.postMessage({
                command: 'chatApprovalUpdate',
                data: { toolCallId, approved }
            });
        });

        ReviewManager.getInstance().onDidUpdateStaging(async (count: number) => {
            const reviewManager = ReviewManager.getInstance();
            const uris = reviewManager.getStagedUris();
            const filesData = uris.map(uri => {
                const edits = reviewManager.getPendingEdits(uri.toString()) || [];
                return {
                    fileName: path.basename(uri.fsPath),
                    uri: uri.toString(),
                    isNewFile: false,
                    hunks: edits.map(e => {
                        const oldLines = e.originalContent.split('\n');
                        const newLines = e.newContent.split('\n');
                        const lines: string[] = [];
                        for (const line of oldLines) { lines.push('-' + line); }
                        for (const line of newLines) { lines.push('+' + line); }
                        return {
                            accepted: true,
                            oldStart: e.startLine + 1,
                            oldLines: oldLines.length,
                            newStart: e.startLine + 1,
                            newLines: newLines.length,
                            lines
                        };
                    })
                };
            });

            this.postMessage({
                command: 'chatStagingUpdate',
                content: { stagedFilesCount: count }
            });

            // Push fresh data so the review panel updates in real-time
            this.postMessage({
                command: CHAT_COMMANDS.REVIEW_HUNKS_DATA,
                content: filesData
            });
        });

        SettingsManager.onDidUpdateSettings((updated) => {
            this.postMessage({ command: 'uiSettingsUpdate', ui: updated.ui });
            this.postMessage({ command: 'generalSettingsUpdate', general: updated.general });
            this.postMessage({ command: 'agentsUpdate', agents: updated.prompts || [] });
            this.postMessage({ 
                command: 'modelsUpdate', 
                models: updated.models, 
                customModels: updated.customModels,
                availableModels: getModelProviderOptions()
            });
        });

        // #9: File save status listener
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            const reviewManager = ReviewManager.getInstance();
            if (reviewManager.isSaving) return; // Skip AI-triggered saves
            
            const uriStr = doc.uri.toString();
            const pending = reviewManager.getPendingEdits(uriStr);
            if (pending.length > 0) {
                // File with pending changes was saved by user
                this.postMessage({
                    command: 'fileSaveStatus',
                    content: { uri: uriStr, saved: true }
                });
            }
        });
    }

    public static setCurrentSessionId(id: string) {
        this._currentSessionId = id;
    }

    public static getCurrentSessionId() {
        return this._currentSessionId;
    }

    public static getInstance(context?: vscode.ExtensionContext): ChatViewProvider {
        if (!this.instance) {
            if (!context) { throw new Error('ChatViewProvider requires context on first getInstance() call.'); }
            this.instance = new ChatViewProvider(context);
        }
        return this.instance;
    }

    public static getContext() {
        return ChatViewProvider._context;
    }

    public static getView() {
        return ChatViewProvider._view;
    }

    /**
     * Broadcasts a message to all active webviews (sidebar + popups).
     */
    public postMessage(message: any) {
        const disposedWebviews: vscode.Webview[] = [];
        ChatViewProvider._activeWebviews.forEach(webview => {
            try {
                webview.postMessage(message);
            } catch (err) {
                disposedWebviews.push(webview);
            }
        });
        
        // Clean up disposed webviews
        disposedWebviews.forEach(wv => ChatViewProvider._activeWebviews.delete(wv));
    }

    public static removeWebview(webview: vscode.Webview) {
        this._activeWebviews.delete(webview);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        ChatViewProvider._view = webviewView;
        this.setupWebview(webviewView.webview);
        
        // Listen for visibility changes to auto-focus the input
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                webviewView.webview.postMessage({ command: 'focus' });
            }
        });

        // Listen for VS Code window focus changes (e.g. Alt-Tab)
        this.context.subscriptions.push(
            vscode.window.onDidChangeWindowState((e) => {
                if (e.focused && webviewView.visible) {
                    setTimeout(() => {
                        webviewView.webview.postMessage({ command: 'focus' });
                    }, 100);
                }
            })
        );

        // Remove from active list when disposed
        webviewView.onDidDispose(() => {
            ChatViewProvider._activeWebviews.delete(webviewView.webview);
            ChatViewProvider._view = undefined;
        });
    }

    public setupWebview(webview: vscode.Webview) {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.context.extensionUri,
                this.context.globalStorageUri,
                vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'chatbox'),
                vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'libraries'),
                vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'assets')
            ]
        };

        let html = getHTMLBase(webview, this.context, CHATBOX_FOLDER, INDEX_HTML);

        FILES_TO_LOAD.forEach(file => {
            html = fetchFilesWebView(webview, this.context, CHATBOX_FOLDER, html, file.placeholder, file.name);
        });

        LIBRARIES_TO_LOAD.forEach(lib => {
            html = fetchFilesWebView(webview, this.context, path.join(LIBRARY_FOLDER, lib.folderName).toString(), html, lib.placeholder, lib.name);
        });

        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'assets', 'logo.png'));
        html = html.replace('{{LOGO_URI}}', logoUri.toString());

        const settingsManager = new SettingsManager(this.context);
        const settings = settingsManager.getSettings();

        const SHARED_CONSTANTS = JSON.stringify({
            CHAT_COMMANDS: CHAT_COMMANDS,
            ROLE: ROLE,
            COMMANDS: COMMANDS,
            WORKFLOWS: WORKFLOWS,
            AGENTS: settings.prompts || [],
            MODELS: settings.models,
            AVAILABLE_MODELS: getModelProviderOptions(),
            CUSTOM_MODELS: settings.customModels || [],
            PERMISSIONS: settings.permissions,
            UI: settings.ui,
            GENERAL: settings.general
        });

        webview.html = html.replace(`"{{CONSTANTS}}"`, SHARED_CONSTANTS);

        // Add to active list
        ChatViewProvider._activeWebviews.add(webview);

        // Register message listener
        webview.onDidReceiveMessage(chatMessageListener);
    }
}
