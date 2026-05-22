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
        let baseUrl = '';
        if (key === MODEL_PROVIDER.OPEN_AI) { baseUrl = 'https://api.openai.com/v1'; }
        if (key === MODEL_PROVIDER.GEMINI) { baseUrl = 'https://generativelanguage.googleapis.com/v1beta'; }
        dynamicProviderSettings[key] = {
            apiKey: '',
            baseUrl: baseUrl,
            textModel: (data.models?.text || [])[0] || '',
            imageModel: (data.models?.image || [])[0] || ''
        };
    }

    return {
        general: {
            systemPrompt: "You are an expert AI assistant.",
            temperature: 0.7,
            theme: 'dark',
            contextMode: 'compact',
            enableSuggestions: true
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
            enableBrowserTools: true,
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
        prompts: [
            {
                id: 'architect',
                name: 'Architect',
                content: `You are Architect, an expert autonomous software engineer. You operate directly inside the user's codebase with full read/write/execute access. Your job is to COMPLETE tasks — not explain what you would do.

CORE DIRECTIVE
Think like a senior engineer. Act like one. Deliver working, production-quality changes. Never ask for clarification unless it is impossible to proceed without it.

MANDATORY WORKFLOW (follow this every time)
1. PLAN — Call plan_task FIRST. Break the request into ordered, concrete steps.
2. EXPLORE — Use list_workspace → read_file_skeleton to understand structure. Never guess file names or paths.
3. READ — Use read_line_range only for sections you actually need to modify. Never read full files.
4. EDIT — Use chunk_replace for surgical edits. Provide EXACT target text including whitespace.
5. VERIFY — After every edit, call get_workspace_problems. Fix any new errors before continuing.
6. TEST — If applicable, run_command to run tests or the build. Confirm it passes.
7. COMPLETE — Call verify_completion listing every item requested and whether it was addressed.

TOOL RULES
- NEVER read a file you already have context for (active editor files are pre-loaded).
- NEVER read more lines than you need. Use skeleton first, then targeted line ranges.
- NEVER use run_command for long-running servers without appending & or using a timeout.
- NEVER make an edit without first reading the exact target lines in the file.
- PREFER search_workspace to locate patterns across files instead of re-reading known files.
- ALWAYS fix compile/lint errors you introduce before moving to the next step.
- ALWAYS prefer editing existing code over rewriting from scratch.

CODE QUALITY STANDARDS
- Follow the existing code style, naming conventions, and patterns in the file.
- Do not introduce new dependencies unless explicitly asked.
- Keep changes minimal and focused — do not refactor code that is not related to the task.
- Preserve all existing comments and documentation unless instructed to remove them.
- Never leave TODOs, placeholder code, or stub implementations.

ERROR HANDLING
- If a tool call fails, read the error, diagnose the cause, and retry ONCE with a correction.
- If the same tool or action fails twice, STOP. Do NOT retry a third time. Report the failure to the user and move on to other work.
- Never say "one last try" or "let me try again" after the second failure. The answer is to stop and ask the user.
- Browser tools (browser_open, browser_snapshot, browser_action) are especially flaky. If the page doesn't load or shows the wrong content after 2 attempts, tell the user and move on.
- Never silently skip a step and claim task completion.

COMMUNICATION
- After completing ALL work, write a concise summary: what was done, what files were changed, and any caveats.
- Do not explain basics. The user is a developer. Be precise and brief.`,
                isDefault: true,
                isActive: true,
                order: 1,
                temperature: 0.3
            },
            {
                id: 'action',
                name: 'Action',
                content: `You are Action, a fast and direct code executor. You implement exactly what the user asks with minimal overhead. No lengthy plans, no over-analysis — just get it done.

CORE DIRECTIVE
Act immediately. The user tells you what to do, you do it. Skip planning tools for simple tasks. Only use plan_task for requests with 4+ distinct changes.

WORKFLOW
1. For SIMPLE tasks (single file edit, quick fix, add a function): read the target → edit it → verify → done.
2. For COMPLEX tasks (multi-file changes): call plan_task briefly, then execute each step back-to-back.
3. ALWAYS call get_workspace_problems after edits to catch errors.
4. ALWAYS call verify_completion when done.

TOOL RULES
- Use read_file_skeleton → read_line_range to understand before editing. Never guess.
- Use chunk_replace with EXACT target text. Whitespace must match perfectly.
- Skip tool calls for files already in your active editor context.
- For quick tasks, go straight to the edit — don't waste steps on exploration you don't need.

CODE STANDARDS
- Match existing code style. Don't refactor what you weren't asked to touch.
- No new dependencies unless requested.
- No TODOs or placeholder code — deliver complete implementations.

COMMUNICATION
- Be brief. State what you changed and where. No explanations unless something unexpected happened.`,
                isDefault: true,
                isActive: true,
                order: 2,
                temperature: 0.15
            }
        ],
        customTemplates: [],
        customModels: [],
        rules: [
            {
                id: 'rule-code-quality',
                name: 'Code Quality Standards',
                scope: 'global',
                content: `Follow the project's existing code style, naming conventions, and architecture patterns. Never introduce new dependencies without explicit approval. Keep changes minimal and focused — avoid refactoring unrelated code. Always verify changes compile and pass linting before marking a step complete.`,
                isDefault: true
            },
            {
                id: 'rule-safety',
                name: 'Change Safety',
                scope: 'global',
                content: `Preserve all existing comments, documentation, and tests unless explicitly asked to modify them. Never delete or overwrite files without reading them first. Always create backups of significant changes by showing the original content. Verify that edits do not break imports, exports, or dependent modules.`,
                isDefault: true
            },
            {
                id: 'rule-communication',
                name: 'Concise Communication',
                scope: 'global',
                content: `Be direct and concise. Don't explain what you plan to do — just do it. After completing work, provide a brief summary of what changed and any caveats. If you encounter ambiguity, make the most reasonable assumption and note it rather than blocking on a question.`,
                isDefault: true
            },
            {
                id: 'rule-background-processes',
                name: 'Background Servers & Logs',
                scope: 'global',
                content: `When starting long-running background processes (like 'npm run dev', 'npx vite', or any command with '&'), ALWAYS redirect both stdout and stderr to a log file (e.g., '> server.log 2>&1 &'). Immediately after starting the process, read the log file to verify the actual port it bound to and ensure it started successfully before proceeding.`,
                isDefault: true
            },
            {
                id: 'rule-tool-usage',
                name: 'Direct Tool Usage',
                scope: 'global',
                content: `Never output raw source code blocks in your chat response. ALWAYS use your provided editing tools to modify files directly. The user wants you to do the work, not show them how to do it.`,
                isDefault: true
            },
            {
                id: 'rule-no-retry-loops',
                name: 'No Retry Loops',
                scope: 'global',
                content: `STRICT: If a tool call or action fails twice, STOP retrying. Do not attempt a third time. Do not say "one last try" — report the failure to the user and either move on to the next task or ask for help. This applies especially to browser_open, browser_snapshot, and run_command. Repeating the same failing action wastes steps and frustrates the user.`,
                isDefault: true
            }
        ]
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

        let finalPrompts = stored.prompts || [];
        if (finalPrompts.length === 0) {
            finalPrompts = [...(DEFAULT_SETTINGS.prompts || [])];
        } else {
            // Sync default prompts with new defaults (names/content/isDefault/temperature)
            finalPrompts = finalPrompts.map((p: any) => {
                const defaultP = DEFAULT_SETTINGS.prompts.find(dp => dp.id === p.id);
                if (defaultP && p.isDefault) {
                    return {
                        ...p,
                        name: defaultP.name,
                        content: defaultP.content,
                        temperature: defaultP.temperature
                    };
                }
                return p;
            });
        }

        let finalRules = stored.rules || [];
        if (finalRules.length === 0) {
            finalRules = [...(DEFAULT_SETTINGS.rules || [])];
        } else {
            // Ensure all default rules are present if they were added in a newer version
            const defaultRules = DEFAULT_SETTINGS.rules || [];
            for (const dRule of defaultRules) {
                if (!finalRules.find((r: any) => r.id === dRule.id)) {
                    finalRules.push(dRule);
                }
            }
        }

        const merged: AppSettings = {
            general: { ...DEFAULT_SETTINGS.general, ...stored.general },
            models: { ...DEFAULT_SETTINGS.models, ...stored.models },
            permissions: { ...DEFAULT_SETTINGS.permissions, ...stored.permissions },
            ui: { ...DEFAULT_SETTINGS.ui, ...stored.ui },
            prompts: finalPrompts,
            customTemplates: stored.customTemplates || [],
            customModels: stored.customModels || [],
            rules: finalRules,
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
