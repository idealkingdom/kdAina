import * as vscode from 'vscode';
import { AppSettings, MODEL_PROVIDER } from '../constants';
import { getModelProviderOptions } from '../constants';

/**
 * Default settings for the application.
 * #52: Dynamic population from models.json registry.
 */
export const DEFAULT_SETTINGS: AppSettings = (() => {
    const options = getModelProviderOptions();
    const defaultProviderKey = Object.keys(options)[0] || MODEL_PROVIDER.OPEN_AI;
    const defaultProviderData = options[defaultProviderKey] || { models: { text: [], image: [] } };
    const defaultTextModel = (defaultProviderData.models?.text || [])[0] || '';
    const defaultImageModel = (defaultProviderData.models?.image || [])[0] || '';

    const dynamicProviderSettings: any = {};
    for (const [key, data] of Object.entries(options)) {
        dynamicProviderSettings[key] = {
            apiKey: '',
            baseUrl: (data as any).baseUrl || '',
            textModel: (data.models?.text || [])[0] || '',
            imageModel: (data.models?.image || [])[0] || ''
        };
    }

    return {
        general: {
            systemPrompt: "You are an expert AI assistant.",
            temperature: 0.5,
            theme: 'dark',
            contextMode: 'compact',
            enableSuggestions: false
        },
        models: {
            textModel: defaultTextModel,
            imageModel: defaultImageModel,
            baseUrl: '',
            apiKey: '',
            provider: defaultProviderKey,
            providerSettings: dynamicProviderSettings,
            inactiveModels: []
        },
        permissions: {
            readFilesConfirmation: true,
            writeFilesConfirmation: true,
            commandSafetyMode: 'smart',
            alwaysProceed: false,
            enableTerminalSandbox: false,
            newChatSessionPlacement: 'window'
        },
        tools: {
            sys_tools: 'ask',
            web_tools: 'always',
            cognitive_tools: 'always',
            artifact_tools: 'always',
            browser_tools: 'ask'
        },
        ui: {
            sidebarPosition: 'right',
            showLineNumbers: true,
            allowExternalMedia: true
        },
        prompts: [],
        customTemplates: [],
        customModels: [],
        rules: []
    };
})();

/**
 * Persists and coordinates user configuration keys across the workspace.
 */
export class SettingsManager {
    private static readonly KEY = 'kdaina.customSettings';
    private static readonly _onDidUpdateSettings = new vscode.EventEmitter<AppSettings>();
    public static readonly onDidUpdateSettings = SettingsManager._onDidUpdateSettings.event;

    constructor(private readonly context: vscode.ExtensionContext) { }

    public getSettings(): AppSettings {
        const stored = this.context.globalState.get<AppSettings>(SettingsManager.KEY);
        if (!stored) {
            return DEFAULT_SETTINGS;
        }

        const merged: AppSettings = {
            general: { ...DEFAULT_SETTINGS.general, ...stored.general },
            models: { ...DEFAULT_SETTINGS.models, ...stored.models },
            permissions: { ...DEFAULT_SETTINGS.permissions, ...stored.permissions },
            ui: { ...DEFAULT_SETTINGS.ui, ...stored.ui },
            prompts: [],
            customTemplates: stored.customTemplates || [],
            customModels: [], // Wiped: custom models are now managed via provider YAML files
            rules: [],
            tools: { ...DEFAULT_SETTINGS.tools, ...stored.tools }
        };

        // Migration from runCommandsConfirmation to commandSafetyMode
        if (stored.permissions && 'runCommandsConfirmation' in stored.permissions) {
            if (!('commandSafetyMode' in stored.permissions)) {
                const oldVal = (stored.permissions as any).runCommandsConfirmation;
                if (oldVal === true) {
                    merged.permissions.commandSafetyMode = 'smart';
                } else if (oldVal === false) {
                    merged.permissions.commandSafetyMode = 'none';
                }
            }
            // Remove the deprecated field to prevent it from overriding settings again
            delete (stored.permissions as any).runCommandsConfirmation;
            delete (merged.permissions as any).runCommandsConfirmation;
        }

        if (!merged.models.providerSettings) {
            merged.models.providerSettings = DEFAULT_SETTINGS.models.providerSettings;
        } else {
            merged.models.providerSettings = {
                ...DEFAULT_SETTINGS.models.providerSettings,
                ...merged.models.providerSettings
            };
        }

        // Sync with VS Code official settings (#52)
        const config = vscode.workspace.getConfiguration('kdaina');
        const configProvider = config.get<string>('modelProvider');
        const configToken = config.get<string>('accessToken');

        if (configProvider && !stored.models?.provider) {
            merged.models.provider = configProvider;
        }
        if (configToken && configToken.trim() !== '') {
            merged.models.apiKey = configToken;
            const currentProvider = merged.models.provider;
            if (merged.models.providerSettings[currentProvider] && !merged.models.providerSettings[currentProvider].apiKey) {
                merged.models.providerSettings[currentProvider].apiKey = configToken;
            }
        }

        return merged;
    }

    public async updateSettings(newSettings: Partial<AppSettings>): Promise<void> {
        const current = this.getSettings();
        const updated = { ...current, ...newSettings };
        await this.context.globalState.update(SettingsManager.KEY, updated);
        SettingsManager._onDidUpdateSettings.fire(updated);
    }

    public async resetSettings(): Promise<void> {
        await this.context.globalState.update(SettingsManager.KEY, undefined);
    }
}
