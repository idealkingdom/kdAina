import * as vscode from 'vscode';
import * as os from 'os';
import { aiRequest, aiStreamRequest, aiAgenticRequest } from '../api/ai';
import { outputChannel } from '../logger';
import { ROLE } from '../chat/chat-constants';
import { ChatHistoryService } from './chat-history';
import * as crypto from 'crypto';
import { ImageStorageService } from './image-storage';
import { ImageDescriptionService } from './image-description-service';
import { SettingsManager } from '../services/settings-manager';
import { WorkspaceIndexService } from '../services/workspace-index';
import { createToolRegistry } from '../tools/tool-registry';
import { getModelTier } from '../constants';
import { handleInlineReview } from './chat-message-listener';
import { ReviewManager } from './review-manager';
import { ApprovalService } from './approval-service';

/**
 * #52 — Collects system information so the agent knows which commands to run.
 * Kept compact to minimize token usage.
 */
function getSystemInfo(): string {
    const platform = os.platform(); // 'linux', 'darwin', 'win32'
    const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
    const arch = os.arch();
    const shell = process.env.SHELL || process.env.COMSPEC || (platform === 'win32' ? 'cmd.exe' : '/bin/bash');
    const nodeVersion = process.version;
    const vsCodeVersion = vscode.version;
    const homeDir = os.homedir();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'unknown';

    return `--- SYSTEM INFO ---
OS: ${osName} (${arch})
Shell: ${shell}
Node.js: ${nodeVersion}
VS Code: ${vsCodeVersion}
Home: ${homeDir}
Workspace: ${workspaceName} → ${workspaceRoot}`;
}

export interface AgentStepEvent {
    type: 'tool_call' | 'tool_result' | 'thinking' | 'text_chunk';
    toolName?: string;
    args?: any;
    result?: any;
    text?: string;
    toolCallId?: string;
    approvalRequired?: boolean;
    diffReviewRequired?: boolean;
}

export class ChatCoreService {

    private workspaceIndex: WorkspaceIndexService;
    private static activeAbortControllers: Map<string, AbortController> = new Map();

    constructor(
        private readonly historyService: ChatHistoryService,
        private readonly imageService: ImageStorageService,
        private readonly settingsManager: SettingsManager,
        private readonly descriptionService: ImageDescriptionService = new ImageDescriptionService(settingsManager)
    ) {
        this.workspaceIndex = WorkspaceIndexService.getInstance();
    }

