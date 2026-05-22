import * as vscode from 'vscode';
import { ROLE, StoredMessage, Conversation } from "./chat-constants";
import { ImageStorageService } from './image-storage';


export class ChatHistoryService {


    private static readonly STORAGE_KEY = 'spes_chat_history_v1';

    // Dependency Injection: We inject the storage mechanism here.
    // context.globalState implements vscode.Memento
    constructor(
        private readonly storage: vscode.Memento,
        private readonly imageService: ImageStorageService) { }


    /**
     * Generating a simple unique ID
     */
    private static generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /**
     * Get all raw history
     */
    public getHistory(): Conversation[] {
        return this.storage.get<Conversation[]>(ChatHistoryService.STORAGE_KEY, []);
    }


    /**
     * Get a specific conversation by ID
     */
    public getConversation(chatId: string): Conversation | undefined {
        return this.getHistory().find(c => c.chat_id === chatId);
    }


    /**
     * Clear all history
     */
    public async clear(): Promise<void> {
        const history = this.getHistory();

        for (const chat of history) {
            for (const msg of chat.messages) {
                if (msg.images && msg.images.length > 0) {
                    for (const fileName of msg.images) {
                        await this.imageService.deleteImage(fileName);
                    }
                }
            }
        }

        await this.storage.update(ChatHistoryService.STORAGE_KEY, []);
    }



    /**
     * Main Logic: Save a message
     */
    public async addMessage(chatId: string, role: ROLE, messageText: string, images: string[] = [], imageDescriptions: string[] = [], agentId?: string, agentSteps?: any[], files?: any[], tokensUsed?: number): Promise<StoredMessage> {
        let history = this.getHistory();
        const timestamp = new Date().toISOString();
        let chatIndex = history.findIndex(c => c.chat_id === chatId);

        // Create the message object
        const newMessage: StoredMessage = {
            message_id: ChatHistoryService.generateId(),
            role: role,
            message: messageText,
            timestamp: timestamp,

            images: images, // <--- Save the filenames
            imageDescriptions: imageDescriptions,
            files: files,
            agentSteps: agentSteps,
            tokensUsed: tokensUsed || undefined
        };

        if (chatIndex === -1) {
            // --- Create New Chat ---
            const newChat: Conversation = {
                chat_id: chatId,
                // Title logic: User message = title, AI message = "New Chat"
                title: role === ROLE.USER ? messageText.substring(0, 100) : "New Chat",
                timestamp: timestamp,
                messages: [newMessage],
                agentId: agentId,
                totalTokens: tokensUsed || 0
            };
            // Add to top
            history.unshift(newChat);
        } else {
            // --- Update Existing Chat ---
            const chat = history[chatIndex];
            chat.messages.push(newMessage);
            chat.timestamp = timestamp;
            
            // If an agentId is provided and the chat doesn't have one (or it changed), update it
            if (agentId && chat.agentId !== agentId) {
                chat.agentId = agentId;
            }

            // Update title if it's still generic and the user typed something
            if (chat.title === "New Chat" && role === ROLE.USER) {
                chat.title = messageText.substring(0, 100);
            }

            // Accumulate tokens
            if (tokensUsed) {
                chat.totalTokens = (chat.totalTokens || 0) + tokensUsed;
            }

            // Move to top (Most Recent)
            history.splice(chatIndex, 1);
            history.unshift(chat);
        }
        this.enforceStorageLimit(history);
        await this.storage.update(ChatHistoryService.STORAGE_KEY, history);
        return newMessage;
    }
    /**
     * Removes oldest chats if history exceeds ~800KB (Safety Buffer)
     */
    private enforceStorageLimit(history: Conversation[]) {
        const MAX_SIZE_BYTES = 1000 * 1024; // 1MB target

        // Rough estimation of size
        let currentSize = JSON.stringify(history).length;

        // While we are over the limit and have chats to delete...
        while (currentSize > MAX_SIZE_BYTES && history.length > 0) {
            // Remove the LAST element (The oldest chat, since we unshift new ones to 0)
            const removed = history.pop();
            console.log(`[Storage Saver] Deleted old chat: ${removed?.title}`);

            // Recalculate
            currentSize = JSON.stringify(history).length;
        }
    }

    /**
     * DELETE a specific conversation
     */
    public async deleteConversation(chatId: string): Promise<void> {
        let history = this.getHistory();

        const chatToDelete = history.find(c => c.chat_id === chatId);

        if (chatToDelete) {
            // 2. Loop through all messages in this chat
            for (const msg of chatToDelete.messages) {
                // 3. If message has images, delete them physically
                if (msg.images && msg.images.length > 0) {
                    for (const fileName of msg.images) {
                        await this.imageService.deleteImage(fileName);
                    }
                }
            }
        }

        // Filter out the specific ID
        const newHistory = history.filter(c => c.chat_id !== chatId);
        await this.storage.update(ChatHistoryService.STORAGE_KEY, newHistory);
    }

