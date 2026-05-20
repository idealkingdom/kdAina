import { tool as _tool, jsonSchema } from 'ai';
const tool = _tool as any;
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceIndexService } from '../services/workspace-index';
import { ReviewManager } from '../chat/review-manager';

export function calculateDiffStats(original: string, modified: string): { additions: number; deletions: number } {
    const origLines = original ? original.split('\n') : [];
    const modLines = modified ? modified.split('\n') : [];
    
    const dp: number[][] = Array(origLines.length + 1).fill(null).map(() => Array(modLines.length + 1).fill(0));
    
    for (let i = 1; i <= origLines.length; i++) {
        for (let j = 1; j <= modLines.length; j++) {
            if (origLines[i - 1] === modLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    const lcs = dp[origLines.length][modLines.length];
    const deletions = origLines.length - lcs;
    const additions = modLines.length - lcs;
    
    return { additions, deletions };
}

/**
 * Creates the file & AST tools for the agentic loop.
 * NOTE: AI SDK v6 uses 'inputSchema' (not 'parameters') for tool schemas.
 */
export function createFileTools(workspaceIndex: WorkspaceIndexService) {

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    function resolvePath(filePath: string): string {
        if (path.isAbsolute(filePath)) { return filePath; }
        return path.join(workspaceRoot, filePath);
    }

    const list_workspace = tool({
        description: 'List all files in the workspace as a directory tree. Use this first to understand the project structure.',
        inputSchema: (jsonSchema as any)({
            type: 'object',
            properties: {
                directory: {
                    type: 'string',
                    description: 'Optional subdirectory to list (defaults to workspace root)'
                }
            },
            additionalProperties: false
        }),
        execute: async (params: { directory?: string }) => {
            await workspaceIndex.refresh();
            const tree = workspaceIndex.getFileTreeString();
            return { tree, fileCount: workspaceIndex.getFileList().length };
        }
    });

    // ─── TOOL: read_file_skeleton ───────────────────────────────────────
    const read_file_skeleton = tool({
        description: 'Read only the structure of a file: imports, class names, function signatures. Returns a compact skeleton (NOT the full file). Use this to understand a file before reading specific lines.',
        inputSchema: z.object({
            filePath: z.string().describe('Path to the file (absolute or relative to workspace root)')
        }),
        execute: async (params: { filePath: string }) => {
            const absPath = resolvePath(params.filePath);
            if (!fs.existsSync(absPath)) {
                return { error: `File not found: ${absPath}` };
            }

            // Check cache first (saves tokens on repeated reads)
            const cached = workspaceIndex.getCachedSkeleton(absPath);
            if (cached) {
                return {
                    file: params.filePath,
                    absolutePath: absPath,
                    totalLines: cached.totalLines,
                    skeleton: cached.skeleton || '(No structural elements found)',
                    _cached: true
                };
            }

            const content = fs.readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            let skeletonStr = '';
            
            // Try AST first
            const fileUri = vscode.Uri.file(absPath);
            const astSkeleton = await workspaceIndex.buildAstSkeleton(fileUri);
            
            if (astSkeleton) {
                skeletonStr = astSkeleton;
            } else {
                // Fallback to Regex for unsupported languages or large files
                const skeleton: string[] = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const trimmed = line.trim();

                    if (trimmed.startsWith('import ') || trimmed.startsWith('from ') || (trimmed.startsWith('const ') && trimmed.includes('require('))) {
                        skeleton.push(`L${i + 1}: ${line}`);
                    } else if (trimmed.startsWith('export ')) {
                        skeleton.push(`L${i + 1}: ${line}`);
                    } else if (/^\s*(export\s+)?(abstract\s+)?(class|interface|type|enum)\s/.test(line)) {
                        skeleton.push(`L${i + 1}: ${line}`);
                    } else if (/^\s*(export\s+)?(async\s+)?(function|const\s+\w+\s*=\s*(async\s*)?\(|public|private|protected|static)\s/.test(line)) {
                        skeleton.push(`L${i + 1}: ${line}`);
                    } else if (/^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/.test(line)) {
                        skeleton.push(`L${i + 1}: ${line}`);
                    } else if (/^\s*def\s+\w+/.test(line) || /^\s*class\s+\w+/.test(line)) {
                        // Python support
                        skeleton.push(`L${i + 1}: ${line}`);
                    }
                }
                skeletonStr = skeleton.join('\n') || '(No structural elements found)';
            }

            // Cache it for future calls
            workspaceIndex.cacheSkeleton(absPath, skeletonStr, lines.length);

            return {
                file: params.filePath,
                absolutePath: absPath,
                totalLines: lines.length,
                skeleton: skeletonStr,
            };
        }
    } as any);

    // ─── TOOL: read_line_range ──────────────────────────────────────────
        /**
     * Reads a specific block of lines from a target file, clamped to file bounds.
     */
const read_line_range = tool({
        description: 'Read specific lines from a file. Use after read_file_skeleton to examine specific sections. Maximum 200 lines per call.',
        inputSchema: z.object({
            filePath: z.string().describe('Path to the file'),
            startLine: z.number().describe('Start line number (1-indexed)'),
            endLine: z.number().describe('End line number (1-indexed, inclusive)')
        }),
        execute: async (params: { filePath: string; startLine: number; endLine: number }) => {
            const absPath = resolvePath(params.filePath);
            if (!fs.existsSync(absPath)) {
                return { error: `File not found: ${absPath}` };
            }

            const content = fs.readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            const totalLines = lines.length;
            const clampedEnd = Math.min(params.endLine, params.startLine + 199, totalLines);

            const slice = lines.slice(params.startLine - 1, clampedEnd);
            const numbered = slice.map((l: string, i: number) => `L${params.startLine + i}: ${l}`).join('\n');

            return {
                file: params.filePath,
                absolutePath: absPath,
                range: `${params.startLine}-${clampedEnd}`,
                totalLines,
                content: numbered,
                _note: 'The L-prefix line numbers are for your reference only. Do NOT include them in your targetContent when using chunk_replace.'
            };
        }
    } as any);

    // ─── POST-EDIT HELPERS ───────────────────────────────────────────────

    /**
     * Auto-format a file using VS Code's built-in formatter, then check
     * LSP diagnostics and return any errors/warnings for the agent to fix.
     */
    async function postEditVerify(fileUri: vscode.Uri): Promise<{ formatted: boolean; problems?: string }> {
        let formatted = false;

        try {
            // Auto-format: use VS Code's built-in document formatter (LSP-backed)
            const doc = await vscode.workspace.openTextDocument(fileUri);
            
            // Promise.race to prevent infinite hang if formatter triggers a UI prompt (e.g., "Multiple formatters installed")
            const formatPromise = vscode.commands.executeCommand(
                'vscode.executeFormatDocumentProvider',
                fileUri,
                { tabSize: 2, insertSpaces: true } as vscode.FormattingOptions
            ) as Promise<vscode.TextEdit[] | undefined>;
            
            const timeoutPromise = new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('Formatter timeout')), 2000));
            
            const edits = await Promise.race([formatPromise, timeoutPromise]);
            
            if (edits && edits.length > 0) {
                const wsEdit = new vscode.WorkspaceEdit();
                for (const edit of edits) {
                    wsEdit.replace(fileUri, edit.range, edit.newText);
                }
                await vscode.workspace.applyEdit(wsEdit);
                formatted = true;
            }
        } catch {
            // Formatter not available for this file type — that's fine
        }

        // Auto-verify: check diagnostics for this specific file
        // Small delay to let the language server process the changes
        await new Promise(r => setTimeout(r, 300));

        const diagnostics = vscode.languages.getDiagnostics(fileUri);
        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

        if (errors.length > 0) {
            const problemText = errors.slice(0, 8).map(d =>
                `  Line ${d.range.start.line + 1}: ${d.message}`
            ).join('\n');
            return { formatted, problems: problemText };
        }

        return { formatted };
    }

    // ─── TOOL: chunk_replace ────────────────────────────────────────────
    const chunk_replace = tool({
        description: 'Replace a specific block of text in a file. Provide the exact target text to find and the replacement text. This is a surgical edit — only the matched text is replaced. Changes are written directly to the file.',
        inputSchema: z.object({
            filePath: z.string().describe('Path to the file'),
            targetContent: z.string().describe('The exact text to find and replace (must match exactly). Strip any L-prefix line numbers like "L12: " which are only for your reference.'),
            replacementContent: z.string().describe('The new text to replace it with')
        }),
        execute: async (params: { filePath: string; targetContent: string; replacementContent: string }) => {
            const absPath = resolvePath(params.filePath);
            const fileUri = vscode.Uri.file(absPath);
            
            // Clean L-prefix line numbers
            const cleanTarget = params.targetContent.replace(/^L\d+:\s/gm, '');
            const cleanReplacement = params.replacementContent.replace(/^L\d+:\s/gm, '');

            // #43: Direct-write — apply to file immediately
            const reviewManager = ReviewManager.getInstance();
            const result = await reviewManager.applyDirectEdit(
                fileUri,
                cleanTarget,
                cleanReplacement,
                'chunk_replace'
            );

            if (!result.success) {
                return { error: result.error || 'Failed to apply edit.' };
            }

            // Auto-format + auto-verify
            const verification = await postEditVerify(fileUri);

            const stats = calculateDiffStats(cleanTarget, cleanReplacement);
            const response: any = {
                success: true,
                message: 'Changes applied directly to file. User can review via inline highlights.',
                file: params.filePath,
                absolutePath: absPath,
                additions: stats.additions,
                deletions: stats.deletions,
                linesReplaced: cleanTarget.split('\n').length
            };

            if (verification.formatted) {
                response.autoFormatted = true;
            }

            if (verification.problems) {
                response._problems = `Your edit introduced errors in ${params.filePath}:\n${verification.problems}\nFix these before proceeding.`;
            }

            return response;
        }
    } as any);

    // ─── TOOL: create_file ──────────────────────────────────────────────
    const create_file = tool({
        description: 'Create a new file with the given content. Parent directories will be created automatically. The file is created immediately.',
        inputSchema: z.object({
            filePath: z.string().describe('Path for the new file'),
            content: z.string().describe('Content to write')
        }),
        execute: async (params: { filePath: string; content: string }) => {
            const absPath = resolvePath(params.filePath);
            const fileUri = vscode.Uri.file(absPath);

            const cleanContent = params.content.replace(/^L\d+:\s/gm, '');

            // Ensure parent directory exists
            const dir = require('path').dirname(absPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // #43: Direct-write — create file immediately
            const reviewManager = ReviewManager.getInstance();
            const result = await reviewManager.applyDirectCreate(
                fileUri,
                cleanContent,
                'create_file'
            );

            if (!result.success) {
                return { error: result.error || 'Failed to create file.' };
            }

            // Auto-format + auto-verify
            const verification = await postEditVerify(fileUri);

            const response: any = {
                success: true,
                message: 'File created successfully.',
                file: params.filePath,
                absolutePath: absPath,
                additions: cleanContent ? cleanContent.split('\n').length : 0,
                deletions: 0,
                lines: cleanContent.split('\n').length
            };

            if (verification.formatted) {
                response.autoFormatted = true;
            }

            if (verification.problems) {
                response._problems = `New file ${params.filePath} has errors:\n${verification.problems}\nFix these before proceeding.`;
            }

            return response;
        }
    } as any);

    // ─── TOOL: find_symbol ──────────────────────────────────────────────
    const find_symbol = tool({
        description: 'Search for a function, class, or variable by name across the workspace. Returns file path and line numbers.',
        inputSchema: z.object({
            query: z.string().describe('Symbol name to search for')
        }),
        execute: async (params: { query: string }) => {
            const results = await workspaceIndex.findSymbol(params.query);
            if (results.length === 0) {
                return { results: [], message: `No symbols matching "${params.query}" found.` };
            }
            return {
                results: results.map(r => ({
                    name: r.name,
                    kind: r.kind,
                    file: vscode.workspace.asRelativePath(r.filePath),
                    line: r.range.startLine
                }))
            };
        }
    } as any);

    return {
        list_workspace,
        read_file_skeleton,
        read_line_range,
        chunk_replace,
        create_file,
        find_symbol
    };
}

