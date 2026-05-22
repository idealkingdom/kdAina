/*
This function was originally from ChatViewProvider, however for simplicity and easy to access
separated by another module.
* Coordinates message routing, history logs, and file interactions.
*/
import { outputChannel } from "../logger";
import { CHAT_COMMANDS, ROLE } from "./chat-constants";
import { ChatCoreService } from "./chat-core"; // Assuming you updated this to a Service, or kept it static
import { ChatHistoryService } from "./chat-history"; // Import the NEW Service
import { ChatViewProvider } from "./chat-view-provider";
import * as vscode from 'vscode';
import * as path from 'path';
import { processBinaryFile } from "./binary-handler";
import { ImageStorageService } from "./image-storage";
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { SettingsManager } from '../services/settings-manager';
import { ApprovalService } from "./approval-service";

import { ReviewManager, PendingEdit } from "./review-manager";
import { PopupManager } from "./popup-manager";
import { DiffContentProvider } from "./diff-content-provider";

// For Handshake/Syncing
const chunkAcks = new Map<string, (val: any) => void>();
let nextSeq = 0;

/**
 * Convert a PendingEdit to a hunk object with diff lines for the Review panel.
 */
function pendingEditToHunk(edit: PendingEdit) {
    const oldLines = edit.originalContent.split('\n');
    const newLines = edit.newContent.split('\n');
    const lines: string[] = [];

    for (const line of oldLines) {
        lines.push('-' + line);
    }
    for (const line of newLines) {
        lines.push('+' + line);
    }

    return {
        accepted: true,
        oldStart: edit.startLine + 1,
        oldLines: oldLines.length,
        newStart: edit.startLine + 1,
        newLines: newLines.length,
        lines
    };
}

/**
 * Build filesData for the Review panel from the ReviewManager state.
 */
function buildReviewFilesData(): any[] {
    const reviewManager = ReviewManager.getInstance();
    const uris = reviewManager.getStagedUris();
    return uris.map(uri => {
        const edits = reviewManager.getPendingEdits(uri.toString()) || [];
        return {
            fileName: path.basename(uri.fsPath),
            uri: uri.toString(),
            isNewFile: false,
            hunks: edits.map(e => pendingEditToHunk(e))
        };
    });
}