    /**
     * Deletes messages from a specific user message index to the end of the conversation.
     * This is far more robust than counting backward from the end, as it ignores un-saved streaming bots.
     */
    public async deleteFromUserMessageIndex(chatId: string, userMsgIndex: number): Promise<string | null> {
        const history = this.getHistory();
        const chatIndex = history.findIndex(c => c.chat_id === chatId);
        if (chatIndex === -1) { return null; }

        const chat = history[chatIndex];
        
        let currentUserIdx = -1;
        let targetMsgIdx = -1;
        for (let i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === ROLE.USER) {
                currentUserIdx++;
                if (currentUserIdx === userMsgIndex) {
                    targetMsgIdx = i;
                    break;
                }
            }
        }

        if (targetMsgIdx === -1) { return null; }

        const removed = chat.messages.splice(targetMsgIdx);

        for (const msg of removed) {
            if (msg.images && msg.images.length > 0) {
                for (const fileName of msg.images) {
                    await this.imageService.deleteImage(fileName);
                }
            }
        }

        const targetUserMsg = removed[0];
        await this.storage.update(ChatHistoryService.STORAGE_KEY, history);
        return targetUserMsg?.message ?? null;
    }

    /**
     * Deletes the last N messages from a conversation (for Retry fallback).
     * Returns the text of the last user message so it can be re-submitted.
     */
    public async deleteLastMessages(chatId: string, count: number = 2): Promise<string | null> {
        const history = this.getHistory();
        const chatIndex = history.findIndex(c => c.chat_id === chatId);
        if (chatIndex === -1) { return null; }

        const chat = history[chatIndex];
        const removed = chat.messages.splice(-count, count);

        // Clean up any images from removed messages
        for (const msg of removed) {
            if (msg.images && msg.images.length > 0) {
                for (const fileName of msg.images) {
                    await this.imageService.deleteImage(fileName);
                }
            }
        }

        // The last user message is the one we want to re-submit
        const lastUserMsg = removed.find(m => m.role === ROLE.USER);
        await this.storage.update(ChatHistoryService.STORAGE_KEY, history);
        return lastUserMsg?.message ?? null;
    }


    /**
     * SEARCH history
     * Returns formatted groups matching the query
     */
    public searchHistory(query: string) {
        const history = this.getHistory();
        const lowerQuery = query.toLowerCase();

        // Filter logic: Check title OR message content
        const filtered = history.filter(chat => {
            const titleMatch = chat.title.toLowerCase().includes(lowerQuery);
            // Optional: Deep search inside messages (can be slow if history is huge)
            // const msgMatch = chat.messages.some(m => m.message.toLowerCase().includes(lowerQuery));
            return titleMatch; // || msgMatch;
        });

        // Reuse your existing formatting logic for the filtered result
        return this.formatGroups(filtered);
    }

    /**
     * Format Data for Webview
     * This returns the data structure the frontend needs, 
     * instead of sending the message directly. Separation of concerns!
     */
    /**
     * Refactored Formatting Helper
     * (Move your existing getFormattedHistoryGroups logic here so 'search' can use it too)
     */
    private formatGroups(historyList: Conversation[]) {
        const groups: { [key: string]: any[] } = {};

        historyList.forEach(chat => {
            const date = new Date(chat.timestamp);
            let dateKey = date.toDateString();
            if (dateKey === new Date().toDateString()) dateKey = "Today";

            if (!groups[dateKey]) groups[dateKey] = [];

            groups[dateKey].push({
                id: chat.chat_id,
                title: chat.title,
                time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        });

        return Object.keys(groups).map(dateTitle => ({
            title: dateTitle,
            chats: groups[dateTitle]
        }));
    }

    public getFormattedHistoryGroups() {
        return this.formatGroups(this.getHistory());
    }

    /**
     * Get the last N messages for context.
     * We slice the array to get the most recent conversation turns.
     */
    public getContextWindow(chatId: string, limit: number): { role: string; content: string }[] {
        const conversation = this.getConversation(chatId);
        if (!conversation) { return []; };

        // 1. Get the last N messages
        const lastMessages = conversation.messages.slice(-limit);

        // 2. Map internal roles to OpenAI roles
        // Internal: 'bot' -> OpenAI: 'assistant'
        // Internal: 'user' -> OpenAI: 'user'
        return lastMessages.map(msg => {
            let content = msg.message;
            if (msg.imageDescriptions && msg.imageDescriptions.length > 0) {
                const descText = msg.imageDescriptions.map((d, i) => `[Image ${i + 1} Description: ${d}]`).join("\n");
                content += `\n\n${descText}`;
            }

            return {
                role: msg.role === ROLE.BOT ? 'assistant' : 'user',
                content: content
            };
        });
    }
}