    /**
     * Helper to generate a new Chat ID uuid v4
     */
    public generateChatID(): string {
        return crypto.randomUUID();
    }
    /**
     * Cancel ongoing AI generation
     */
    public cancelChatRequest(chatId: string): boolean {
        const controller = ChatCoreService.activeAbortControllers.get(chatId);
        if (controller) {
            controller.abort();
            ChatCoreService.activeAbortControllers.delete(chatId);
            ApprovalService.getInstance().clearAllApprovals();
            outputChannel.appendLine(`[ChatCore] Cancelled request for chatId=${chatId} and flushed pending approvals.`);
            return true;
        }
        return false;
    }
    /**
     * Processes the user's message:
     * 1. Saves Images to Disk (Hybrid Storage)
     * 2. Saves User Message to History (with file paths)
     * 3. Calls AI API (with Base64 images)
     * 4. Saves AI Message to History
     */
    public async processChatRequest(data: {
        message: string,
        chat_id: string,
        timestamp: string,
        files?: any[],
        images?: any[],
        agentId?: string
    }, onChunk?: (text: string) => Promise<void> | void,
        onAgentStep?: (step: AgentStepEvent) => void): Promise<{ text: string, usage?: any, hitStepLimit?: boolean, continuationMaxSteps?: number }> {

        const hasImages = data.images && Array.isArray(data.images) && data.images.length > 0;

        // 1. GET SETTINGS
        const appSettings = this.settingsManager.getSettings();

        // #49: Use smart defaults instead of user-configurable temperature/context
        const maxContext = (appSettings.general as any)?.maxContextMessages ?? 20;
        const currentProvider = appSettings.models.provider;
        const temperature = 0.5; // Balanced: focused but not robotic

        let aiResponseText = "";
        let totalUsage: any = null;
        let hitStepLimit = false;
        let continuationMaxSteps = 0;
        const collectedAgentSteps: any[] = [];

        const abortController = new AbortController();
        ChatCoreService.activeAbortControllers.set(data.chat_id, abortController);

        try {
            // --- STEP A: HANDLE IMAGES ---
            const storedImageFilenames: string[] = [];
            const storedImageDescriptions: string[] = [];
            const aiImagePayload: any[] = [];

            if (hasImages) {
                const descriptionPromises = data.images!.map(async (img) => {
                    const fileName = await this.imageService.saveImage(img.dataUrl);
                    storedImageFilenames.push(fileName);
                    const desc = await this.descriptionService.describeImage(img.dataUrl);
                    storedImageDescriptions.push(desc);
                    aiImagePayload.push({
                        type: "image",
                        image: img.dataUrl
                    });
                });
                await Promise.all(descriptionPromises);
            }

            // --- STEP B: SAVE USER MESSAGE TO HISTORY ---
            // #46: Preserve content for URL-scraped files since they can't be re-opened by path
            const lightweightFiles = data.files ? data.files.map((f: any) => {
                const isUrl = f.path && (f.path.startsWith('http://') || f.path.startsWith('https://'));
                return {
                    name: f.name,
                    path: f.path,
                    language: f.language,
                    ...(isUrl && f.content ? { content: f.content } : {})
                };
            }) : [];
            await this.historyService.addMessage(
                data.chat_id, ROLE.USER, data.message,
                storedImageFilenames, storedImageDescriptions,
                data.agentId, undefined, lightweightFiles
            );

            // --- STEP C: PREPARE API PAYLOAD ---
            const contextMessages = this.historyService.getContextWindow(data.chat_id, maxContext);

            let currentMessageContent: any;
            if (hasImages) {
                currentMessageContent = [
                    { type: "text", text: data.message },
                    ...aiImagePayload
                ];
            } else {
                currentMessageContent = data.message;
            }

            // Remove last user message from context (we append it with multimodal support)
            if (contextMessages.length > 0 && contextMessages[contextMessages.length - 1].role === 'user') {
                contextMessages.pop();
            }

            // #66: Determine vision capability dynamically from provider config
            const configProvider = appSettings.models.provider;
            const { getModelProviderOptions } = require('../constants');
            const providerOptions = getModelProviderOptions();
            const providerData = providerOptions[configProvider];
            const providerImageModels: string[] = providerData?.models?.image || [];

            // Use the provider's configured model — never hardcode a specific provider's model ID
            const fallbackTextModel = appSettings.models.textModel;
            // #66: If no image model is configured, default to the text model
            const fallbackImageModel = appSettings.models.imageModel || fallbackTextModel;

            let targetModel: string = fallbackTextModel;
            let finalContextMessages = [...contextMessages];
            let finalCurrentMessage: any = currentMessageContent;

            if (hasImages) {
                // Check if the active model supports vision:
                // 1. Custom model with IMAGE toggle ON (supportsImage flag)
                // 2. Provider's hardcoded image model list
                const activeCustomModel = (appSettings.customModels || []).find((cm: any) => cm.name === fallbackTextModel);
                const customModelSupportsImage = activeCustomModel?.supportsImage === true;
                const providerSupportsVision = providerImageModels.length > 0;

                if (customModelSupportsImage || providerSupportsVision) {
                    // Custom model with IMAGE toggle ON — send raw image directly using the text model
                    // Provider image model list — use the configured image model
                    targetModel = customModelSupportsImage ? fallbackTextModel : fallbackImageModel;
                    if (!customModelSupportsImage && providerImageModels.length > 0 && !providerImageModels.includes(targetModel)) {
                        outputChannel.appendLine(`[ChatCore] ⚠ Warning: Model "${targetModel}" may not support images. Image-capable models for ${configProvider}: ${providerImageModels.join(', ')}`);
                    }
                    outputChannel.appendLine(`[ChatCore] Vision enabled: model=${targetModel}, source=${customModelSupportsImage ? 'customModel.supportsImage' : 'providerImageModels'}`);
                } else {
                    // No vision support — fall back to text description
                    const descriptionContext = storedImageDescriptions.map((d, i) => `[Image ${i + 1} Description: ${d}]`).join("\n");
                    finalCurrentMessage = `${data.message}\n\n${descriptionContext}`;
                    outputChannel.appendLine(`[ChatCore] Provider "${configProvider}" has no image models listed and no custom model IMAGE toggle — using text descriptions instead.`);
                }
            } else {
                targetModel = fallbackTextModel;
            }

            // #71: Resolve custom model config (apiKey, baseUrl, apiKeyHeader)
            // Custom models store their own apiKey/baseUrl on the model object itself,
            // NOT in providerSettings. We must check customModels[] first.
            const customModel = (appSettings.customModels || []).find((cm: any) => cm.name === targetModel);

            // Resolve API key and base URL — custom model's own config takes priority
            const globalProvider = appSettings.models.provider || 'OpenAI';
            // IMPORTANT: Use the custom model's own provider for routing (Gemini vs OpenAI-compat)
            // The global provider setting may differ from the custom model's provider
            const activeProvider = customModel?.provider || globalProvider;
            const providerConfig = appSettings.models.providerSettings?.[activeProvider] || appSettings.models.providerSettings?.[globalProvider];

            let apiKey = customModel?.apiKey || providerConfig?.apiKey || appSettings.models.apiKey || '';

            // AGGRESSIVE FALLBACK: If the API key is still missing, search for ANY custom model 
            // or provider config that belongs to the same provider and has an API key.
            // This fixes the issue where a user enters their key for "gemini-3.1-flash" but 
            // switching to "gemini-3.1-pro" creates a new model entry with an empty key.
            if (!apiKey) {
                const sameProviderModels = (appSettings.customModels || []).filter((cm: any) => cm.provider === activeProvider && cm.apiKey);
                if (sameProviderModels.length > 0) {
                    apiKey = sameProviderModels[0].apiKey;
                } else if (appSettings.models.providerSettings) {
                    // Try to find ANY provider that might be the same (e.g. 'Google' vs 'Gemini' aliases)
                    for (const key of Object.keys(appSettings.models.providerSettings)) {
                        if (key.toLowerCase().includes(activeProvider.toLowerCase()) || activeProvider.toLowerCase().includes(key.toLowerCase())) {
                            if (appSettings.models.providerSettings[key].apiKey) {
                                apiKey = appSettings.models.providerSettings[key].apiKey;
                                break;
                            }
                        }
                    }
                }

                // ULTIMATE FALLBACK: Check VS Code global configuration directly as a last resort
                if (!apiKey) {
                    const config = vscode.workspace.getConfiguration('kdaina');
                    const configToken = config.get<string>('accessToken');
                    if (configToken && configToken.trim() !== '') {
                        apiKey = configToken;
                    }
                }
            }

            const apiBaseUrl = customModel?.baseUrl || providerConfig?.baseUrl || '';
            const apiKeyHeader = customModel?.apiKeyHeader || '';
            const azureStyle = customModel?.azureStyle === true;

            outputChannel.appendLine(`[ChatCore] Provider=${activeProvider}, model=${targetModel}, hasApiKey=${!!apiKey}, keyLen=${apiKey.length}, baseUrl=${apiBaseUrl || '(default)'}${apiKeyHeader ? `, apiKeyHeader=${apiKeyHeader}` : ''}${azureStyle ? ', azureStyle=true' : ''}${customModel ? `, source=customModel(${customModel.provider})` : ''}`);
            outputChannel.appendLine(`[ChatCore] Key trace: customModel.apiKey=${customModel?.apiKey ? customModel.apiKey.length + 'chars' : '(empty)'}, providerConfig[${activeProvider}].apiKey=${providerConfig?.apiKey ? providerConfig.apiKey.length + 'chars' : '(empty)'}, models.apiKey=${appSettings.models.apiKey ? appSettings.models.apiKey.length + 'chars' : '(empty)'}`);


            // ─── DETERMINE MODE: AGENTIC vs STANDARD ────────────────────────
            const isAgenticMode = this.isAgenticAgent(data.agentId, appSettings);

            const trackingOnAgentStep = (step: any) => {
                // Coalesce thinking chunks to prevent history bloat and UI hangs
                if (step.type === 'thinking') {
                    const lastStep = collectedAgentSteps[collectedAgentSteps.length - 1];
                    if (lastStep && lastStep.type === 'thinking') {
                        // Append text to the existing thinking step for history storage
                        lastStep.text = (lastStep.text || '') + (step.text || '');
                    } else {
                        // Create a new thinking step
                        collectedAgentSteps.push({ ...step });
                    }
                } else {
                    collectedAgentSteps.push(step);
                }

                // Still fire the event for real-time streaming to the UI
                if (onAgentStep) {
                    onAgentStep(step);
                }
            };

            if (isAgenticMode) {
                const response = await this.processAgenticRequest(
                    data, finalContextMessages, finalCurrentMessage,
                    targetModel, apiKey, temperature, apiBaseUrl,
                    appSettings, onChunk, trackingOnAgentStep, abortController.signal,
                    apiKeyHeader,
                    (usage) => { totalUsage = usage; },
                    azureStyle
                );
                aiResponseText = response.text;
                if (!totalUsage) { totalUsage = response.usage; }
                if (response.hitStepLimit) {
                    hitStepLimit = true;
                    continuationMaxSteps = response.maxSteps || 0;
                }
            } else {
                const response = await this.processStandardRequest(
                    data, finalContextMessages, finalCurrentMessage,
                    targetModel, apiKey, temperature, apiBaseUrl,
                    appSettings, onChunk, abortController.signal,
                    apiKeyHeader,
                    (usage) => { totalUsage = usage; },
                    azureStyle
                );
                aiResponseText = response.text;
                if (!totalUsage) { totalUsage = response.usage; }
            }

            // --- STEP E: SAVE AI RESPONSE ---
            await this.historyService.addMessage(data.chat_id, ROLE.BOT, aiResponseText, [], [], data.agentId, collectedAgentSteps);
            outputChannel.appendLine("Chat interaction saved and processed.");

        } catch (error: any) {
            if (abortController.signal.aborted) {
                const isTimeout = (abortController.signal as any)._isTimeout;
                const msg = isTimeout ? '⚠️ *Agent timed out waiting for API response.*' : '*Agent stopped.*';

                outputChannel.appendLine(`[ChatCore] Request explicitly aborted by user for chatId=${data.chat_id}`);
                aiResponseText = msg;
                if (onChunk) { await onChunk(`\n\n${msg}`); }
                // Usage is still returned via the result — tokens were consumed
                outputChannel.appendLine(`[ChatCore] Usage on abort: ${totalUsage ? JSON.stringify(totalUsage) : 'none captured'}`);
            } else {
                console.error('Error fetching chat response:', error);

                let extractedErrorMsg = 'Unknown error';
                if (error instanceof Error) {
                    extractedErrorMsg = error.message;
                } else if (error && typeof error === 'object') {
                    extractedErrorMsg = error.message || error.error?.message || error.details || JSON.stringify(error);
                } else if (typeof error === 'string') {
                    extractedErrorMsg = error;
                }

                outputChannel.appendLine('[ChatCore] Error: ' + extractedErrorMsg);

                // Render error as a regular chat message (not inside thinking block)
                aiResponseText = `⚠️ **Error:** ${extractedErrorMsg}`;
                if (onChunk) {
                    await onChunk(aiResponseText);
                }
            }
            await this.historyService.addMessage(data.chat_id, ROLE.BOT, aiResponseText, [], [], data.agentId, collectedAgentSteps);
        } finally {
            ChatCoreService.activeAbortControllers.delete(data.chat_id);
        }

        return { text: aiResponseText, usage: totalUsage, hitStepLimit, continuationMaxSteps };
    }