// message sent from client js
// sourceWebview: when provided (e.g. from popups), messages are routed to that
// specific webview instead of broadcasting via ChatViewProvider.
export async function chatMessageListener(message: any, sourceWebview?: vscode.Webview) {

    // 1. GET DEPENDENCIES
    // We get the context from your Provider to initialize the History Service
    const context = ChatViewProvider.getContext();
    const webview = sourceWebview || ChatViewProvider.getView()?.webview;

    if (!webview) {
        outputChannel.appendLine('Webview is missing.');
        return;
    }

    // Local helper — routes messages to the correct webview (popup or sidebar)
    const post = (msg: any) => webview.postMessage(msg);


    const imageService = new ImageStorageService(context);
    const settingsManager = new SettingsManager(context);

    // const historyService = new ChatHistoryService(context.globalState, imageService);
    // Note: ChatHistoryService also needs context.globalState. It seems okay.
    const historyService = new ChatHistoryService(context.globalState, imageService);

    const coreService = new ChatCoreService(historyService, imageService, settingsManager);

    switch (message.command) {
        // --- 1. INIT ---
        case CHAT_COMMANDS.CHAT_WEBVIEW_READY:
            {
                const existingId = ChatViewProvider.getCurrentSessionId();
                if (existingId) {
                    // REHYDRATE
                    const conversation = historyService.getConversation(existingId);
                    if (conversation) {
                        await post({
                            command: CHAT_COMMANDS.CHAT_STATE_REHYDRATE,
                            content: {
                                chatId: existingId,
                                messages: conversation.messages,
                                stagedFilesCount: ReviewManager.getInstance().getStagedUris().length,
                                agentId: conversation.agentId
                            }
                        });
                        return;
                    }
                }

                // NEW CHAT
                const newChatId = coreService.generateChatID();
                ChatViewProvider.setCurrentSessionId(newChatId);
                await post({
                    command: CHAT_COMMANDS.CHAT_RESET,
                    content: { uid: newChatId }
                });

                // Sync the initial staging state
                const count = ReviewManager.getInstance().getStagedUris().length;
                await post({
                    command: 'chatStagingUpdate',
                    content: { stagedFilesCount: count }
                });

                // Send initial workspace index stats
                try {
                    const { WorkspaceIndexService } = require('../services/workspace-index');
                    const wsIndex = WorkspaceIndexService.getInstance();
                    await wsIndex.refresh();
                    const fileCount = wsIndex.getFileList().length;
                    await post({
                        command: 'indexUpdate',
                        content: { fileCount, lastUpdated: new Date().toISOString() }
                    });
                    
                    // Send initial essence status (uses cached values — no I/O)
                    await post({
                        command: 'essenceStatus',
                        content: wsIndex.getEssenceStatus()
                    });
                } catch (e) {
                    outputChannel.appendLine(`[Index] Initial index failed: ${e}`);
                }
                break;
            }

        // NEW SESSION — open a new independent chat session, keep current open
        case 'detachChat': {
            if (context) {
                await PopupManager.openPopup(context, undefined);
            }
            break;
        }
        case 'searchWorkspaceFiles':
            {
                const query = message.data.query || '';
                
                const workspaceFiles = await vscode.workspace.findFiles(
                    '**/*',
                    '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/out/**,**/.vscode/**}'
                );

                const results = workspaceFiles
                    .map(uri => vscode.workspace.asRelativePath(uri))
                    .filter(p => p.toLowerCase().includes(query.toLowerCase()))
                    .slice(0, 25)
                    .map(p => ({
                        label: p.split(/[\\/]/).pop() || p,
                        description: p,
                        path: p
                    }));

                await post({
                    command: 'searchFilesResult',
                    query: query,
                    results: results
                });
                break;
            }
        case 'saveSettings':

        case 'updateNestedSetting': {
            const { category, key, value } = message.data;
            const currentSettings = settingsManager.getSettings();
            if (currentSettings[category as keyof typeof currentSettings]) {
                (currentSettings[category as keyof typeof currentSettings] as any)[key] = value;
                await settingsManager.updateSettings({ [category]: currentSettings[category as keyof typeof currentSettings] });
            }

            // #1: When alwaysProceed is toggled ON, auto-approve all pending tool requests
            if (category === 'permissions' && key === 'alwaysProceed' && value === true) {
                const approvalService = ApprovalService.getInstance();
                approvalService.approveAll();
            }
            break;
        }

        case 'updateCategorySettings': {
            const { category, settings } = message.data;
            const currentSettings = settingsManager.getSettings();
            if (currentSettings[category as keyof typeof currentSettings]) {
                const updatedCategory = { ...currentSettings[category as keyof typeof currentSettings], ...settings };
                await settingsManager.updateSettings({ [category]: updatedCategory });
            }
            break;
        }

        // Pull-based model refresh: chatbox requests fresh model data (e.g. when dropdown opens)
        case 'requestModels': {
            const { getModelProviderOptions } = require('../constants');
            const latestSettings = settingsManager.getSettings();
            await post({
                command: 'modelsUpdate',
                models: latestSettings.models,
                customModels: latestSettings.customModels,
                availableModels: getModelProviderOptions()
            });
            break;
        }

        // #46: Scrape a URL and return content to the frontend
        case 'scrapeUrl': {
            const { WebScraperService } = require('../services/web-scraper');
            const scraper = new WebScraperService();
            const url = message.url;
            try {
                const result = await scraper.scrape(url);
                await post({
                    command: 'scrapeResult',
                    url: url,
                    success: result.success,
                    title: result.title,
                    content: result.content?.substring(0, 8000) || '',
                    wordCount: result.wordCount,
                    error: result.error
                });
            } catch (err: any) {
                await post({
                    command: 'scrapeResult',
                    url: url,
                    success: false,
                    error: err.message || 'Scraping failed'
                });
            }
            break;
        }

        case CHAT_COMMANDS.CHAT_RESET:
            {
                // Now: We generate ID and send it manually, or add resetChat() to your Service.
                const newChatId = coreService.generateChatID();
                await post({
                    command: CHAT_COMMANDS.CHAT_RESET,
                    content: { uid: newChatId }
                });
                break;
            }

        case CHAT_COMMANDS.CHAT_REQUEST:
            {
                // This handles saving User + AI msg to history internally.

                // FORMAT THE MESSAGE (Text + Files)
                const rawText = message.data.message;
                const files = message.data.files;
                const images = message.data.images;
                const agentId = message.data.agentId;
                
                // This turns the text + files into one big Markdown string for the UI display (without instructions)
                const formattedMessage = formatMessageWithFiles(rawText, files);

                await post({
                    command: CHAT_COMMANDS.CHAT_REQUEST,
                    content: formattedMessage,
                    images: images,
                    files: files,
                    role: ROLE.USER
                });

                // Append instructions to userQuery for the AI model's prompt
                let userQuery = rawText;
                const instructions: string[] = [];
                if (message.data.createBlueprint) {
                    instructions.push(
`Analyze this workspace thoroughly and create an artifact called "blueprint.md" using the manage_artifact tool with scope="global" and action="create".

blueprint.md should document:
- Project overview and purpose
- Architecture and high-level design
- Key modules and their responsibilities
- Entry points and execution flow
- Dependencies and their roles
- Data flow between components
- Directory structure explanation

Write comprehensive, well-structured Markdown. In your visible response, just confirm the blueprint was created and give a brief summary of the project architecture.`
                    );
                }
                if (message.data.createSkill) {
                    instructions.push(
`Analyze this workspace thoroughly and create an artifact called "skill.md" using the manage_artifact tool with scope="global" and action="create".

skill.md should document:
- Coding conventions and style guidelines used in this project
- Preferred design patterns and idioms
- Testing strategy and test organization
- Build and development workflow
- Naming conventions
- Error handling patterns
- Any project-specific rules or preferences observed in the code

Write comprehensive, well-structured Markdown. In your visible response, just confirm the skill file was created and give a brief summary of the project conventions.`
                    );
                }
                if (instructions.length > 0) {
                    const instructionsStr = instructions.join('\n\n');
                    if (userQuery && userQuery.trim() !== '') {
                        userQuery = userQuery + '\n\n' + instructionsStr;
                    } else {
                        userQuery = instructionsStr;
                    }
                }

                // This turns the query + files into the full Markdown string for the AI
                const fullMessageForAi = formatMessageWithFiles(userQuery, files);

                // We replace the original message data with our new formatted one
                const aiData = {
                    ...message.data,
                    message: fullMessageForAi, // <--- Pass the FULL content with instructions
                    agentId: agentId,          // <--- Pass the agent mode
                    files: [] // Clear files so Core doesn't double-append them
                };

                let chatId = aiData.chat_id;
                if (!chatId || chatId === "") {
                    chatId = coreService.generateChatID();
                    // Update webview with the new ID so future cancellations/messages use it
                    await post({
                        command: CHAT_COMMANDS.CHAT_ID_UPDATE,
                        content: { uid: chatId }
                    });
                    // Update the data object we pass to the core service
                    aiData.chat_id = chatId;
                }

                post({ command: CHAT_COMMANDS.CHAT_STREAM_START });

                try {
                    const { text: aiResponse, usage, hitStepLimit, continuationMaxSteps } = await coreService.processChatRequest(
                        aiData,
                        // onChunk — stream text to frontend
                        async (chunk) => {
                            const seq = ++nextSeq;
                            const ackPromise = new Promise(resolve => {
                                chunkAcks.set(seq.toString(), resolve);
                            });

                            await post({
                                command: CHAT_COMMANDS.CHAT_STREAM_CHUNK,
                                content: chunk,
                                seq: seq
                            });

                            // Wait for webview ACK with timeout safety net
                            // If webview is disconnected/crashed, don't hang forever
                            const timeoutPromise = new Promise(resolve => setTimeout(resolve, 10000));
                            await Promise.race([ackPromise, timeoutPromise]);
                            chunkAcks.delete(seq.toString()); // Clean up if timed out
                        },
                        // onAgentStep — stream tool telemetry to frontend
                        async (step) => {
                            await post({
                                command: CHAT_COMMANDS.CHAT_AGENT_STEP,
                                content: step
                            });
                        },
                        // onUsageUpdate — stream token usage to frontend live
                        (usage) => {
                            post({
                                command: CHAT_COMMANDS.CHAT_USAGE_UPDATE,
                                usage: usage
                            });
                        }
                    );

                    post({
                        command: CHAT_COMMANDS.CHAT_STREAM_END,
                        content: aiResponse,
                        role: ROLE.BOT
                    });

                    // Sync final token count with DB (e.g. to revert estimates if aborted)
                    const finalConversation = historyService.getConversation(aiData.chat_id);
                    if (finalConversation) {
                        post({
                            command: CHAT_COMMANDS.CHAT_USAGE_UPDATE,
                            usage: {
                                totalTokens: finalConversation.totalTokens || 0
                            }
                        });
                    }

                    // If the agent hit the step limit, offer continuation
                    if (hitStepLimit) {
                        const extraSteps = Math.max(5, Math.floor((continuationMaxSteps || 20) / 2));
                        post({
                            command: CHAT_COMMANDS.CHAT_CONTINUE_PROMPT,
                            data: {
                                chatId: aiData.chat_id,
                                agentId: aiData.agentId,
                                extraSteps,
                                stepsUsed: continuationMaxSteps
                            }
                        });
                    }
                } catch (error: any) {
                    outputChannel.appendLine(`[ChatRequest] Unhandled error: ${error?.message || error}`);
                    post({
                        command: CHAT_COMMANDS.CHAT_STREAM_END,
                        content: `\n\n[System] Request failed: ${error?.message || 'Unknown error'}`,
                        role: ROLE.BOT
                    });

                    // Sync final token count with DB (e.g. to revert estimates if aborted)
                    const finalConversation = historyService.getConversation(aiData.chat_id);
                    if (finalConversation) {
                        post({
                            command: CHAT_COMMANDS.CHAT_USAGE_UPDATE,
                            usage: {
                                totalTokens: finalConversation.totalTokens || 0
                            }
                        });
                    }
                }
                break;
            }

        case CHAT_COMMANDS.CHAT_CONTINUE:
            {
                // User clicked "Continue" after hitting step limit
                // Send a synthetic continuation message through the normal pipeline
                const continueData = message.data;
                outputChannel.appendLine(`[Continue] Continuing chat ${continueData.chatId} with agent ${continueData.agentId}`);

                const syntheticMessage = {
                    command: CHAT_COMMANDS.CHAT_REQUEST,
                    data: {
                        message: 'Continue working on the task. Pick up where you left off and complete the remaining work.',
                        chat_id: continueData.chatId,
                        agentId: continueData.agentId,
                        images: [],
                        imageDescriptions: []
                    }
                };

                // Recurse into the same handler with the synthetic message
                await chatMessageListener(syntheticMessage);
                break;
            }

        case CHAT_COMMANDS.CHAT_UNDO:
            {
                const chatId = message.data.chat_id;
                const userMsgIdx = message.data.userMsgIdx;

                // 1. Delete messages from history starting from the userMsgIdx
                if (userMsgIdx !== undefined) {
                    await historyService.deleteFromUserMessageIndex(chatId, userMsgIdx);
                }

                // 2. Discard/revert pending file changes from this message index onward
                if (userMsgIdx !== undefined) {
                    await ReviewManager.getInstance().discardEditsPastMessage(chatId, userMsgIdx);
                } else {
                    await ReviewManager.getInstance().discardAll();
                }

                // 3. Clear the active agent turn so the agent is ready for a new attempt
                ReviewManager.getInstance().startTurn();

                // 4. Update the token pill in the UI with the remaining conversation's totalTokens
                const conversation = historyService.getConversation(chatId);
                const totalTokens = conversation?.totalTokens ?? 0;
                post({
                    command: CHAT_COMMANDS.CHAT_USAGE_UPDATE,
                    usage: { totalTokens }
                });
                break;
            }

        // --- HISTORY: SHOW LIST ---
        case CHAT_COMMANDS.HISTORY_LOAD:
            {
                const historyData = historyService.getFormattedHistoryGroups();
                await post({
                    command: CHAT_COMMANDS.HISTORY_LOAD,
                    content: historyData
                });
                break;
            }

        case CHAT_COMMANDS.CHAT_CHUNK_ACK:
            {
                const seq = message.seq?.toString();
                if (seq && chunkAcks.has(seq)) {
                    const resolver = chunkAcks.get(seq);
                    if (resolver) { resolver(true); }
                    chunkAcks.delete(seq);
                }
                break;
            }

        case 'cancelChatRequest':
            {
                const chatId = message.data.chat_id;
                outputChannel.appendLine(`[Cancel] Received cancelChatRequest for chatId=${chatId}`);
                if (chatId) {
                    // 1. Abort the backend stream
                    const cancelled = coreService.cancelChatRequest(chatId);
                    outputChannel.appendLine(`[Cancel] AbortController found and aborted: ${cancelled}`);

                    // 2. Flush all pending chunk ACKs to unblock the backend
                    //    (the backend is waiting for ACKs that will never come because the UI stopped)
                    for (const [seq, resolver] of chunkAcks.entries()) {
                        resolver(false);
                    }
                    chunkAcks.clear();
                    outputChannel.appendLine(`[Cancel] Flushed all pending chunk ACKs`);
                }
                break;
            }

        // --- HISTORY: LOAD SPECIFIC CHAT ---
        case CHAT_COMMANDS.CHAT_LOAD:
            {
                const targetId = message.data.chatId;
                const conversation = historyService.getConversation(targetId);

                if (conversation) {
                    ChatViewProvider.setCurrentSessionId(targetId);
                    // A. Reset UI with the old ID
                    await post({
                        command: CHAT_COMMANDS.CHAT_RESET,
                        content: { 
                            uid: conversation.chat_id,
                            agentId: conversation.agentId
                        }
                    });

                    // C. Restore Token Usage Count to UI
                    await post({
                        command: CHAT_COMMANDS.CHAT_USAGE_UPDATE,
                        usage: {
                            totalTokens: conversation.totalTokens || 0
                        }
                    });

                    // B. Restore Messages
                    // We loop through the stored messages and send them to the UI
                    for (const msg of conversation.messages) {
                        // We use the existing 'chatRequest' command but add the 'role'
                        // so the frontend knows if it's USER or BOT.

                        // RESOLVE IMAGES: Convert "img_123.png" -> "vscode-resource://..."
                        // #63: Extract original display names from message text (e.g. "[Pasted Image 2]")
                        let displayImages: any[] = [];
                        if (msg.images && msg.images.length > 0) {
                            // Extract image names from message text by finding [Bracketed Names]
                            const namePattern = /\[(Pasted Image[^\]]*|Image[^\]]*)\]/g;
                            const messageNames: string[] = [];
                            let match;
                            while ((match = namePattern.exec(msg.message)) !== null) {
                                messageNames.push(match[1]);
                            }

                            displayImages = msg.images.map((fileName, idx) => ({
                                name: messageNames[idx] || `Image ${idx + 1}`,
                                dataUrl: imageService.getWebviewUri(fileName, webview),
                                path: imageService.getImagePath(fileName).fsPath // <--- Send REAL path
                            }));
                        }



                        // Sanitize agentSteps for backward compatibility with bloated history files
                        // Previously, streaming saved 1000s of 'thinking' chunks per message, freezing the UI on load.
                        let sanitizedAgentSteps = msg.agentSteps;
                        if (sanitizedAgentSteps && sanitizedAgentSteps.length > 0) {
                            const coalesced: any[] = [];
                            for (const step of sanitizedAgentSteps) {
                                if (step.type === 'thinking') {
                                    const last = coalesced[coalesced.length - 1];
                                    if (last && last.type === 'thinking') {
                                        last.text = (last.text || '') + (step.text || '');
                                    } else {
                                        coalesced.push({ ...step });
                                    }
                                } else {
                                    coalesced.push(step);
                                }
                            }
                            sanitizedAgentSteps = coalesced;
                        }

                        // Debug log for history loading
                        if (sanitizedAgentSteps) {
                            outputChannel.appendLine(`[History Load] Found ${sanitizedAgentSteps.length} agent steps for msg ${msg.message_id}`);
                        } else {
                            outputChannel.appendLine(`[History Load] No agent steps found for msg ${msg.message_id}`);
                        }

                        await post({
                            command: CHAT_COMMANDS.CHAT_REQUEST,
                            content: msg.message,
                            images: displayImages,
                            files: msg.files, // <--- Send files to restore URL/file pills
                            role: msg.role === ROLE.USER ? ROLE.USER : ROLE.BOT,
                            isHistory: true, // TODO flag to avoid saving again
                            agentSteps: sanitizedAgentSteps // <--- Restore sanitized agent steps
                        });
                    }
                }
                break;
            }
        // --- CLEAR HISTORY ---
        case CHAT_COMMANDS.HISTORY_CLEAR:
            {
                await historyService.clear();
                await post({
                    command: CHAT_COMMANDS.HISTORY_LOAD,
                    content: []
                });
                break;
            }

        case CHAT_COMMANDS.CONVERSATION_DELETE:
            {
                const targetId = message.data.chatId;
                await historyService.deleteConversation(targetId);
                await historyService.deleteConversation(targetId);
                break;
            }

        case CHAT_COMMANDS.OPEN_IMAGE:
            {
                const data = message.data.path; // Can be path OR base64
                if (!data) { return; }

                let uri: vscode.Uri;

                // Check if it's Base64
                if (data.startsWith('data:')) {
                    try {
                        // 1. Parse Base64
                        const matches = data.match(/^data:image\/([a-z]+);base64,(.+)$/);
                        const ext = matches ? matches[1] : 'png';
                        const rawData = matches ? matches[2] : data;
                        const buffer = Buffer.from(rawData, 'base64');

                        // 2. Generate Hash for Deduplication
                        const hash = crypto.createHash('md5').update(buffer).digest('hex');
                        const fileName = `vscode_ai_preview_${hash}.${ext}`;
                        const tempPath = path.join(os.tmpdir(), fileName);

                        // 3. Write only if not exists (Cache!)
                        if (!fs.existsSync(tempPath)) {
                            await fs.promises.writeFile(tempPath, buffer);
                        }

                        uri = vscode.Uri.file(tempPath);

                    } catch (e) {
                        console.error("Preview Error:", e);
                        vscode.window.showErrorMessage("Failed to open image preview.");
                        return;
                    }
                } else {
                    // It's a normal path
                    uri = vscode.Uri.file(data);
                }

                // Execute VS Code's native open command
                vscode.commands.executeCommand('vscode.open', uri);
                break;
            }

        case 'openFile':
            {
                let filePath = message.data.path;
                if (!filePath) { return; }
                if (!path.isAbsolute(filePath)) {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (workspaceRoot) {
                        filePath = path.join(workspaceRoot, filePath);
                    }
                }
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('vscode.open', uri);
                break;
            }

        case 'openArtifact':
            {
                const artifactName = message.data.name;
                if (!artifactName) { return; }
                const chatId = message.data.chatId || ChatViewProvider.getCurrentSessionId();
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot && chatId) {
                    const artifactPath = path.join(workspaceRoot, '.kdaina', 'artifacts', 'sessions', chatId, artifactName);
                    const artifactPathMd = path.join(workspaceRoot, '.kdaina', 'artifacts', 'sessions', chatId, artifactName.endsWith('.md') ? artifactName : `${artifactName}.md`);
                    
                    if (fs.existsSync(artifactPath)) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(artifactPath));
                    } else if (fs.existsSync(artifactPathMd)) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(artifactPathMd));
                    } else {
                        vscode.window.showInformationMessage(`Artifact ${artifactName} not found.`);
                    }
                }
                break;
            }

        case 'openVirtualFile':
            {
                const { name, text, language } = message.data;
                if (!text) { return; }
                vscode.workspace.openTextDocument({
                    content: text,
                    language: language || 'markdown'
                }).then(doc => {
                    vscode.window.showTextDocument(doc, { preview: true });
                });
                break;
            }

        case 'openExternal':
            {
                const url = message.data.url;
                if (url) {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            }
        case 'addFileByPath':
            {
                const relativePath = message.data.path;
                if (!relativePath) { break; }
                
                try {
                    // Locate absolute file path via workspace findFiles
                    const files = await vscode.workspace.findFiles(relativePath, '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}');
                    if (files.length === 0) {
                        vscode.window.showErrorMessage(`File not found: ${relativePath}`);
                        break;
                    }

                    const document = await vscode.workspace.openTextDocument(files[0]);
                    const fileName = document.fileName.split(/[\\/]/).pop();
                    const fileContent = document.getText();
                    const languageId = document.languageId;

                    await post({
                        command: 'fileContextAdded',
                        content: {
                            name: fileName,
                            text: fileContent,
                            language: languageId,
                            type: 'file',
                            path: document.uri.fsPath
                        }
                    });
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to read file context: ${relativePath}`);
                }
                break;
            }
        case CHAT_COMMANDS.ADD_CONTEXT:
            {
                const editor = vscode.window.activeTextEditor;
                const type = message.data.type;

                if (type === 'currentFile') {
                    if (!editor) {
                        // No file is open
                        await post({
                            command: 'error',
                            content: 'No active text editor found.'
                        });
                        return;
                    }

                    const document = editor.document;
                    const fileName = document.fileName.split(/[\\/]/).pop(); // Get just "script.js"
                    const fileContent = document.getText();
                    const languageId = document.languageId;

                    // Send back to Frontend to "attach" it
                    await post({
                        command: 'fileContextAdded', // We reuse your existing listener logic
                        content: {
                            name: fileName,
                            text: fileContent,
                            language: languageId,
                            type: 'file',
                            path: document.uri.fsPath
                        }
                    });

                }
                // --- B. ACTIVE SELECTION ---
                else if (type === 'selection') {
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) {
                        vscode.window.showWarningMessage("No active editor found.");
                        return;
                    }

                    const selection = editor.selection;
                    const text = editor.document.getText(selection);

                    if (!text) {
                        vscode.window.showInformationMessage("No text selected.");
                        return;
                    }

                    // We create a "virtual" filename for the selection
                    const fileName = path.basename(editor.document.fileName);

                    await post({
                        command: 'fileContextAdded',
                        content: {
                            name: `Selection (${fileName})`, // e.g. "Selection (script.ts)"
                            text: text,
                            language: editor.document.languageId,
                            path: editor.document.uri.fsPath
                        }
                    });
                }
                // --- C. PICK FILE (Workspace File Picker) ---
                else if (type === 'pickFile') {
                    // Fetch all files in the workspace excluding common hidden/build folders
                    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}');
                    const quickPickItems = files.map(uri => ({
                        label: vscode.workspace.asRelativePath(uri),
                        description: path.basename(uri.fsPath),
                        uri: uri
                    }));

                    const selectedItems = await vscode.window.showQuickPick(quickPickItems, {
                        canPickMany: true,
                        placeHolder: 'Select workspace files to attach (multi-select allowed)',
                        matchOnDescription: true,
                        title: 'Select files to attach to chat'
                    });

                    if (selectedItems && selectedItems.length > 0) {
                        const uris = selectedItems.map(item => item.uri);
                        // Loop through all selected files
                        for (const uri of uris) {
                            try {
                                const fileName = path.basename(uri.fsPath);
                                const fileExt = fileName.split('.').pop()?.toLowerCase();

                                let fileContent = "";
                                let language = "";

                                // --- A. CHECK FOR BINARIES ---
                                if (fileExt === 'pdf') {
                                    // Use our new binary handler
                                    const extractedText = await processBinaryFile(uri);
                                    if (extractedText) {
                                        fileContent = extractedText;
                                        language = "markdown"; // PDFs are just text, MD is a safe fallback
                                    }
                                }
                                // --- B. CHECK FOR IMAGES (Supported Now) ---
                                else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fileExt || '')) {
                                    // Read file as Buffer
                                    const fileData = await vscode.workspace.fs.readFile(uri);
                                    const base64 = Buffer.from(fileData).toString('base64');
                                    // mime type (simple check)
                                    const mime = fileExt === 'jpg' ? 'jpeg' : fileExt;
                                    const dataUrl = `data:image/${mime};base64,${base64}`;

                                    // Send to Frontend
                                    await post({
                                        command: CHAT_COMMANDS.IMAGE_CONTEXT_ADDED,
                                        content: {
                                            name: fileName,
                                            dataUrl: dataUrl
                                        }
                                    });
                                    continue; // Skip the text file handling
                                }
                                // --- C. DEFAULT: TEXT FILES ---
                                else {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    fileContent = doc.getText();
                                    language = doc.languageId;
                                }

                                // Send result to frontend
                                await post({
                                    command: 'fileContextAdded',
                                    content: {
                                        name: fileName,
                                        text: fileContent,
                                        language: language,
                                        path: uri.fsPath
                                    }
                                });

                            } catch (error) {
                                console.error(`Failed to read file: ${uri.fsPath}`, error);
                                vscode.window.showErrorMessage(`Failed to attach ${path.basename(uri.fsPath)}`);
                            }
                        }
                    }
                }

                // --- D. PROBLEMS ---
                else if (type === 'problems') {
                    const diagnostics = vscode.languages.getDiagnostics();
                    let problemsText = "";

                    for (const [uri, problems] of diagnostics) {
                        if (problems.length === 0) { continue; }

                        const relativePath = vscode.workspace.asRelativePath(uri);
                        problemsText += `File: ${relativePath}\n`;

                        problems.forEach(p => {
                            problemsText += `  - [${vscode.DiagnosticSeverity[p.severity]}] Line ${p.range.start.line + 1}: ${p.message}\n`;
                        });
                        problemsText += "\n";
                    }

                    if (!problemsText) {
                        problemsText = "No problems found in the workspace.";
                    }

                    // Send back to frontend
                    await post({
                        command: CHAT_COMMANDS.PROBLEM_CONTEXT_ADDED,
                        content: {
                            name: "Workspace Problems",
                            text: problemsText,
                            language: "markdown", // It's a text summary
                            type: 'problems',
                            path: null
                        }
                    });
                }
                // --- E. TERMINAL ---
                else if (type === 'terminal') {
                    const terminal = vscode.window.activeTerminal;
                    if (!terminal) {
                        vscode.window.showWarningMessage("No active terminal found.");
                        return;
                    }

                    // Use shell integration to read recent output if available
                    let terminalText = '';
                    try {
                        // VS Code 1.93+ supports shellIntegration
                        const execution = (terminal as any).shellIntegration?.read?.();
                        if (execution) {
                            terminalText = execution;
                        }
                    } catch {
                        // fallback
                    }

                    if (!terminalText) {
                        // Fallback: note that terminal name/state is available
                        terminalText = `Active terminal: "${terminal.name}"\n\nNote: Terminal output capture requires VS Code 1.93+ with shell integration enabled.\nYou can copy-paste the relevant terminal output directly into the chat.`;
                    }

                    await post({
                        command: 'fileContextAdded',
                        content: {
                            name: `Terminal: ${terminal.name}`,
                            text: terminalText,
                            language: 'shellscript',
                            type: 'terminal',
                            path: null
                        }
                    });
                }
                // --- E. WORKSPACE ---
                else if (type === 'workspace') {
                    const workspaceFiles = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}');
                    
                    if (workspaceFiles.length === 0) {
                        await post({
                            command: 'fileContextAdded',
                            content: {
                                name: "Workspace",
                                text: "No files found in the current workspace.",
                                language: "markdown",
                                type: 'workspace'
                            }
                        });
                        return;
                    }

                    // Build a tree representation
                    // We sort by file path to group folder contents together
                    const paths = workspaceFiles.map(uri => vscode.workspace.asRelativePath(uri)).sort();
                    
                    let treeOutput = "Project File Tree:\n";
                    let currentPathParts: string[] = [];
                    
                    for (const p of paths) {
                        const parts = p.split(/[\\/]/);
                        const fileName = parts.pop();
                        
                        // Find common prefix length with previous path
                        let commonLen = 0;
                        while (commonLen < parts.length && commonLen < currentPathParts.length && parts[commonLen] === currentPathParts[commonLen]) {
                            commonLen++;
                        }
                        
                        // Print new directories
                        for (let i = commonLen; i < parts.length; i++) {
                            treeOutput += '  '.repeat(i) + '📁 ' + parts[i] + '/\n';
                        }
                        
                        // Print file
                        treeOutput += '  '.repeat(parts.length) + '📄 ' + fileName + '\n';
                        
                        currentPathParts = parts;
                    }

                    await post({
                        command: 'fileContextAdded',
                        content: {
                            name: "Workspace",
                            text: treeOutput,
                            language: "markdown",
                            type: 'workspace',
                            path: null
                        }
                    });
                }

                break;
            }

        case 'chatToolApproval':
            {
                const { toolCallId, approved } = message.data;
                if (approved) {
                    await ReviewManager.getInstance().commitAll();
                } else {
                    ReviewManager.getInstance().discardAll();
                }
                ApprovalService.getInstance().resolveApproval(toolCallId, approved);
                break;
            }

        case 'chatReviewDiff':
            {
                const { toolCallId, toolName, args, isGlobalReview } = message.data;
                
                if (isGlobalReview) {
                    // Global review — send all staged data to open review panel
                    const filesData = buildReviewFilesData();
                    await post({
                        command: CHAT_COMMANDS.REVIEW_HUNKS_DATA,
                        content: filesData,
                        openPanel: true // Signal frontend to open the panel
                    });
                } else {
                    outputChannel.appendLine(`Received chatReviewDiff for tool: ${toolName}`);
                    // Re-reveal the existing review
                    await handleInlineReview(toolCallId, toolName, args);
                }
                break;
            }

        case CHAT_COMMANDS.CHAT_REVIEW_HUNKS:
            {
                const filesData = buildReviewFilesData();

                await post({
                    command: CHAT_COMMANDS.REVIEW_HUNKS_DATA,
                    content: filesData,
                    openPanel: true
                });
                break;
            }

        case CHAT_COMMANDS.COMMIT_SELECTED_HUNKS:
            {
                const { action } = message.data;
                outputChannel.appendLine(`[Review] Action: ${action}`);
                
                if (action === 'discard') {
                    await ReviewManager.getInstance().discardAll();
                    vscode.window.showInformationMessage('All changes reverted.');
                } else if (action === 'commit') {
                    await ReviewManager.getInstance().commitAll();
                    vscode.window.showInformationMessage('All changes accepted.');
                }
                
                // Notify webview
                await post({
                    command: CHAT_COMMANDS.REVIEW_HUNKS_DATA,
                    content: []
                });
                break;
            }

        case 'acceptFile':
            {
                const { uri } = message.data;
                const fileUri = vscode.Uri.parse(uri);
                const reviewManager = ReviewManager.getInstance();
                reviewManager.acceptAllForFile(fileUri.toString());
                vscode.window.showInformationMessage('Changes accepted in ' + path.basename(fileUri.fsPath));
                
                // Update the review window
                const count = reviewManager.getTotalPendingCount();
                if (count === 0) {
                    await post({ command: CHAT_COMMANDS.REVIEW_HUNKS_DATA, content: [] });
                } else {
                    const filesData = buildReviewFilesData();
                    await post({ command: CHAT_COMMANDS.REVIEW_HUNKS_DATA, content: filesData });
                }
                break;
            }
        
        case 'rejectFile':
            {
                const { uri } = message.data;
                const fileUri = vscode.Uri.parse(uri);
                const reviewManager = ReviewManager.getInstance();
                await reviewManager.revertAllForFile(fileUri.toString());
                vscode.window.showInformationMessage('Changes reverted in ' + path.basename(fileUri.fsPath));
                
                // Update the review window
                const count = reviewManager.getTotalPendingCount();
                if (count === 0) {
                    await post({ command: CHAT_COMMANDS.REVIEW_HUNKS_DATA, content: [] });
                } else {
                    const filesData = buildReviewFilesData();
                    await post({ command: CHAT_COMMANDS.REVIEW_HUNKS_DATA, content: filesData });
                }
                break;
            }

        case CHAT_COMMANDS.CHAT_TOGGLE_HUNK:
            {
                // Legacy — no-op in direct-write model
                break;
            }

        case CHAT_COMMANDS.CHAT_OPEN_FILE:
            {
                const { uri } = message.data;
                let fileUri: vscode.Uri;

                // Handle both full URIs (file:///...) and relative workspace paths
                if (uri.startsWith('file:') || uri.startsWith('/') || /^[a-zA-Z]:/.test(uri)) {
                    fileUri = uri.startsWith('file:') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                } else {
                    // Relative path — resolve against workspace root
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    fileUri = vscode.Uri.file(path.join(workspaceRoot, uri));
                }
                
                const reviewManager = ReviewManager.getInstance();
                const pendingEdits = reviewManager.getPendingEdits(fileUri.toString());
                if (pendingEdits && pendingEdits.length > 0) {
                    const originalUri = fileUri.with({ scheme: DiffContentProvider.scheme });
                    const originalContent = reviewManager.getOriginalContent(fileUri) ?? '';
                    DiffContentProvider.getInstance().updateContent(originalUri, originalContent);
                    
                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        originalUri,
                        fileUri,
                        `${path.basename(fileUri.fsPath)} (Review Changes)`
                    );
                } else {
                    await vscode.window.showTextDocument(fileUri);
                }
                break;
            }

        case CHAT_COMMANDS.CHAT_CHUNK_ACK:
            {
                const seq = message.data.seq;
                const resolver = chunkAcks.get(seq.toString());
                if (resolver) {
                    resolver(true);
                    chunkAcks.delete(seq.toString());
                }
                break;
            }

        case 'refreshIndex':
            {
                const chatId = message.data?.chatId;
                const { WorkspaceIndexService } = require('../services/workspace-index');
                const wsIndex = WorkspaceIndexService.getInstance();
                await wsIndex.refresh(chatId);
                const fileCount = wsIndex.getFileList().length;
                const fileList = wsIndex.getFileList();
                outputChannel.appendLine(`[Index] Manual refresh: ${fileCount} files indexed.`);
                
                await post({
                    command: 'indexUpdate',
                    content: { fileCount, lastUpdated: new Date().toISOString(), fileList }
                });
                
                vscode.window.showInformationMessage(`Workspace index refreshed: ${fileCount} files indexed.`);
                // Do not dispose the singleton
                break;
            }

        case 'viewIndex':
            {
                const chatId = message.data?.chatId;
                const { WorkspaceIndexService } = require('../services/workspace-index');
                const wsIndex = WorkspaceIndexService.getInstance();
                await wsIndex.refresh(chatId);
                const fileCount = wsIndex.getFileList().length;
                const fileList = wsIndex.getFileList();

                await post({
                    command: 'indexUpdate',
                    content: { fileCount, lastUpdated: new Date().toISOString(), fileList, showViewer: true }
                });
                // Do not dispose the singleton
                break;
            }

        case 'improvePrompt':
            {
                const userDraft = message.data.prompt;
                const { WorkspaceIndexService } = require('../services/workspace-index');
                const wsIndex = WorkspaceIndexService.getInstance();
                await wsIndex.refresh();
                const fileTree = wsIndex.getCompactTreeString().substring(0, 3000);
                // Do not dispose the singleton

                const { aiRequest } = require('../api/ai');
                const appSettings = settingsManager.getSettings();
                const model = appSettings.models.textModel;
                const customModel = (appSettings.customModels || []).find((cm: any) => cm.name === model);

                const provider = customModel?.provider || appSettings.models.provider;
                const pConfig = appSettings.models.providerSettings?.[provider] || {};

                const apiKey = customModel?.apiKey || pConfig.apiKey || appSettings.models.apiKey || '';
                const baseUrl = customModel?.baseUrl || pConfig.baseUrl || '';

                outputChannel.appendLine(`[ImprovePrompt] Optimizing draft: "${userDraft.substring(0, 50)}..."`);

                try {
                    const result = await aiRequest([
                        { role: 'system', content: `You are a prompt optimizer. Given a user's draft prompt and their project file tree, rewrite it to be clearer, more specific, and actionable for an AI coding assistant. Output ONLY the improved prompt text, nothing else. Do not use quotes around the output.` },
                        { role: 'user', content: `Draft prompt: "${userDraft}"\n\nProject files:\n${fileTree}` }
                    ], model, apiKey, 0.7, provider, baseUrl);

                    await post({
                        command: 'improvedPrompt',
                        content: result.content
                    });
                } catch (e) {
                    outputChannel.appendLine(`[ImprovePrompt] Error: ${e}`);
                    await post({
                        command: 'improvedPrompt',
                        content: userDraft // Return original on error
                    });
                }
                break;
            }

        case 'suggestPrompts':
            {
                const { WorkspaceIndexService } = require('../services/workspace-index');
                const wsIndex = WorkspaceIndexService.getInstance();
                await wsIndex.refresh();
                const fileTree = wsIndex.getCompactTreeString().substring(0, 3000);
                // Do not dispose the singleton

                const { aiRequest } = require('../api/ai');
                const appSettings = settingsManager.getSettings();
                const model = appSettings.models.textModel;
                const customModel = (appSettings.customModels || []).find((cm: any) => cm.name === model);

                const provider = customModel?.provider || appSettings.models.provider;
                const pConfig = appSettings.models.providerSettings?.[provider] || {};

                const apiKey = customModel?.apiKey || pConfig.apiKey || appSettings.models.apiKey || '';
                const baseUrl = customModel?.baseUrl || pConfig.baseUrl || '';

                outputChannel.appendLine(`[SuggestPrompts] Generating prompt ideas...`);

                try {
                    const result = await aiRequest([
                        { role: 'system', content: `You are a prompt optimizer. Analyze the project file tree and suggest 3 short, actionable tasks the user might want to do next. Output ONLY the 3 suggestions as a JSON array of strings.` },
                        { role: 'user', content: `Project files:\n${fileTree}` }
                    ], model, apiKey, 0.7, provider, baseUrl);

                    let suggestions: string[] = [];
                    try {
                        const cleaned = (result.content || '').replace(/```json\s*/g, '').replace(/```/g, '').trim();
                        suggestions = JSON.parse(cleaned);
                    } catch {
                        suggestions = ['Fix any open issues in the codebase', 'Add documentation to key functions', 'Optimize performance of the main module'];
                    }

                    await post({
                        command: 'suggestPromptsResult',
                        suggestions
                    });
                } catch (e) {
                    outputChannel.appendLine(`[SuggestPrompts] Error: ${e}`);
                    await post({
                        command: 'suggestPromptsResult',
                        suggestions: ['Fix any open issues in the codebase', 'Add documentation to key functions', 'Optimize performance of the main module']
                    });
                }
                break;
            }

        case 'checkEssenceStatus':
            {
                try {
                    const { WorkspaceIndexService } = require('../services/workspace-index');
                    await post({
                        command: 'essenceStatus',
                        content: WorkspaceIndexService.getInstance().getEssenceStatus()
                    });
                } catch (e) {
                    outputChannel.appendLine(`[Essence] Check status failed: ${e}`);
                }
                break;
            }

        // Handle other messages here
        default:
            outputChannel.appendLine('Unknown message received:' + message);
    }
}

