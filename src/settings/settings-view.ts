import * as vscode from 'vscode';
import * as fs from 'fs';


import { OutputChannel } from 'vscode';
import { SettingsManager } from '../services/settings-manager';
import { MODEL_PROVIDER, getModelProviderOptions } from '../constants';
import { outputChannel } from '../logger';
import { ChatViewProvider } from '../chat/chat-view-provider';


/**
 * WebviewPanel provider that displays configuration settings forms.
 */
export class SettingsView {
    public static currentPanel: SettingsView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _settingsManager: SettingsManager;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, settingsManager: SettingsManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._settingsManager = settingsManager;

        // Set the webview's initial html content
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'requestSettings':
                        const settings = this._settingsManager.getSettings();
                        this._panel.webview.postMessage({
                            command: 'loadSettings',
                            settings,
                            availableModels: getModelProviderOptions()
                        });
                        return;

                    case 'saveSettings':
                        await this._settingsManager.updateSettings(message.settings);
                        vscode.commands.executeCommand('kdaina.updateUISettings', message.settings.ui);
                        // Broadcast live settings update to all chat webviews
                        ChatViewProvider.getInstance().postMessage({
                            command: 'settingsChanged',
                            settings: message.settings
                        });
                        break;

                    case 'saveSetting':
                    case 'updateNestedSetting': {
                        const { category, key, value } = message.data;
                        const currentSettings = this._settingsManager.getSettings();
                        if (currentSettings[category as keyof typeof currentSettings]) {
                            (currentSettings[category as keyof typeof currentSettings] as any)[key] = value;
                            await this._settingsManager.updateSettings({ [category]: currentSettings[category as keyof typeof currentSettings] });
                            
                            // Broadcast live settings update to all chat webviews
                            ChatViewProvider.getInstance().postMessage({
                                command: 'settingsChanged',
                                settings: currentSettings
                            });
                        }
                        break;
                    }

                    case 'updateVsCodeSetting': {
                        const { key, value } = message.data;
                        const config = vscode.workspace.getConfiguration('kdaina');
                        await config.update(key, value, vscode.ConfigurationTarget.Global);
                        break;
                    }