    /**
     * Determine if the selected agent profile is agentic mode.
     * Agents with names containing "architect" or "planner" or the explicit agentId !== 'default'
     * are treated as agentic when tools are available.
     */
    private isAgenticAgent(agentId: string | undefined, settings: any): boolean {
        if (!agentId || agentId === 'default') { return false; }

        const agent = settings.prompts.find((p: any) => p.id === agentId);
        if (!agent) { return false; }

        // All non-default agents run in agentic mode
        return true;
    }

    /**
     * Standard sequential prompt pipeline (existing behavior).
     */
    private async processStandardRequest(
        data: any, contextMessages: any[], currentMessage: any,
        model: string, apiKey: string, temperature: number, baseUrl: string,
        settings: any, onChunk?: (text: string) => void, abortSignal?: AbortSignal,
        apiKeyHeader?: string, onUsageUpdate?: (usage: any) => void, azureStyle?: boolean
    ): Promise<{ text: string, usage?: any }> {

        // #64: Default Chat uses ONLY the global system prompt — no extra system info
        // System info is only needed for agentic mode (tool execution context)
        const baseSystemPrompt = settings.general?.systemPrompt || "You are an expert AI assistant.";
        const suggestionsEnabled = settings.general?.enableSuggestions !== false;
        const systemPrompt = suggestionsEnabled
            ? `${baseSystemPrompt}\n\nAt the very end of your response, suggest exactly 3 short, context-specific follow-up questions or next steps for the user. Output them in this format: <suggestions>["Question 1", "Question 2", "Question 3"]</suggestions>.`
            : baseSystemPrompt;
        const steps = [{ content: systemPrompt }];

        let pipelineContext = currentMessage;
        let aiResponseText = "";
        let totalUsage: any = null;
        const isO1 = model.startsWith('o1');
        const requestTemperature = isO1 ? 1 : temperature;

        // Resolve the active provider for routing
        const activeProvider = settings.models?.provider || 'OpenAI';

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const isLastStep = i === steps.length - 1;

            const apiPayload = [
                { role: 'system', content: (step as any).content || step },
                ...this.compactMessages(contextMessages, 'full'),
                { role: 'user', content: pipelineContext }
            ];

            if (isLastStep && onChunk) {
                const result = await aiStreamRequest(
                    apiPayload, model, apiKey, requestTemperature, activeProvider, baseUrl, abortSignal, apiKeyHeader,
                    (event: any) => {
                        const usage = event.usage || event.totalUsage;
                        totalUsage = usage;
                        if (onUsageUpdate) { onUsageUpdate(usage); }
                    },
                    azureStyle
                );
                let fullText = '';
                for await (const chunk of result.fullStream) {
                    if (abortSignal && abortSignal.aborted) {
                        throw new Error('AbortError');
                    }
                    if (chunk.type === 'text-delta') {
                        fullText += chunk.text;
                        onChunk(chunk.text);
                    } else if (chunk.type === 'error') {
                        throw chunk.error;
                    }
                }
                const usage = await result.usage;
                pipelineContext = fullText;
                aiResponseText = fullText;
                totalUsage = usage;
            } else {
                const response = await aiRequest(
                    apiPayload, model, apiKey, requestTemperature, activeProvider, baseUrl, apiKeyHeader, azureStyle
                );
                pipelineContext = response.content;
                aiResponseText = response.content;
            }
        }

