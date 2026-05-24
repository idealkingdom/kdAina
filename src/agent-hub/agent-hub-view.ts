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

        // Hot-reload agents, rules, and providers on file changes
        const fileConfig = FileConfigService.getInstance();
        this._disposables.push(
            fileConfig.onDidUpdateAgents(() => this.sendAgents()),
            fileConfig.onDidUpdateRules(() => this.sendRules()),
            fileConfig.onDidUpdateProviders(() => this.sendProviders())
        );

        // Re-send data when panel becomes visible again (postMessage may be
        // silently dropped while the panel is hidden in the background)
        this._panel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible) {
                    this.sendAgents();
                    this.sendRules();
                    this.sendProviders();
                    this.sendSettings();
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (AgentHubView.currentPanel) {
            AgentHubView.currentPanel._panel.reveal(column);
            // Always push fresh data when re-showing the panel
            AgentHubView.currentPanel.sendAgents();
            AgentHubView.currentPanel.sendRules();
            AgentHubView.currentPanel.sendProviders();
            AgentHubView.currentPanel.sendSettings();
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
        try {
            const agents = FileConfigService.getInstance().getAgents();
            this._panel.webview.postMessage({
                command: 'loadAgents',
                agents
            });
        } catch (e: any) {
            outputChannel.appendLine(`[AgentHub] sendAgents failed: ${e.message}`);
        }
    }

    private sendRules() {
        try {
            const rules = FileConfigService.getInstance().getRules();
            this._panel.webview.postMessage({
                command: 'loadRules',
                rules
            });
        } catch (e: any) {
            outputChannel.appendLine(`[AgentHub] sendRules failed: ${e.message}`);
        }
    }

    private sendProviders() {
        try {
            const providers = FileConfigService.getInstance().getProviders();
            this._panel.webview.postMessage({
                command: 'loadProviders',
                providers
            });
        } catch (e: any) {
            outputChannel.appendLine(`[AgentHub] sendProviders failed: ${e.message}`);
        }
    }

    private sendSettings() {
        try {
            const settings = this.settingsManager.getSettings();
            this._panel.webview.postMessage({
                command: 'loadSettings',
                providerSettings: settings.models.providerSettings || {},
                inactiveModels: settings.models.inactiveModels || []
            });
        } catch (e: any) {
            outputChannel.appendLine(`[AgentHub] sendSettings failed: ${e.message}`);
        }
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
                        if (agent.isDefault) {
                            // Clone built-in to workspace on Edit click
                            const ws = vscode.workspace.workspaceFolders?.[0];
                            if (!ws) { throw new Error('No workspace folder open'); }
                            const wsAgentsPath = path.join(ws.uri.fsPath, '.kdaina', 'agents');
                            if (!fs.existsSync(wsAgentsPath)) {
                                fs.mkdirSync(wsAgentsPath, { recursive: true });
                            }
                            const targetPath = path.join(wsAgentsPath, `${id}.md`);
                            const content = fs.readFileSync(agent.filePath, 'utf8');
                            fs.writeFileSync(targetPath, content, 'utf8');
                            const doc = await vscode.workspace.openTextDocument(targetPath);
                            await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preserveFocus: false
                            });
                            this.sendAgents(); // Refresh hub to show Workspace badge
                        } else {
                            const doc = await vscode.workspace.openTextDocument(agent.filePath);
                            await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preserveFocus: false
                            });
                        }
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
                        if (rule.isDefault) {
                            // Clone built-in to workspace on Edit click
                            const ws = vscode.workspace.workspaceFolders?.[0];
                            if (!ws) { throw new Error('No workspace folder open'); }
                            const wsRulesPath = path.join(ws.uri.fsPath, '.kdaina', 'rules');
                            if (!fs.existsSync(wsRulesPath)) {
                                fs.mkdirSync(wsRulesPath, { recursive: true });
                            }
                            const targetPath = path.join(wsRulesPath, `${id}.md`);
                            let content = fs.readFileSync(rule.filePath, 'utf8');
                            if (!content.startsWith('---')) {
                                content = `---\nname: ${rule.name}\nscope: ${rule.scope}\n---\n${content}`;
                            }
                            fs.writeFileSync(targetPath, content, 'utf8');
                            const doc = await vscode.workspace.openTextDocument(targetPath);
                            await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preserveFocus: false
                            });
                            this.sendRules(); // Refresh hub to show Workspace badge
                        } else {
                            const doc = await vscode.workspace.openTextDocument(rule.filePath);
                            await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preserveFocus: false
                            });
                        }
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to open rule file: ${e.message}`);
                }
                return;
            }

            // ═══ PROVIDERS ═══════════════════════════════════════════

            case 'requestProviders': {
                this.sendProviders();
                return;
            }

            case 'addProvider': {
                try {
                    const { name, baseUrl } = message.data;
                    fileConfig.createProvider(name, baseUrl);
                    this.sendProviders();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create provider: ${e.message}`);
                }
                return;
            }

            case 'deleteProvider': {
                try {
                    fileConfig.deleteProvider(message.data.id);
                    vscode.window.showInformationMessage('Provider deleted.');
                    this.sendProviders();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to delete provider: ${e.message}`);
                }
                return;
            }

            case 'editProviderFile': {
                try {
                    const { id } = message.data;
                    const providers = fileConfig.getProviders();
                    const provider = Object.values(providers).find((p: any) => p.id === id) as any;
                    if (provider && provider.filePath) {
                        if (provider.isDefault) {
                            // Clone to workspace
                            const ws = vscode.workspace.workspaceFolders?.[0];
                            if (!ws) { throw new Error('No workspace folder open'); }
                            const wsProvidersPath = path.join(ws.uri.fsPath, '.kdaina', 'providers');
                            if (!fs.existsSync(wsProvidersPath)) {
                                fs.mkdirSync(wsProvidersPath, { recursive: true });
                            }
                            const targetPath = path.join(wsProvidersPath, `${id}.yaml`);
                            const content = fs.readFileSync(provider.filePath, 'utf8');
                            fs.writeFileSync(targetPath, content, 'utf8');
                            const doc = await vscode.workspace.openTextDocument(targetPath);
                            await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preserveFocus: false
                            });
                            this.sendProviders();
                        } else {
                            const doc = await vscode.workspace.openTextDocument(provider.filePath);
                            await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preserveFocus: false
                            });
                        }
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to open provider file: ${e.message}`);
                }
                return;
            }

            // ═══ MODELS ═══════════════════════════════════════════════

            case 'addModel': {
                try {
                    const { providerId, modelName, types } = message.data;
                    fileConfig.addModelToProvider(providerId, modelName, types);
                    this.sendProviders();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to add model: ${e.message}`);
                }
                return;
            }

            case 'removeModel': {
                try {
                    const { providerId, modelName } = message.data;
                    fileConfig.removeModelFromProvider(providerId, modelName);
                    this.sendProviders();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to remove model: ${e.message}`);
                }
                return;
            }

            // ═══ SETTINGS ═════════════════════════════════════════════

            case 'requestSettings': {
                this.sendSettings();
                return;
            }

            case 'updateProviderApiKey': {
                try {
                    const { providerName, apiKey } = message.data;
                    const settings = this.settingsManager.getSettings();
                    if (!settings.models.providerSettings) settings.models.providerSettings = {};
                    if (!settings.models.providerSettings[providerName]) {
                        settings.models.providerSettings[providerName] = { apiKey: '', baseUrl: '', textModel: '', imageModel: '' };
                    }
                    settings.models.providerSettings[providerName].apiKey = apiKey;
                    await this.settingsManager.updateSettings({ models: settings.models });
                } catch (e: any) {
                    outputChannel.appendLine(`[AgentHub] Error updating provider API key: ${e.message}`);
                }
                return;
            }

            case 'toggleModelActive': {
                try {
                    const { modelName, isActive } = message.data;
                    const settings = this.settingsManager.getSettings();
                    if (!settings.models.inactiveModels) settings.models.inactiveModels = [];
                    if (!isActive) {
                        if (!settings.models.inactiveModels.includes(modelName)) {
                            settings.models.inactiveModels.push(modelName);
                        }
                    } else {
                        settings.models.inactiveModels = settings.models.inactiveModels.filter((m: string) => m !== modelName);
                    }
                    await this.settingsManager.updateSettings({ models: settings.models });
                    this.sendSettings(); // Push updated state back to UI
                } catch (e: any) {
                    outputChannel.appendLine(`[AgentHub] Error toggling model: ${e.message}`);
                }
                return;
            }

            case 'toggleMultipleModels': {
                try {
                    const { modelNames, isActive } = message.data;
                    const settings = this.settingsManager.getSettings();
                    if (!settings.models.inactiveModels) settings.models.inactiveModels = [];
                    if (!isActive) {
                        for (const name of modelNames) {
                            if (!settings.models.inactiveModels.includes(name)) {
                                settings.models.inactiveModels.push(name);
                            }
                        }
                    } else {
                        const set = new Set(modelNames);
                        settings.models.inactiveModels = settings.models.inactiveModels.filter((m: string) => !set.has(m));
                    }
                    await this.settingsManager.updateSettings({ models: settings.models });
                    this.sendSettings(); // Push updated state back to UI
                } catch (e: any) {
                    outputChannel.appendLine(`[AgentHub] Error toggling multiple models: ${e.message}`);
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