                    case 'generateTheme':
                        try {
                            const appSettings = this._settingsManager.getSettings();
                            const model = appSettings.models.textModel || 'gpt-4o';
                            const customModel = (appSettings.customModels || []).find((cm: any) => cm.name === model);

                            const provider = customModel?.provider || appSettings.models.provider || 'OpenAI';
                            const pConfig = appSettings.models.providerSettings?.[provider] || {};

                            const apiKey = customModel?.apiKey || pConfig.apiKey || appSettings.models.apiKey || '';
                            const baseUrl = customModel?.baseUrl || pConfig.baseUrl || '';

                            if (!apiKey) {
                                this._panel.webview.postMessage({
                                    command: 'generateThemeResult',
                                    success: false,
                                    error: 'No API key configured. Please set up your API key in the Models tab first.'
                                });
                                return;
                            }

                            const { aiRequest } = require('../api/ai');
                            const themePrompt = message.data?.prompt || '';

                            const systemPrompt = `You are a CSS theme generator for a VS Code extension chatbox UI.
The CSS you generate will ONLY be applied to the chat interface (not the settings panel or agent hub).
Output ONLY valid CSS code. No markdown, no explanations, no code fences, no backticks.

═══ CSS VARIABLES (override inside :root) ═══
--app-bg              Main app background
--chat-bg             Chat area background (body bg)
--text-color          Primary text color
--border-color        General borders
--input-bg            Input field background
--input-fg            Input field text color
--input-placeholder   Input placeholder color
--input-focus-border  Input focus ring color
--user-msg-bg         User message bubble background
--user-msg-fg         User message text color
--code-bg             Code block background
--code-fg             Code block text color
--accent-color        Primary accent (links, highlights)
--accent-glow         Accent glow (rgba for shadows)
--accent-gradient     Accent gradient (for buttons)
--sidebar-bg          Sidebar panel background
--panel-bg            Panel/card background
--panel-border        Panel border color
--bg-base             Base background fallback
--font-ui             UI font family
--font-editor         Editor/code font family
--system-msg-bg       System message background
--system-msg-fg       System message text color
--btn-secondary-bg    Secondary button background
--btn-secondary-fg    Secondary button text color

═══ SAFE SELECTORS TO STYLE ═══
body                         — background, font-family, color, text-shadow
.message-body                — border, border-radius, box-shadow, backdrop-filter, background
.unified-input-container     — border, border-radius, box-shadow, background, backdrop-filter
.send-btn-premium            — background, box-shadow, border-radius, color
code, pre                    — color, font-family, background
.agent-step-card             — background, border
.agent-thinking-block        — background, border
.status-pill                 — background, border
.toolbar-btn                 — color, background
*::-webkit-scrollbar-thumb   — background

═══ UX & COLOR GUIDELINES ═══
• Use complementary or analogous color harmonies — never random colors
• Ensure WCAG AA contrast ratio (4.5:1 for text, 3:1 for large text)
• --text-color must always be readable against --chat-bg and --app-bg
• --input-fg must be readable against --input-bg
• --user-msg-fg must be readable against --user-msg-bg
• Use subtle, low-opacity backgrounds for message bubbles (0.06–0.15 alpha)
• Accent colors should pop but not be harsh — use saturation wisely
• Dark themes: light text on dark bg. Light themes: dark text on light bg.
• Borders and shadows should be subtle, not distracting
• Send button gradient should harmonize with the accent color
• Pick a cohesive palette of 2-3 colors max, derive all others from them

═══ RULES ═══
• Always use !important for overrides
• Start with a comment header: /* ─── Theme Name ─── */
• Only set colors, fonts, borders, shadows, border-radius, backdrop-filter
• NEVER use: @import, @charset, position:fixed, position:absolute, display:none, visibility:hidden, z-index, JavaScript expressions, content:, animation that hides elements
• url() is allowed for background-image only (e.g. background wallpapers)
• NEVER remove or hide elements
• Keep it purely cosmetic: colors, typography, spacing, shadows, gradients

═══ EXAMPLE (Futuristic theme) ═══
:root {
    --app-bg: #0a0a1a !important;
    --chat-bg: #070714 !important;
    --text-color: #e0e8ff !important;
    --border-color: rgba(0, 242, 254, 0.15) !important;
    --input-bg: rgba(15, 15, 40, 0.8) !important;
    --input-fg: #c8d6ff !important;
    --input-focus-border: #00f2fe !important;
    --user-msg-bg: rgba(79, 172, 254, 0.08) !important;
    --code-bg: rgba(0, 242, 254, 0.05) !important;
    --accent-color: #00f2fe !important;
    --accent-glow: rgba(0, 242, 254, 0.3) !important;
    --accent-gradient: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%) !important;
}
body { background: linear-gradient(145deg, #0a0a1a 0%, #0d0d2b 50%, #0a0a1a 100%) !important; }
.message-body { border: 1px solid rgba(0, 242, 254, 0.12) !important; border-radius: 16px !important; background: rgba(10, 10, 30, 0.6) !important; }
.send-btn-premium { background: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%) !important; }`;

                            const result = await aiRequest(
                                [
                                    { role: 'system', content: systemPrompt },
                                    { role: 'user', content: `Generate a CSS theme: ${themePrompt}` }
                                ],
                                model, apiKey, 0.7, provider, baseUrl
                            );

                            // ─── SANITIZE OUTPUT ─────────────────────────────
                            let css = result.content || '';

                            // Strip markdown fences
                            css = css.replace(/^```(?:css)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

                            // Remove dangerous patterns
                            const dangerousPatterns = [
                                /@import\b/gi,
                                /@charset\b/gi,
                                /expression\s*\(/gi,
                                /javascript\s*:/gi,
                                /position\s*:\s*(fixed|absolute)/gi,
                                /display\s*:\s*none/gi,
                                /visibility\s*:\s*hidden/gi,
                                /opacity\s*:\s*0(?!\.\d)/gi,
                                /z-index\s*:\s*\d{4,}/gi,
                                /<script/gi,
                                /<\/script/gi,
                            ];

                            for (const pattern of dangerousPatterns) {
                                css = css.replace(pattern, '/* [removed] */');
                            }

                            // Basic validation: must contain at least one CSS rule or variable
                            if (!css.includes('{') || !css.includes('}')) {
                                this._panel.webview.postMessage({
                                    command: 'generateThemeResult',
                                    success: false,
                                    error: 'AI returned invalid CSS. Please try rephrasing your prompt.'
                                });
                                return;
                            }

                            this._panel.webview.postMessage({
                                command: 'generateThemeResult',
                                success: true,
                                css
                            });
                        } catch (err: any) {
                            outputChannel.appendLine(`[Settings] Theme generation error: ${err.message}`);
                            this._panel.webview.postMessage({
                                command: 'generateThemeResult',
                                success: false,
                                error: err.message || 'Theme generation failed.'
                            });
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(context: vscode.ExtensionContext, settingsManager: SettingsManager) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (SettingsView.currentPanel) {
            SettingsView.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'kdainaSettings',
            'kdAina Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview')]
            }
        );

        SettingsView.currentPanel = new SettingsView(panel, context.extensionUri, settingsManager);
    }


    public dispose() {
        SettingsView.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Local path to main script run in the webview
        const scriptPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview', 'settings', 'settings.js');
        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

        // Local path to css styles
        const stylePathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview', 'settings', 'style.css');
        const styleUri = webview.asWebviewUri(stylePathOnDisk);

        // Use a nonce to whitelist which scripts can be run
        const nonce = getNonce();

        // Read HTML file from disk
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'webview', 'settings', 'index.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

        // Replace placeholders with real URIs
        htmlContent = htmlContent.replace('style.css', styleUri.toString());
        htmlContent = htmlContent.replace('settings.js', scriptUri.toString());

        // Inject Models
        outputChannel.appendLine(JSON.stringify(Object.keys(getModelProviderOptions())));
        htmlContent = htmlContent.replace(`"{{MODELS}}"`, JSON.stringify(getModelProviderOptions()));

        // Inject Logo
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'assets', 'logo.png'));
        htmlContent = htmlContent.replace(/{{LOGO_URI}}/g, logoUri.toString());

        // Inject Nonce (Safety) - If we add CSP
        // htmlContent = htmlContent.replace(/nonce-PLACEHOLDER/g, nonce);

        return htmlContent;
    }

}


function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
