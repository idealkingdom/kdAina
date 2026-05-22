/**
 * Agent Hub View
 * WebviewPanel for managing file-based agent profiles and rules.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { outputChannel } from '../logger';
import { SettingsManager } from '../services/settings-manager';
import { FileConfigService } from '../services/file-config-service';
import { getModelProviderOptions } from '../constants';

export class AgentHubView {
    public static currentPanel: AgentHubView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private settingsManager: SettingsManager;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this.settingsManager = new SettingsManager(context);

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            null,
            this._disposables
        );

        // Hot-reload agents and rules on file changes
        const fileConfig = FileConfigService.getInstance();
        this._disposables.push(
            fileConfig.onDidUpdateAgents(() => this.sendAgents()),
            fileConfig.onDidUpdateRules(() => this.sendRules())
        );
    }

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (AgentHubView.currentPanel) {
            AgentHubView.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'kdainaAgentHub',
            'Agent Hub',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview')]
            }
        );

        AgentHubView.currentPanel = new AgentHubView(panel, context.extensionUri, context);
    }

    public dispose() {
        AgentHubView.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────

    private sendAgents() {
        const agents = FileConfigService.getInstance().getAgents();
        this._panel.webview.postMessage({
            command: 'loadAgents',
            agents
        });
    }

    private sendRules() {
        const rules = FileConfigService.getInstance().getRules();
        this._panel.webview.postMessage({
            command: 'loadRules',
            rules
        });
    }

    // ─── MESSAGE HANDLER ─────────────────────────────────────────────────

    private async _handleMessage(message: any) {
        const fileConfig = FileConfigService.getInstance();
        switch (message.command) {

            // ═══ AGENTS ═══════════════════════════════════════════════

            case 'requestAgents': {
                this.sendAgents();
                return;
            }

            case 'addAgent': {
                try {
                    const id = fileConfig.createAgent('New Agent', 'You are an AI assistant.', 0.15, false);
                    vscode.window.showInformationMessage(`Agent 'New Agent' created as workspace file!`);
                    this.sendAgents();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create agent: ${e.message}`);
                }
                return;
            }

            case 'updateAgent': {
                try {
                    const { id, field, value } = message.data;
                    fileConfig.updateAgent(id, field, value);
                } catch (e: any) {
                    outputChannel.appendLine(`[AgentHub] Error updating agent: ${e.message}`);
                }
                return;
            }

            case 'deleteAgent': {
                try {
                    fileConfig.deleteAgent(message.data.id);
                    vscode.window.showInformationMessage(`Agent deleted.`);
                    this.sendAgents();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to delete agent: ${e.message}`);
                }
                return;
            }

            case 'editAgentFile': {
                try {
                    const { id } = message.data;
                    const agents = fileConfig.getAgents();
                    const agent = agents.find(a => a.id === id);
                    if (agent && agent.filePath) {
                        const doc = await vscode.workspace.openTextDocument(agent.filePath);
                        await vscode.window.showTextDocument(doc);
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to open agent file: ${e.message}`);
                }
                return;
            }

            // ═══ RULES ═══════════════════════════════════════════════

            case 'requestRules': {
                this.sendRules();
                return;
            }

            case 'addRule': {
                try {
                    const id = fileConfig.createRule('New Rule', 'Custom instructions here...');
                    vscode.window.showInformationMessage(`Rule 'New Rule' created in workspace!`);
                    this.sendRules();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create rule: ${e.message}`);
                }
                return;
            }

            case 'updateRule': {
                try {
                    const { id, field, value } = message.data;
                    fileConfig.updateRule(id, field, value);
                } catch (e: any) {
                    outputChannel.appendLine(`[AgentHub] Error updating rule: ${e.message}`);
                }
                return;
            }

            case 'deleteRule': {
                try {
                    fileConfig.deleteRule(message.data.id);
                    vscode.window.showInformationMessage(`Rule deleted.`);
                    this.sendRules();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to delete rule: ${e.message}`);
                }
                return;
            }

            case 'editRuleFile': {
                try {
                    const { id } = message.data;
                    const rules = fileConfig.getRules();
                    const rule = rules.find(r => r.id === id);
                    if (rule && rule.filePath) {
                        const doc = await vscode.workspace.openTextDocument(rule.filePath);
                        await vscode.window.showTextDocument(doc);
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to open rule file: ${e.message}`);
                }
                return;
            }
        }
    }

    // ─── HTML ────────────────────────────────────────────────────────────

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'agent-hub', 'agent-hub.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'agent-hub', 'agent-hub.css')
        );
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'webview', 'agent-hub', 'index.html');
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'assets', 'logo.png'));
        
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        html = html.replace('agent-hub.css', styleUri.toString());
        html = html.replace('agent-hub.js', scriptUri.toString());
        html = html.replace(/{{LOGO_URI}}/g, logoUri.toString());
        html = html.replace(`"{{MODELS}}"`, JSON.stringify(getModelProviderOptions()));
        return html;
    }
}