function formatMessageWithFiles(originalMessage: string, files: any[]): string {
    let fullMessage = originalMessage;

    if (files && Array.isArray(files) && files.length > 0) {
        fullMessage += "\n\n--- ATTACHED CONTEXT ---\n";

        files.forEach((file: any) => {
            fullMessage += `\nFile: ${file.name}\n`;
            // Wrap content in Markdown code blocks
            fullMessage += "```" + (file.language || '') + "\n";
            fullMessage += (file.content || '') + "\n";
            fullMessage += "```\n";
        });
    }
    return fullMessage;
}

export async function handleInlineReview(
    toolCallId?: string, 
    toolName?: string, 
    args?: any
) {
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        
        let fileUri: vscode.Uri | undefined;

        // A. Global Review Mode (User clicked "Review All")
        if (!args || !args.filePath && !args.TargetFile) {
            const reviewManager = ReviewManager.getInstance();
            const stagedUris = Array.from(reviewManager.getStagedUris());
            if (stagedUris.length === 0) {
                vscode.window.showInformationMessage('No pending changes.');
                return;
            }
            fileUri = stagedUris[0];
        } else {
            // B. Specific Tool Review — open the edited file
            const filePathParam = args.filePath || args.TargetFile;
            const filePath = path.isAbsolute(filePathParam) ? filePathParam : path.join(workspaceRoot, filePathParam);
            fileUri = vscode.Uri.file(filePath);
        }

        if (!fileUri) { return; }
        
        const reviewManager = ReviewManager.getInstance();
        const pendingEdits = reviewManager.getPendingEdits(fileUri.toString());
        if (pendingEdits && pendingEdits.length > 0) {
            const originalUri = fileUri.with({ scheme: DiffContentProvider.scheme });
            const originalContent = reviewManager.getOriginalContent(fileUri) ?? '';
            DiffContentProvider.getInstance().updateContent(originalUri, originalContent);
            
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                fileUri,
                `${path.basename(fileUri.fsPath)} (Review Changes)`
            );
            outputChannel.appendLine(`[InlineReview] Opened diff editor for ${path.basename(fileUri.fsPath)}`);
        } else {
            await vscode.window.showTextDocument(fileUri);
            outputChannel.appendLine(`[InlineReview] Opened ${path.basename(fileUri.fsPath)} for inline review`);
        }
    } catch (e) {
        outputChannel.appendLine(`[InlineReview] Error: ${e}`);
    }
}