        return { text: aiResponseText, usage: totalUsage };
    }

    /**
     * 🔥 AGENTIC pipeline — the AI autonomously calls tools in a loop.
     */
    private async processAgenticRequest(
        data: any, contextMessages: any[], currentMessage: any,
        model: string, apiKey: string, temperature: number, baseUrl: string,
        settings: any, onChunk?: (text: string) => void,
        onAgentStep?: (step: AgentStepEvent) => void,
        abortSignal?: AbortSignal,
        apiKeyHeader?: string,
        onUsageUpdate?: (usage: any) => void,
        azureStyle?: boolean
    ): Promise<{ text: string, usage?: any, hitStepLimit?: boolean, maxSteps?: number }> {
        // Note: We do NOT call ReviewManager.startTurn() here.
        // Pending edits are global and persist until the user accepts/reverts them.

        // Resolve the agent's system prompt
        const agent = (settings.prompts || []).find((p: any) => p.id === data.agentId);
        const systemPrompt = agent?.content || settings.general?.systemPrompt || "You are an expert AI assistant.";

        outputChannel.appendLine(`[Agentic] Agent=${data.agentId}, model=${model}, agentName=${agent?.name}`);

        // ─── ARTIFACT MANIFEST (lightweight) ────────────────────────────
        // Instead of injecting full artifact content, we inject only a
        // manifest (names + sizes). The model uses `read_artifact` to
        // pull specific content on-demand — dramatically more token-efficient.
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
        let artifactsContext = '';
        if (workspaceRoot !== 'unknown') {
            const fs = require('fs');
            const path = require('path');
            const manifest: string[] = [];

            const scanDir = (dirPath: string, scope: string) => {
                if (fs.existsSync(dirPath)) {
                    try {
                        const files = fs.readdirSync(dirPath);
                        for (const file of files) {
                            if (file.endsWith('.md')) {
                                const stat = fs.statSync(path.join(dirPath, file));
                                const sizeKb = (stat.size / 1024).toFixed(1);
                                manifest.push(`  - [${scope}] ${file} (${sizeKb} KB)`);
                            }
                        }
                    } catch (e) {
                        outputChannel.appendLine(`[Agentic] Failed to scan artifacts in ${dirPath}: ${e}`);
                    }
                }
            };

            const baseDir = path.join(workspaceRoot, '.kdaina', 'artifacts');
            scanDir(path.join(baseDir, 'global'), 'global');
            scanDir(path.join(baseDir, 'sessions', data.chat_id), 'session');

            if (manifest.length > 0) {
                artifactsContext = `\n--- AVAILABLE ARTIFACTS ---\nYou have ${manifest.length} artifact(s) available. Use the \`read_artifact\` tool to load any you need for the current task.\n${manifest.join('\n')}\n`;
            }
        }

        // Build the workspace-aware system prompt with system info (#52)
        const systemInfo = getSystemInfo();

        // #50: Task tracking — handled via update_task_progress tool
        const todoInstruction = `\n\nTASK TRACKING:
When handling complex multi-step requests, call update_task_progress after each major step to report your progress.
This shows a live checklist in the chat so the user can track what's done and what's remaining.`;

        // Optimize: Check if request is simple (greetings, general chat, simple command runs)
        // to skip injecting file tree, editor context, and verbose system instructions.
        const isSimple = typeof currentMessage === 'string' && currentMessage.length < 120 && 
            !/(write|create|edit|change|fix|implement|add|refactor|delete|remove|search|find|replace|code|file|folder|directory|path|class|function|method|struct|enum|error|bug|compile|lint|preview|test|debug|update|rename|check|review|show|import|export|component|module|config|setup|migrate|deploy|install|readme|style|css|html|type|interface|schema|database|api|route|endpoint|model|view|template|hook|state|prop|variable|commit|push|pull|merge|branch|diff|log|package|version|dependency)/i.test(currentMessage);

        let truncatedTree = '';
        let editorSection = '';
        if (isSimple) {
            outputChannel.appendLine(`[Agentic] Detected simple request. Omit fileTree and editorSection from initial prompt to save tokens.`);
            truncatedTree = '(Omitted for simple request to save tokens. Use list_workspace if needed)';
            editorSection = '';
        } else {
            // #51: Include workspace file tree in context (compact mode to save tokens)
            await this.workspaceIndex.refresh();
            const fileTree = this.workspaceIndex.getCompactTreeString();
            // Cap the tree to avoid blowing up the context window
            const maxTreeChars = 4000;
            truncatedTree = fileTree.length > maxTreeChars
                ? fileTree.substring(0, maxTreeChars) + '\n... (truncated, use list_workspace for full tree)'
                : fileTree;

            // #55: Auto-inject active editor context so the agent doesn't waste tool calls
            const activeEditorCtx = await this.workspaceIndex.getActiveEditorContext();
            editorSection = activeEditorCtx
                ? `\n--- ACTIVE EDITOR FILES ---\nThese files are currently open in the user's editor. You already have their skeletons and cursor positions. Do NOT re-read them with read_file_skeleton unless you need fresh data after an edit.\n${activeEditorCtx}\n`
                : '';
        }

        const suggestionsEnabled = settings.general?.enableSuggestions !== false;
        const suggestionsInstruction = suggestionsEnabled
            ? `\n- At the very end of your final response (only after all tool calls are completed and you are presenting the final response to the user), suggest exactly 3 short, actionable follow-up questions or next steps. Format them exactly like this at the end: <suggestions>["Question 1", "Question 2", "Question 3"]</suggestions>. Do not include suggestions during intermediate steps or plans.`
            : '';

        // Optimize: Enable browser tools for all complex requests. Omit only for simple requests.
        const needsBrowser = !isSimple;

        const browserSection = needsBrowser ? `

BROWSER TOOLS (for web testing & visual QA):
- browser_open: Navigate to a URL in a real browser
- browser_snapshot: Get the accessibility tree with refs (@e1, @e2) — this is your "eyes"
- browser_action: Interact with elements (click, fill, type, select, hover, scroll, press)
- browser_get: Extract text, HTML, values, page title, URL from the page
- browser_evaluate: Run JavaScript in the page context
- browser_close: Close the browser when done
BROWSER WORKFLOW: open → snapshot → action → snapshot → verify → close
ALWAYS snapshot before interacting. Use refs (@eN) from the LATEST snapshot only.
For forms: use fill (clears input first), not type (appends). Re-snapshot after actions.` : '';

        const agenticSystemPrompt = `${systemPrompt}

${systemInfo}
${artifactsContext}
--- WORKSPACE FILE TREE ---
${truncatedTree}
${editorSection}
--- AGENT CONTEXT ---
You have access to tools to read, search, and modify files in the user's workspace.
Workspace root: ${workspaceRoot}

PRIORITY: ALWAYS USE TOOLS. Your primary output mechanism is tool calls, not text.
Respond with tool calls immediately — do not narrate, explain, or describe what you will do.

STEP EFFICIENCY (each step = 1 API round-trip, budget is limited):
- BATCH parallel tool calls: if you need to read 3 files, call all 3 in ONE step — not 3 separate steps.
- For simple requests (typo fix, quick question), skip plan_task and act directly.
- Only call plan_task for complex, multi-file tasks.
- Skip tool calls for files you already have context for (active editor files above).
- The active editor skeleton is already provided — do NOT re-read it with read_file_skeleton.
- NEVER read an entire large file. Use skeleton first, then line ranges.

WORKFLOW:
1. For complex tasks: call plan_task FIRST, then execute immediately with tool calls
2. Use list_workspace or find_symbol to understand the project structure
3. Use read_file_skeleton to get an overview of relevant files
4. Use read_line_range to examine specific sections you need
5. Use chunk_replace to make surgical edits (provide exact target text)
6. Use search_workspace to find patterns across the codebase
7. Use get_workspace_problems to verify your changes (pass filePath for specific files)
8. Use run_command for builds, tests, git operations
9. Use web_search to look up documentation, APIs, or current information online
10. Call verify_completion at the END to confirm all items were addressed
11. If you are running out of steps, call update_task_progress immediately to save your progress before the limit is reached. This ensures the user can say "continue" to resume.

STEP BUDGET AWARENESS:
- You have a LIMITED number of tool-call steps per request.
- When you sense you've used many steps and still have work remaining, call update_task_progress to checkpoint.
- ALWAYS call update_task_progress before attempting the final complex actions if you've already used 30+ steps.

CRITICAL RULES:
- You are an AUTONOMOUS AGENT. ALWAYS prefer tool calls over text responses.
- DO NOT EXPLAIN OR NARRATE YOUR ACTIONS. Do not say "I will now do X". Just act using tools.
- DO NOT ASK UNNECESSARY QUESTIONS. Make reasonable assumptions and proceed autonomously unless blocked by a critical ambiguity.
- NEVER use run_command for file viewing, searching, or editing (e.g. do not use 'cat', 'ls', 'grep', 'sed'). ALWAYS use the dedicated built-in tools (search_workspace, read_file_skeleton, chunk_replace) first.
- NEVER output code blocks in chat. Use create_file or chunk_replace to write code DIRECTLY.
- NEVER give step-by-step instructions. YOU execute the steps yourself using tools.
- When editing, provide the EXACT target text to replace (including whitespace).
- Always verify your changes compile and don't introduce workspace problems after editing.
- Edits are applied DIRECTLY to the file. The user can review changes inline.
- Use web_search proactively for external libraries or APIs. Don't guess — search first.
- When multiple independent tool calls can be made, call them ALL AT ONCE in a single step.${todoInstruction}${suggestionsInstruction}${browserSection}

CONTEXT PRIORITY:
- The LAST user message is your CURRENT TASK. Focus all effort on it.
- Earlier messages in this conversation are BACKGROUND CONTEXT ONLY — they show what was discussed before.
- Do NOT re-execute, re-explain, or revisit completed tasks from earlier messages unless the user explicitly asks.
- Treat prior assistant responses as already-delivered work. Your job is the NEW request.`;


        // Resolve and inject rules (global + agent-linked)
        const allRules: { name: string; content: string }[] = [];
        const seenRuleIds = new Set<string>();

        // 1. Global rules (scope === 'global')
        for (const rule of (settings.rules || [])) {
            if (rule.scope === 'global' && rule.content && !seenRuleIds.has(rule.id)) {
                allRules.push(rule);
                seenRuleIds.add(rule.id);
            }
        }

        // 2. Agent-linked rules
        if (agent?.linkedRules) {
            for (const ruleId of agent.linkedRules) {
                if (!seenRuleIds.has(ruleId)) {
                    const rule = (settings.rules || []).find((r: any) => r.id === ruleId);
                    if (rule?.content) {
                        allRules.push(rule);
                        seenRuleIds.add(ruleId);
                    }
                }
            }
        }

        const rulesSection = allRules.length > 0
            ? `\n\n--- APPLIED RULES ---\n${allRules.map(r => `[${r.name}]: ${r.content}`).join('\n')}\n`
            : '';

        const finalSystemPrompt = agenticSystemPrompt + rulesSection;

        const contextMode = settings.general?.contextMode || 'compact';

        // Build payload
        const messages = [
            { role: 'system' as const, content: finalSystemPrompt },
            ...this.compactMessages(contextMessages, contextMode),
            { role: 'user' as const, content: currentMessage }
        ];

        // Resolve the active provider for routing
        const globalProvider = settings.models?.provider || 'OpenAI';
        const activeModelEntry = (settings.customModels || []).find((m: any) => m.name === model);
        const activeProvider = activeModelEntry?.provider || globalProvider;
        outputChannel.appendLine(`[Agentic] Provider: ${activeProvider} (global=${globalProvider}, custom=${activeModelEntry?.provider || 'n/a'})`);

        // Resolve model tier for adaptive behavior
        let modelTier = getModelTier(activeProvider, model);

        // Override tier from custom model settings if set
        if (settings.customModels) {
            const customModel = settings.customModels.find((m: any) => m.name === model);
            if (customModel?.tier) {
                modelTier = customModel.tier;
            }
        }
        outputChannel.appendLine(`[Agentic] Model tier: ${modelTier} (${activeProvider}/${model})`);

        // Shared mutable step counter — tool-registry reads this to inject budget info into tool results
        const stepBudget = { current: 0, max: 0 }; // max is set after we compute maxSteps

        // needsBrowser is computed above alongside the system prompt

        // Apply alwaysProceed override — if enabled, skip all confirmation dialogs
        const alwaysProceed = settings.permissions?.alwaysProceed === true;
        const tools = createToolRegistry(this.workspaceIndex, {
            chatId: data.chat_id,
            abortSignal: abortSignal,
            tier: modelTier,
            stepBudget: stepBudget,
            readFilesConfirmation: alwaysProceed ? false : (settings.permissions?.readFilesConfirmation ?? false),
            writeFilesConfirmation: alwaysProceed ? false : (settings.permissions?.writeFilesConfirmation ?? true),
            commandSafetyMode: alwaysProceed ? 'none' : (settings.permissions?.commandSafetyMode ?? 'smart'),
            enableBrowserTools: needsBrowser,
            onApprovalRequest: async (toolCallId, toolName, args, opts) => {
                if (abortSignal?.aborted) {
                    return;
                }
                if (onAgentStep) {
                    onAgentStep({
                        type: 'tool_call' as any,
                        toolName,
                        args,
                        approvalRequired: true,
                        diffReviewRequired: opts.diffReviewRequired,
                        toolCallId
                    } as any);

                    // --- LIVE EDIT: Trigger inline review immediately ---
                    if (opts.diffReviewRequired) {
                        try {
                            await handleInlineReview(toolCallId, toolName, args);
                        } catch (e) {
                            outputChannel.appendLine(`[Agentic] Failed to trigger Live Edit: ${e}`);
                        }
                    }
                }
            }
        });

        outputChannel.appendLine(`[Agentic] Tool names: ${Object.keys(tools).join(', ')}`);
        outputChannel.appendLine(`[Agentic] Messages count: ${messages.length}`);

        // Per-agent temperature: each agent profile carries its own temperature.
        // Falls back to 0.15 (precise coding default) for agents without a setting.
        const agentTemp = agent?.temperature ?? 0.15;
        outputChannel.appendLine(`[Agentic] Temperature: ${agentTemp} (from agent profile${agent?.temperature !== undefined ? '' : ', default'})`);


        let stepCount = 0;
        let streamedReasoning = false;
        let lastStepHadToolCalls = false;

        // Check if model supports reasoning
        let supportsReasoning = false;
        try {
            const providers = require('../../models.json');
            if (providers[activeProvider]?.supportsReasoning?.includes(model)) {
                supportsReasoning = true;
            }
        } catch (e) {
            outputChannel.appendLine(`[Agentic] Error reading models.json: ${e}`);
        }

        // Check custom models
        if (!supportsReasoning && settings.customModels) {
            const customModel = settings.customModels.find((m: any) => m.name === model);
            if (customModel && customModel.supportsReasoning) {
                supportsReasoning = true;
            }
        }

        // Auto-detect reasoning for known model families (fallback for older custom model entries)
        if (!supportsReasoning) {
            const lowerModel = model.toLowerCase();
            if (lowerModel.includes('gemini') || lowerModel.includes('gpt-5') || lowerModel.includes('o1') || lowerModel.includes('o3') || lowerModel.includes('claude') || lowerModel.includes('sonnet') || lowerModel.includes('opus')) {
                supportsReasoning = true;
                outputChannel.appendLine(`[Agentic] Auto-detected reasoning support for model: ${model}`);
            }
        }
        // Aggressive mode increases maxSteps for persistent task completion (capped at 60)
        const isAggressive = settings.general?.aggressiveAgentic === true;
        const baseSteps = modelTier === 'small' ? 30 : modelTier === 'mid' ? 40 : 45;
        // +2 grace steps: ensures the model can finish its text response after
        // verify_completion without getting cut off mid-sentence
        // Cap at 60: beyond this the agent tends to spin in retry loops rather than making progress
        const maxSteps = Math.min((isAggressive ? baseSteps * 2 : baseSteps) + 2, 60);
        stepBudget.max = maxSteps; // populate the shared counter
        outputChannel.appendLine(`[Agentic] maxSteps=${maxSteps}${isAggressive ? ' (aggressive)' : ''}`);

        let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
        try {
            const result = await aiAgenticRequest(
                messages, model, apiKey, agentTemp, activeProvider, tools,
                {
                    maxSteps: maxSteps,
                    baseUrl: baseUrl,
                    abortSignal: abortSignal,
                    enableThinking: supportsReasoning,
                    apiKeyHeader: apiKeyHeader,
                    azureStyle: azureStyle,
                    modelTier: modelTier,
                    onFinish: (event: any) => {
                        const usage = event.usage || event.totalUsage;
                        if (onUsageUpdate && usage) { onUsageUpdate(usage); }
                    },
                    // #44: Real-time reasoning streaming (for models like Gemini/DeepSeek)
                    onReasoningChunk: (text: string) => {
                        streamedReasoning = true;
                        if (onAgentStep && text) {
                            onAgentStep({ type: 'thinking', text });
                        }
                    },
                    onStepFinish: (event: any) => {
                        if (abortSignal?.aborted) {
                            return;
                        }
                        stepCount++;
                        stepBudget.current = stepCount; // sync shared counter for tool-registry
                        lastStepHadToolCalls = !!(event.toolCalls && event.toolCalls.length > 0);
                        const remaining = maxSteps - stepCount;
                        outputChannel.appendLine(`[Agentic] Step ${stepCount}/${maxSteps} finished (toolCalls: ${lastStepHadToolCalls}, remaining: ${remaining})`);

                        // Diagnostic: check for Gemini thinking text in step event
                        if (event.reasoningText) {
                            outputChannel.appendLine(`[Agentic] StepFinish.reasoningText: ${event.reasoningText.substring(0, 200)}`);
                        }
                        if (event.reasoning && Array.isArray(event.reasoning) && event.reasoning.length > 0) {
                            outputChannel.appendLine(`[Agentic] StepFinish.reasoning[0]: type=${event.reasoning[0]?.type}, text=${(event.reasoning[0]?.text || '').substring(0, 200)}`);
                            // Stream any non-streamed reasoning to UI live
                            if (!streamedReasoning && onAgentStep) {
                                for (const r of event.reasoning) {
                                    if (r.text) {
                                        onAgentStep({ type: 'thinking', text: r.text });
                                    }
                                }
                            }
                        }

                        // Note: The UI handles the "waiting" indicator between steps
                        // via a frontend timer — no need for a backend heartbeat here.

                        // Accumulate usage per step so tokens are counted even on abort
                        if (event.usage) {
                            if (onUsageUpdate) { onUsageUpdate(event.usage); }
                        }

                        // Stream tool activity to frontend
                        // NOTE: tool_call is emitted from the streaming 'tool-call' part (below),
                        // which fires BEFORE execution starts (present tense: "Reading File").
                        // We only emit tool_result here (past tense: "Read File") since the step is done.

                        if (onAgentStep && event.toolResults && event.toolResults.length > 0) {
                            for (const tr of event.toolResults) {
                                const rawResult = tr.result !== undefined ? tr.result : (tr as any).output;
                                const summarized = this.summarizeToolResult(rawResult);

                                // #CRITICAL: Ensure command is saved in result for history load
                                if (tr.toolName === 'run_command' && tr.args?.command) {
                                    summarized._commandExecuted = tr.args.command;
                                }

                                onAgentStep({
                                    type: 'tool_result',
                                    toolName: tr.toolName,
                                    result: summarized,
                                    toolCallId: tr.toolCallId // CRITICAL FIX
                                });

                                // Test → Fix cycle: surface retry status in the UI
                                const resultForCycle = tr.result !== undefined ? tr.result : (tr as any).output;
                                if (tr.toolName === 'run_command' && resultForCycle?._testCycle) {
                                    const cycle = resultForCycle._testCycle;
                                    if (cycle.status === 'failed') {
                                        onAgentStep({
                                            type: 'thinking',
                                            text: `⚠ Test/build failed (attempt ${cycle.attempt}/${cycle.maxRetries}). ${cycle.retriesRemaining} retries remaining — fixing and re-running...`
                                        });
                                    } else if (cycle.status === 'exhausted') {
                                        onAgentStep({
                                            type: 'thinking',
                                            text: `🛑 Test/build failed ${cycle.attempts} times. Retry budget exhausted — reporting to user.`
                                        });
                                    } else if (cycle.status === 'passed' && cycle.attemptsBeforeSuccess > 1) {
                                        onAgentStep({
                                            type: 'thinking',
                                            text: `✅ Test/build passed after ${cycle.attemptsBeforeSuccess} attempts. Self-correction succeeded.`
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            );

            // Consume the full stream to get ALL events (text + tools + errors)
            let fullText = '';
            let isThinking = false;
            let _lastTextDelta = ''; // Dedup guard for corporate gateway double-sends
            let _thinkingBuffer = ''; // Buffer to detect partial <thinking> / </thinking> tags
            let _insideThinkingBlock = false; // Track if we're inside <thinking>...</thinking>

            // Inactivity timeout: if no stream event arrives for 300s, prompt user
            // Reasoning models (Kimi-K2.6, DeepSeek R1) can think for 2-5min without sending events
            const INACTIVITY_TIMEOUT_MS = 300_000;
            // Reset timer reference (declared above try for catch-block access)
            const resetInactivityTimer = () => {
                if (inactivityTimer) { clearTimeout(inactivityTimer); }
                inactivityTimer = setTimeout(async () => {
                    outputChannel.appendLine(`[Agentic] ⚠ Inactivity: no stream event for ${INACTIVITY_TIMEOUT_MS / 1000}s — prompting user`);
                    const choice = await vscode.window.showWarningMessage(
                        `No response from the AI model for ${INACTIVITY_TIMEOUT_MS / 1000 / 60} minutes. The model may still be thinking.`,
                        { modal: false },
                        'Continue Waiting',
                        'Abort'
                    );
                    if (choice === 'Continue Waiting') {
                        outputChannel.appendLine(`[Agentic] User chose to continue waiting — resetting timer`);
                        resetInactivityTimer(); // Extend by another cycle
                    } else {
                        outputChannel.appendLine(`[Agentic] User chose to abort (or dismissed prompt)`);
                        const ctrl = ChatCoreService.activeAbortControllers.get(data.chat_id);
                        if (ctrl) {
                            (ctrl.signal as any)._isTimeout = true;
                            ctrl.abort();
                        }
                    }
                }, INACTIVITY_TIMEOUT_MS);
            };
            resetInactivityTimer(); // Start the clock

            for await (const part of result.fullStream) {
                resetInactivityTimer(); // Reset on every event

                if (abortSignal && abortSignal.aborted) {
                    throw new Error('AbortError');
                }

                const partType = (part as any).type;
                // Diagnostic: log significant part types (skip high-frequency noise)
                const noisyTypes = ['text-delta', 'raw', 'tool-call-delta', 'tool-call-streaming-start', 'tool-input-delta'];
                if (!noisyTypes.includes(partType)) {
                    outputChannel.appendLine(`[Agentic] Stream part: type=${partType}`);
                }

                switch (partType) {
                    // ─── Text streaming with <thinking> tag parsing ──────
                    case 'text-delta':
                        let deltaText = (part as any).text;
                        // Dedup guard: corporate gateways can send duplicate SSE events
                        if (deltaText && deltaText === _lastTextDelta && deltaText.length > 2) {
                            break;
                        }
                        _lastTextDelta = deltaText;

                        // Strip spurious 'None' that proxies inject at reasoning transitions
                        if (deltaText && deltaText.trim() === 'None') {
                            break;
                        }

                        // Accumulate into buffer for tag detection
                        _thinkingBuffer += deltaText;

                        // Process complete tags in the buffer
                        while (_thinkingBuffer.length > 0) {
                            if (_insideThinkingBlock) {
                                // Inside <thinking>: look for closing tag
                                const closeIdx = _thinkingBuffer.indexOf('</thinking>');
                                if (closeIdx !== -1) {
                                    // Send everything before </thinking> as thinking text
                                    const thinkingText = _thinkingBuffer.substring(0, closeIdx);
                                    if (thinkingText && onAgentStep) {
                                        onAgentStep({ type: 'thinking', text: thinkingText });
                                    }
                                    _thinkingBuffer = _thinkingBuffer.substring(closeIdx + '</thinking>'.length);
                                    _insideThinkingBlock = false;
                                    isThinking = false;
                                } else if (_thinkingBuffer.length > 200) {
                                    // Flush partial thinking text (keep last 20 chars for partial tag)
                                    const flushLen = _thinkingBuffer.length - 20;
                                    const thinkingText = _thinkingBuffer.substring(0, flushLen);
                                    if (thinkingText && onAgentStep) {
                                        onAgentStep({ type: 'thinking', text: thinkingText });
                                    }
                                    _thinkingBuffer = _thinkingBuffer.substring(flushLen);
                                } else {
                                    // Wait for more data to check for closing tag
                                    break;
                                }
                            } else {
                                // Outside <thinking>: look for opening tag
                                const openIdx = _thinkingBuffer.indexOf('<thinking>');
                                if (openIdx !== -1) {
                                    // Send everything before <thinking> as normal text
                                    const normalText = _thinkingBuffer.substring(0, openIdx);
                                    if (normalText) {
                                        fullText += normalText;
                                        if (onChunk) { onChunk(normalText); }
                                    }
                                    _thinkingBuffer = _thinkingBuffer.substring(openIdx + '<thinking>'.length);
                                    _insideThinkingBlock = true;
                                    isThinking = true;
                                    // Signal thinking start
                                    if (onAgentStep) {
                                        onAgentStep({ type: 'thinking', text: '' });
                                    }
                                } else if (_thinkingBuffer.length > 20) {
                                    // Flush normal text (keep last 15 chars for partial '<thinking>' tag)
                                    const flushLen = _thinkingBuffer.length - 15;
                                    const normalText = _thinkingBuffer.substring(0, flushLen);
                                    fullText += normalText;
                                    if (onChunk) { onChunk(normalText); }
                                    _thinkingBuffer = _thinkingBuffer.substring(flushLen);
                                } else {
                                    // Wait for more data
                                    break;
                                }
                            }
                        }
                        break;
                    case 'text-start':
                    case 'text-end':
                        break; // bookkeeping, no action needed

                    // ─── Reasoning / Thinking (#44) ──────────────────
                    case 'reasoning-start':
                        // Model started thinking — show indicator in UI
                        isThinking = true;
                        outputChannel.appendLine(`[Agentic] >>> REASONING-START received`);
                        if (onAgentStep) {
                            onAgentStep({ type: 'thinking', text: '' }); // empty text = "start block"
                        }
                        break;

                    case 'reasoning-delta':
                        // Forward the thinking text to the UI
                        const delta = (part as any).textDelta;
                        if (delta && onAgentStep) {
                            onAgentStep({ type: 'thinking', text: delta });
                        }
                        break;

                    case 'reasoning-end':
                        isThinking = false;
                        outputChannel.appendLine(`[Agentic] >>> REASONING-END received`);
                        break;

                    // ─── Tool streaming ──────────────────────────────
                    case 'tool-call-streaming-start': {
                        const tcToolName = (part as any).toolName;
                        const tcId = (part as any).toolCallId || `stream-${Date.now()}-${tcToolName}`;
                        outputChannel.appendLine(`[Agentic] Tool call streaming start: ${tcToolName} (id=${tcId})`);
                        // Emit EARLY so the UI shows the tool card ("Reading Lines") immediately while arguments stream
                        if (onAgentStep) {
                            onAgentStep({
                                type: 'tool_call',
                                toolName: tcToolName,
                                toolCallId: tcId,
                                args: {} // No args parsed yet
                            });
                        }
                        break;
                    }
                    case 'tool-call': {
                        const tcToolName = (part as any).toolName;
                        const tcId = (part as any).toolCallId || `stream-${Date.now()}-${tcToolName}`;
                        outputChannel.appendLine(`[Agentic] Tool call: ${tcToolName} (id=${tcId})`);
                        // Emit EARLY so the UI shows present tense ("Reading File") while executing.
                        // The finish-step handler will later emit tool_result to flip it to past tense.
                        if (onAgentStep) {
                            onAgentStep({
                                type: 'tool_call',
                                toolName: tcToolName,
                                toolCallId: tcId,
                                args: (part as any).args !== undefined ? (part as any).args : (part as any).input
                            });
                        }
                        break;
                    }
                    case 'tool-result':
                        outputChannel.appendLine(`[Agentic] Tool result received for: ${(part as any).toolName}`);
                        break;
                    case 'tool-input-start':
                    case 'tool-input-delta':
                    case 'tool-input-end':
                        break; // tool arg streaming, no UI action needed

                    // ─── Step lifecycle ──────────────────────────────
                    case 'start-step':
                    case 'start':
                        outputChannel.appendLine(`[Agentic] Step started`);
                        break;

                    case 'finish-step': {
                        const usage = (part as any).usage;
                        const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens
                            || usage?.reasoningTokens || 0;
                        outputChannel.appendLine(`[Agentic] Step finished: reason=${(part as any).finishReason}, reasoning=${reasoningTokens} tokens`);
                        // Note: reasoning text + token counts sent post-stream via result.steps
                        break;
                    }

                    case 'finish':
                        outputChannel.appendLine(`[Agentic] Stream finish: reason=${(part as any).finishReason}`);
                        break;

                    // ─── Other ───────────────────────────────────────
                    case 'error':
                        outputChannel.appendLine(`[Agentic] Stream error part: ${(part as any).error}`);
                        throw (part as any).error; // #FIX: Throw the actual API error instead of swallowing it
                    case 'source':
                    case 'raw':
                        break; // metadata, no action
                    default:
                        outputChannel.appendLine(`[Agentic] Unhandled stream part: ${(part as any).type}`);
                        break;
                }
            }

            // Flush remaining buffer content
            if (_thinkingBuffer.length > 0) {
                if (_insideThinkingBlock) {
                    // Unclosed thinking block — flush as thinking
                    if (onAgentStep) {
                        onAgentStep({ type: 'thinking', text: _thinkingBuffer });
                    }
                } else {
                    // Normal text remaining — flush to chat
                    fullText += _thinkingBuffer;
                    if (onChunk) { onChunk(_thinkingBuffer); }
                }
                _thinkingBuffer = '';
            }

            // Clean up inactivity timer
            if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }

            outputChannel.appendLine(`[Agentic] Completed in ${stepCount} steps, response length: ${fullText.length}`);

            // #44: After stream is consumed, extract reasoning from result.steps
            // This is the canonical AI SDK approach — works for ALL models.
            // result.steps is a promise that resolves after fullStream is consumed.
            if (onAgentStep) {
                try {
                    const steps = await result.steps;
                    let totalReasoningTokens = 0;
                    let allReasoningText = '';

                    for (const step of steps) {
                        // Diagnostic: log step reasoning data
                        const stepKeys = Object.keys(step).filter(k => k.includes('reason') || k.includes('think') || k.includes('thought'));
                        outputChannel.appendLine(`[Agentic] Step reasoning: reasoningText=${(step.reasoningText || '').length} chars, reasoning=${Array.isArray(step.reasoning) ? step.reasoning.length : 0} parts, usage=${JSON.stringify(step.usage)}, reasoningKeys=[${stepKeys.join(',')}]`);
                        // Deep inspect: check if reasoning is nested in experimental/provider fields
                        if ((step as any).experimental_providerMetadata) {
                            outputChannel.appendLine(`[Agentic] Step providerMetadata keys: ${JSON.stringify(Object.keys((step as any).experimental_providerMetadata))}`);
                        }
                        if ((step as any).providerMetadata) {
                            outputChannel.appendLine(`[Agentic] Step providerMetadata keys: ${JSON.stringify(Object.keys((step as any).providerMetadata))}`);
                        }
                        // Log reasoning array contents if present
                        if (step.reasoning && Array.isArray(step.reasoning) && step.reasoning.length > 0) {
                            outputChannel.appendLine(`[Agentic] Step reasoning[0] type=${(step.reasoning[0] as any).type}, text=${((step.reasoning[0] as any).text || '').substring(0, 100)}`);
                        }

                        // Count reasoning tokens
                        const stepTokens = (step.usage as any)?.outputTokenDetails?.reasoningTokens
                            || (step.usage as any)?.reasoningTokens || 0;
                        totalReasoningTokens += stepTokens;

                        // Consolidate reasoning text (like the AI SDK elements example)
                        // step.reasoning is Array<ReasoningPart> where each part has { type: 'reasoning', text: string }
                        if (step.reasoningText && step.reasoningText.trim() && step.reasoningText.trim() !== 'None') {
                            // Strip leading 'None\n' artifacts from reasoning text
                            let cleanText = step.reasoningText;
                            if (cleanText.startsWith('None\n')) {
                                cleanText = cleanText.substring(5);
                            }
                            if (cleanText.trim()) {
                                if (allReasoningText) { allReasoningText += '\n\n'; }
                                allReasoningText += cleanText;
                            }
                        } else if (step.reasoning && Array.isArray(step.reasoning) && step.reasoning.length > 0) {
                            const consolidated = step.reasoning
                                .filter((r: any) => r.text && r.text !== 'None')
                                .map((r: any) => r.text)
                                .join('\n\n');
                            if (consolidated.trim()) {
                                if (allReasoningText) { allReasoningText += '\n\n'; }
                                allReasoningText += consolidated;
                            }
                        }
                    }

                    outputChannel.appendLine(`[Agentic] Reasoning summary: ${totalReasoningTokens} tokens, text=${allReasoningText.length} chars, streamedReasoning=${streamedReasoning}`);

                    // Send consolidated reasoning to UI ONLY IF it wasn't streamed live
                    if (!streamedReasoning && allReasoningText.trim()) {
                        onAgentStep({ type: 'thinking', text: allReasoningText });
                    }
                    // Always send token count if reasoning was used
                    if (totalReasoningTokens > 0) {
                        onAgentStep({ type: 'thinking', text: `__TOKENS__${totalReasoningTokens}` });
                    }
                } catch (e) {
                    outputChannel.appendLine(`[Agentic] Failed to extract reasoning: ${e}`);
                }
            }

            // Removed the redundant "Agent completed in X steps" status message
            // because the UI already shows "Completed steps" in the agent UI group.

            // Detect if the model hit the step limit while still wanting to work
            const hitStepLimit = stepCount >= maxSteps && lastStepHadToolCalls;
            if (hitStepLimit) {
                outputChannel.appendLine(`[Agentic] Hit step limit (${stepCount}/${maxSteps}) — model still had pending tool calls`);
            }

            // If model returned empty text, provide a context-aware fallback
            if (!fullText || fullText.trim() === '') {
                if (hitStepLimit) {
                    fullText = 'Reached step limit — progress has been auto-saved. Say **"continue"** and I\'ll pick up where I left off.';
                } else if (stepCount <= 1) {
                    // Model stopped almost immediately — likely couldn't handle the request
                    fullText = 'The model was unable to complete this request. Try rephrasing or using a different model.';
                } else if (!lastStepHadToolCalls && stepCount < maxSteps) {
                    // Model stopped on its own without tool calls — it may have gotten stuck
                    fullText = 'Task completed.';
                } else {
                    fullText = 'Task completed.';
                }
                if (onChunk) { onChunk(fullText); }
            }

            const usage = await result.usage;
            return { text: fullText, usage, hitStepLimit, maxSteps };
        } catch (error: any) {
            // Clean up inactivity timer on error
            if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }

            if (abortSignal?.aborted) {
                throw error; // Let the top-level catch handle the cancellation gracefully
            }
            outputChannel.appendLine(`[Agentic] ERROR: ${error?.message || error}`);
            throw error;
        }
    }

    /**
     * Tiered Sliding Window: Manages context size to prevent unbounded growth.
     * Also deduplicates system prompts (#47) to save context tokens.
     * 
     * Tiers (counted from the END of the messages array):
     *   HOT   (last 6 non-system msgs)  → Full content, untouched
     *   WARM  (msgs 7–20)               → Truncated: assistant=600ch, user=400ch, tool=200ch
     *   COLD  (msgs 21+)                → Dropped entirely
     * 
     * COMPACT mode (recommended for agentic):
     *   - Strip ALL tool messages (the agent has tools to re-read anything)
     *   - Keep last 4 user/assistant messages (2 background + 2 active)
     *   - Truncate background messages aggressively
     *   - Inject a boundary marker between background and active
     * 
     * System messages are always kept (but deduplicated).
     */
    private compactMessages(messages: any[], mode: 'compact' | 'full' = 'compact'): any[] {

        // --- Pass 1: Deduplicate system messages ---
        const seenSystemContents = new Set<string>();
        const deduped = messages.filter((msg) => {
            if (msg.role === 'system') {
                const key = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                if (seenSystemContents.has(key)) {
                    return false;
                }
                seenSystemContents.add(key);
            }
            return true;
        });

        // ═══════════════════════════════════════════════════════════════
        // COMPACT MODE — optimized for agentic workflows
        // ═══════════════════════════════════════════════════════════════
        if (mode === 'compact') {
            // Keep only system + user + assistant messages (drop all tool messages)
            const conversational = deduped.filter(msg =>
                msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant'
            );

            // Separate system messages from conversation messages
            const systemMsgs = conversational.filter(m => m.role === 'system');
            const nonSystemMsgs = conversational.filter(m => m.role !== 'system');

            // Keep last 4 non-system messages (2 background context + 2 active)
            const ACTIVE_COUNT = 2;
            const CONTEXT_COUNT = 2;
            const totalKeep = ACTIVE_COUNT + CONTEXT_COUNT;

            const kept = nonSystemMsgs.slice(-totalKeep);

            // Truncate background messages (the older ones)
            const result: any[] = [...systemMsgs];
            for (let i = 0; i < kept.length; i++) {
                const msg = kept[i];
                const isActive = i >= kept.length - ACTIVE_COUNT;

                if (isActive) {
                    // Active messages: full content
                    result.push(msg);
                } else {
                    // Background messages: moderate truncation (preserve enough for useful context)
                    if (typeof msg.content === 'string') {
                        const limit = msg.role === 'assistant' ? 800 : 600;
                        if (msg.content.length > limit) {
                            result.push({ ...msg, content: msg.content.substring(0, limit) + '\n... [prior context — truncated]' });
                        } else {
                            result.push(msg);
                        }
                    } else {
                        result.push(msg);
                    }
                }
            }

            // Inject boundary marker between background and active
            if (kept.length > ACTIVE_COUNT) {
                const activeStartIdx = result.length - ACTIVE_COUNT;
                if (activeStartIdx > 0) {
                    result.splice(activeStartIdx, 0, {
                        role: 'user' as const,
                        content: '[CONTEXT BOUNDARY] The messages above are prior conversation context. The messages below are the CURRENT conversation. Focus on the latest request only.'
                    });
                }
            }

            const dropped = nonSystemMsgs.length - kept.length;
            if (dropped > 0) {
                outputChannel.appendLine(`[Context] Compact mode: ${messages.length} msgs → ${result.length} sent (${dropped} dropped, ${deduped.length - conversational.length} tool msgs stripped)`);
            }

            return result;
        }

        // ═══════════════════════════════════════════════════════════════
        // FULL MODE — original 3-tier sliding window
        // ═══════════════════════════════════════════════════════════════
        const HOT_COUNT = 6;
        const WARM_LIMIT = 20;

        // --- Pass 2: Assign tiers based on reverse non-system index ---
        // Count non-system messages from the end to determine tier placement
        const nonSystemIndices: number[] = [];
        for (let i = 0; i < deduped.length; i++) {
            if (deduped[i].role !== 'system') {
                nonSystemIndices.push(i);
            }
        }

        // Map each non-system message index to its reverse position (1 = newest)
        const reverseRank = new Map<number, number>();
        for (let r = 0; r < nonSystemIndices.length; r++) {
            reverseRank.set(nonSystemIndices[r], nonSystemIndices.length - r);
        }

        // --- Pass 3: Filter and compact based on tier ---
        const result = deduped
            .filter((msg, idx) => {
                // System messages always survive
                if (msg.role === 'system') { return true; }

                const rank = reverseRank.get(idx) || 999;

                // COLD tier: drop entirely
                if (rank > WARM_LIMIT) { return false; }

                return true;
            })
            .map((msg, _idx, _arr) => {
                // System messages pass through untouched
                if (msg.role === 'system') { return msg; }

                // Find this message's original index in deduped to get its rank
                const dedupedIdx = deduped.indexOf(msg);
                const rank = reverseRank.get(dedupedIdx) || 999;

                // HOT tier: full content
                if (rank <= HOT_COUNT) { return msg; }

                // WARM tier: truncate based on role
                if (msg.role === 'tool' && msg.content) {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    if (content.length > 500) {
                        return { ...msg, content: content.substring(0, 500) + '... [truncated]' };
                    }
                }

                if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 1000) {
                    return { ...msg, content: msg.content.substring(0, 1000) + '\n... [truncated for context efficiency]' };
                }

                if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.length > 400) {
                    return { ...msg, content: msg.content.substring(0, 400) + '\n... [truncated for context efficiency]' };
                }

                return msg;
            });

        // --- Pass 4: Inject context boundary marker between WARM and HOT tiers ---
        if (nonSystemIndices.length > HOT_COUNT) {
            const hotStartOrigIdx = nonSystemIndices[nonSystemIndices.length - HOT_COUNT];
            const hotMsg = deduped[hotStartOrigIdx];
            const insertIdx = result.indexOf(hotMsg);
            if (insertIdx > 0) {
                result.splice(insertIdx, 0, {
                    role: 'user' as const,
                    content: '[CONTEXT BOUNDARY] The messages above are prior conversation context. The messages below are the CURRENT conversation. Focus on the latest request only.'
                });
            }
        }

        const dropped = nonSystemIndices.length - result.filter(m => m.role !== 'system').length;
        if (dropped > 0 || deduped.length !== messages.length) {
            outputChannel.appendLine(`[Context] Full mode: ${messages.length} msgs → ${result.length} sent (${dropped} cold-dropped, ${messages.length - deduped.length} system-deduped)`);
        }

        return result;
    }

    /**
     * Summarize a tool result for the frontend telemetry
     */
    private summarizeToolResult(result: any): any {
        if (!result) { return result; }

        if (typeof result === 'object' && !Array.isArray(result)) {
            // Preserve object structure but truncate large string values
            const summarized: any = {};
            for (const key of Object.keys(result)) {
                // Pass through special hidden fields
                if (key.startsWith('_')) {
                    summarized[key] = result[key];
                    continue;
                }

                const val = result[key];
                if (typeof val === 'string') {
                    // run_command output needs to be longer for the UI terminal snippet
                    // The UI itself truncates at 2000 chars, so we pass up to 2500 here
                    const limit = key === 'output' ? 2500 : 300;
                    if (val.length > limit) {
                        summarized[key] = val.substring(0, limit) + `\n... [truncated for UI]`;
                    } else {
                        summarized[key] = val;
                    }
                } else {
                    summarized[key] = val; // keep numbers, booleans, etc
                }
            }
            return summarized;
        }

        const str = typeof result === 'string' ? result : JSON.stringify(result);
        if (str.length > 500) {
            return str.substring(0, 500) + '...';
        }
        return result;
    }
}