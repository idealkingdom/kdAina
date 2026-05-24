import { WorkspaceIndexService } from '../services/workspace-index';
import { createFileTools } from './file-tools';
import { createSysTools, clearTestRetryTracker, classifyCommandRisk } from './sys-tools';
import { createWebTools } from './web-tools';
import { createCognitiveTools, ModelTier } from './cognitive-tools';
import { createArtifactTools } from './artifact-tools';
import { createBrowserTools } from './browser-tools';
import { ApprovalService } from '../chat/approval-service';
import { ReviewManager } from '../chat/review-manager';
import * as path from 'path';
import * as vscode from 'vscode';
import { tool as _tool } from 'ai';
const tool = _tool as any;
import { z } from 'zod';

export interface ToolRegistryOptions {
    chatId?: string;
    readFilesConfirmation: boolean;
    writeFilesConfirmation: boolean;
    commandSafetyMode: 'all' | 'smart' | 'dangerous' | 'none';
    tier?: ModelTier;
    onApprovalRequest?: (toolCallId: string, toolName: string, args: any, options: { diffReviewRequired?: boolean }) => Promise<void>;
    abortSignal?: AbortSignal;
    /** Shared mutable counter — chat-core increments this, tool-registry reads it */
    stepBudget?: { current: number; max: number };
    enableBrowserTools?: boolean;
    settings?: any;
    isSubagent?: boolean;
    onDelegateResearch?: (params: { agentName: string; prompt: string }) => Promise<any>;
    allowedTools?: string[];
}

/**
 * Central tool registry. Creates all tools and returns them as a flat object
 * ready to be injected into the Vercel AI SDK's `tools` parameter.
 */
