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

    const browserTools = options?.enableBrowserTools !== false ? createBrowserTools() : {};

    const allTools = {
        ...fileTools,
        ...sysTools,
        ...webTools,
        ...cognitiveTools,
        ...artifactTools,
        ...browserTools
    };

    const readTools = ['list_workspace', 'read_file_skeleton', 'read_line_range', 'find_symbol', 'search_workspace', 'scrape_url', 'web_search', 'get_workspace_problems', 'read_artifact', 'list_background_processes', 'get_background_output'];
    const writeTools = ['chunk_replace', 'create_file', 'manage_artifact'];
    const commandTools = ['run_command', 'stop_background_process'];
    // Browser interaction tools operate in an isolated sandbox — they should NOT go through shell
    // command risk classification. They auto-approve; they don't execute system commands. (#79)
    const browserInteractionTools = ['browser_action', 'browser_evaluate'];

    // Wrap all execute functions
    Object.keys(allTools).forEach((key) => {
        const toolDef = (allTools as any)[key];
        const originalExecute = toolDef.execute;

        if (originalExecute) {
            toolDef.execute = async (params: any, { toolCallId }: { toolCallId: string }) => {
                if (options?.abortSignal?.aborted) {
                    throw new Error('Request cancelled by user.');
                }
                let requireConfirmation = false;
                let diffReviewRequired = false;

                if (readTools.includes(key)) {
                    requireConfirmation = options?.readFilesConfirmation ?? false;
                } else if (writeTools.includes(key)) {
                    requireConfirmation = options?.writeFilesConfirmation ?? true;
                    diffReviewRequired = true;
                } else if (browserInteractionTools.includes(key)) {
                    // #79: Browser tools run in an isolated sandbox — no shell risk classification.
                    // Auto-approve; they don't execute system commands.
                    requireConfirmation = false;
                } else if (commandTools.includes(key)) {
                    const mode = options?.commandSafetyMode || 'smart';
                    if (mode === 'all') {
                        requireConfirmation = true;
                    } else if (mode === 'none') {
                        requireConfirmation = false;
                    } else {
                        // smart or dangerous
                        const risk = classifyCommandRisk(params?.command || '');
                        if (risk === 'dangerous') {
                            requireConfirmation = true;
                        } else if (risk === 'moderate') {
                            requireConfirmation = mode === 'smart';
                        } else {
                            // safe
                            requireConfirmation = false;
                        }
                    }
                    
                    // Inject _autoApproved flag into params so sys-tools knows whether to apply ulimit
                    if (!requireConfirmation) {
                        (params as any)._autoApproved = true;
                    } else {
                        (params as any)._autoApproved = false;
                    }
                }

                if (requireConfirmation) {
                    if (diffReviewRequired) {
                        // 1. Execute originally (This stages the changes in ReviewManager)
                        const result = await originalExecute(params, { toolCallId });
                        
                        // 2. Notify frontend about the staged changes
                        if (options?.onApprovalRequest) {
                            await options.onApprovalRequest(toolCallId, key, params, { diffReviewRequired });
                        }
                        
                        return appendStepBudget(result, options?.stepBudget);
                    } else {
                        // For non-diff tools (like run_command), we still block and wait for approval
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

    return allTools;
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
