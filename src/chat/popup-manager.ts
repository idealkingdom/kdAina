import * as vscode from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './chat-view-provider';
import { fetchFilesWebView, getHTMLBase } from '../webviewshared';
import { SettingsManager } from '../services/settings-manager';
import { EXTENSION_NAME, getModelProviderOptions } from '../constants';
import { chatMessageListener } from './chat-message-listener';
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

/**
 * PopupManager - Manages detached WebviewPanels.
 * Each popup is a fully independent chat session with its own message handler.
 * Messages are NOT broadcast to/from the sidebar.
 */
export class PopupManager {
    private static _panels = new Set<vscode.WebviewPanel>();

    /**
     * Opens a new independent popup chat session.
     * Optionally receives a chatId to load an existing conversation.
     * @param chatState - Optional { chatId } to load a conversation into the popup.
     */
    public static async openPopup(context: vscode.ExtensionContext, chatState?: { chatId?: string }) {
        if (this._panels.size > 0) {
            const existingPanel = Array.from(this._panels)[0];
            existingPanel.reveal(existingPanel.viewColumn);
            if (chatState?.chatId) {
                existingPanel.webview.postMessage({
                    command: 'loadChatInPopup',
                    chatId: chatState.chatId
                });
            }
            return;
        }

        const settingsManager = new SettingsManager(context);
        const settings = settingsManager.getSettings();
        const placement = settings.permissions?.newChatSessionPlacement || 'window';
        const viewColumn = placement === 'panel' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;

        const panel = vscode.window.createWebviewPanel(
            'kdainaChatPopup',
            'kdAina Chat',
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    context.extensionUri,
                    context.globalStorageUri,
                    vscode.Uri.joinPath(context.extensionUri, 'webview', 'chatbox'),
                    vscode.Uri.joinPath(context.extensionUri, 'webview', 'libraries'),
                    vscode.Uri.joinPath(context.extensionUri, 'webview', 'assets')
                ]
            }
        );

        this._panels.add(panel);

        // Build the HTML independently (same source files, but isolated instance)
        let html = getHTMLBase(panel.webview, context, CHATBOX_FOLDER, INDEX_HTML);

        FILES_TO_LOAD.forEach(file => {
            html = fetchFilesWebView(panel.webview, context, CHATBOX_FOLDER, html, file.placeholder, file.name);
        });

        LIBRARIES_TO_LOAD.forEach(lib => {
            html = fetchFilesWebView(panel.webview, context, path.join(LIBRARY_FOLDER, lib.folderName).toString(), html, lib.placeholder, lib.name);
        });

        const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'assets', 'logo.png'));
        html = html.replace(/{{LOGO_URI}}/g, logoUri.toString());

        const { FileConfigService } = require('../services/file-config-service');

        const SHARED_CONSTANTS = JSON.stringify({
            CHAT_COMMANDS: CHAT_COMMANDS,
            ROLE: ROLE,
            COMMANDS: COMMANDS,
            WORKFLOWS: WORKFLOWS,
            AGENTS: FileConfigService.getInstance().getAgents(),
            MODELS: settings.models,
            AVAILABLE_MODELS: getModelProviderOptions(),
            CUSTOM_MODELS: settings.customModels || [],
            PERMISSIONS: settings.permissions,
            UI: settings.ui
        });

        panel.webview.html = html.replace(`"{{CONSTANTS}}"`, SHARED_CONSTANTS);

        // Register an INDEPENDENT message listener — bound to this popup's webview
        panel.webview.onDidReceiveMessage((msg) => chatMessageListener(msg, panel.webview));

        // If detaching a conversation, tell the popup to load it via CHAT_LOAD
        if (chatState?.chatId) {
            // Wait for the webview to initialize, then send loadChatInPopup
            setTimeout(() => {
                panel.webview.postMessage({
                    command: 'loadChatInPopup',
                    chatId: chatState.chatId
                });
            }, 500);
        }

        panel.onDidDispose(() => {
            this._panels.delete(panel);
        });

        // Set icon
        const iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo_128.png');
        panel.iconPath = iconPath;
    }

    public static disposeAll() {
        this._panels.forEach(p => p.dispose());
        this._panels.clear();
    }
}