export function createToolRegistry(workspaceIndex: WorkspaceIndexService, options?: ToolRegistryOptions) {
    // Reset test/build retry tracker for each new agentic request
    clearTestRetryTracker();

    const fileTools = createFileTools(workspaceIndex);
    const sysTools = createSysTools(options?.chatId);
    const webTools = createWebTools();
    const cognitiveTools = createCognitiveTools(options?.tier || 'mid', options?.chatId);
    const artifactTools = createArtifactTools(options?.chatId || 'unknown_chat');

    const browserTools = createBrowserTools();

    // Subagent tool
    const delegateResearchTool = {
        delegate_research: tool({
            description: 'Delegates a specific sub-task or research query to another agent. This runs a sub-agent with its own system prompt and tools, and returns its final answer.',
            inputSchema: z.object({
                agentName: z.string().describe('The name of the agent to delegate to (e.g. "architect", "action")'),
                prompt: z.string().describe('The instructions or research task for the subagent')
            }),
            execute: async (params: { agentName: string; prompt: string }) => {
                if (options?.isSubagent) {
                    return { error: 'Subagents are not allowed to call delegate_research recursively.' };
                }
                if (options?.onDelegateResearch) {
                    return options.onDelegateResearch(params);
                }
                return { error: 'delegate_research is not configured in this context.' };
            }
        })
    };

    const allTools = {
        ...fileTools,
        ...sysTools,
        ...webTools,
        ...cognitiveTools,
        ...artifactTools,
        ...browserTools,
        ...delegateResearchTool
    };

    let filteredTools = allTools;
    if (options?.allowedTools) {
        filteredTools = {} as any;
        for (const key of options.allowedTools) {
            if ((allTools as any)[key]) {
                (filteredTools as any)[key] = (allTools as any)[key];
            }
        }
        // Always retain delegate_research for parent agents if allowed in their capabilities,
        // but if not explicitly in allowedTools, let's make sure they can only call it if it was linked.
        // Actually, delegate_research is just a normal tool. If they don't have delegate_research in allowedTools,
        // it gets filtered out, which is exactly correct!
    }

    // Tool categories keys
    const fileToolsKeys = ['list_workspace', 'read_file_skeleton', 'read_line_range', 'find_symbol', 'search_workspace', 'get_workspace_problems', 'chunk_replace', 'create_file', 'get_workspace_essence'];
    const sysToolsKeys = ['run_command', 'stop_background_process', 'list_background_processes', 'get_background_output'];
    const webToolsKeys = ['web_search', 'scrape_url'];
    const cognitiveToolsKeys = ['plan_task', 'update_task_progress', 'verify_completion', 'delegate_research'];
    const artifactToolsKeys = ['read_artifact', 'manage_artifact'];
    const browserToolsKeys = ['browser_open', 'browser_snapshot', 'browser_action', 'browser_get', 'browser_evaluate', 'browser_close'];

    // Wrap all execute functions to apply settings controls & stepBudget increments
    Object.keys(filteredTools).forEach((key) => {
        const toolDef = (filteredTools as any)[key];
        const originalExecute = toolDef.execute;

        if (originalExecute) {
            toolDef.execute = async (params: any, { toolCallId }: { toolCallId: string }) => {
                if (options?.abortSignal?.aborted) {
                    throw new Error('Request cancelled by user.');
                }

                // ─── RESOLVE TOOL PERMISSION FROM SETTINGS (TRI-STATE) ───
                const toolsConfig = options?.settings?.tools || {};
                let group: 'file_tools' | 'sys_tools' | 'web_tools' | 'cognitive_tools' | 'artifact_tools' | 'browser_tools' | null = null;
                
                if (fileToolsKeys.includes(key)) group = 'file_tools';
                else if (sysToolsKeys.includes(key)) group = 'sys_tools';
                else if (webToolsKeys.includes(key)) group = 'web_tools';
                else if (cognitiveToolsKeys.includes(key)) group = 'cognitive_tools';
                else if (artifactToolsKeys.includes(key)) group = 'artifact_tools';
                else if (browserToolsKeys.includes(key)) group = 'browser_tools';

                let mode: 'always' | 'ask' | 'off' = 'always';
                if (group) {
                    if (group === 'file_tools') {
                        // File tools are locked to Always Proceed (always enabled)
                        mode = 'always';
                    } else {
                        // Resolve from config or use defaults
                        mode = toolsConfig[group] ?? (
                            group === 'sys_tools' ? 'ask' :
                            group === 'browser_tools' ? 'ask' : 'always'
                        );
                    }
                }

                if (mode === 'off') {
                    return { error: `Tool '${key}' is disabled in settings. You must ask the user to enable it or find an alternative.` };
                }

                let requireConfirmation = (mode === 'ask');
                let diffReviewRequired = false;

                // Handle file writes requiring diff review regardless of mode, if they ask
                const writeTools = ['chunk_replace', 'create_file', 'manage_artifact'];
                if (writeTools.includes(key) && mode === 'ask') {
                    diffReviewRequired = true;
                }

                // Set command tools auto-approved flag
                const commandTools = ['run_command', 'stop_background_process'];
                if (commandTools.includes(key)) {
                    (params as any)._autoApproved = !requireConfirmation;
                }

                if (requireConfirmation) {
                    if (diffReviewRequired) {
                        // 1. Execute originally (stages the changes in ReviewManager)
                        const result = await originalExecute(params, { toolCallId });
                        
                        // 2. Notify frontend about the staged changes
                        if (options?.onApprovalRequest) {
                            await options.onApprovalRequest(toolCallId, key, params, { diffReviewRequired });
                        }
                        
                        return appendStepBudget(result, options?.stepBudget);
                    } else {
                        // For non-diff tools (like run_command), block and wait for approval
                        if (options?.onApprovalRequest) {
                            await options.onApprovalRequest(toolCallId, key, params, { diffReviewRequired });
                        }
                        const approved = await ApprovalService.getInstance().waitForApproval(toolCallId);
                        if (!approved) {
                            return { error: `Execution denied by user. Tool '${key}' was not executed.` };
                        }
                        const result = await originalExecute(params, { toolCallId });
                        return appendStepBudget(result, options?.stepBudget);
                    }
                }

                return originalExecute(params, { toolCallId }).then((result: any) => {
                    return appendStepBudget(result, options?.stepBudget);
                });
            };
        }
    });

    return filteredTools;
}

/**
 * Append step budget info to tool results so the model knows its remaining steps.
 * Only triggers after 10+ steps and every 10 steps, or when < 5 remain.
 */
function appendStepBudget(result: any, budget?: { current: number; max: number }): any {
    if (!budget || budget.current < 10) { return result; }
    
    const remaining = budget.max - budget.current;
    
    // Inject at periodic checkpoints (every 10 steps) or when < 5 remain
    if (budget.current % 10 === 0 || remaining <= 5) {
        if (typeof result === 'object' && result !== null) {
            if (remaining <= 3) {
                result._stepBudget = `[!!] CRITICAL: Only ${remaining} steps remaining out of ${budget.max}. You MUST call verify_completion on your NEXT step to summarize what was done. Do NOT make any more tool calls except verify_completion.`;
            } else if (remaining <= 5) {
                result._stepBudget = `[!] URGENT: ${remaining} steps remaining out of ${budget.max}. Wrap up NOW — call update_task_progress to save progress, then call verify_completion.`;
            } else {
                result._stepBudget = `[i] Step ${budget.current}/${budget.max} (${remaining} remaining). Consider calling update_task_progress to checkpoint.`;
            }
        }
    }
    return result;
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
