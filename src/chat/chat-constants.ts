// VARIABLES


export const HISTORY_FILENAME = 'chat_history.json';

export const LIBRARY_FOLDER = 'libraries';
export const CHATBOX_FOLDER = 'chatbox';
export const INDEX_HTML = 'chatbox.html';

export const FILES_TO_LOAD = [
  { name: 'history.js', placeholder: '{{scriptHistoryPath}}' },
  { name: 'history.css', placeholder: '{{styleHistoryPath}}' },
  // Split CSS
  { name: 'chat-base.css', placeholder: '{{cssBase}}' },
  { name: 'chat-layout.css', placeholder: '{{cssLayout}}' },
  { name: 'chat-input.css', placeholder: '{{cssInput}}' },
  { name: 'chat-widgets.css', placeholder: '{{cssWidgets}}' },
  { name: 'chat-agentic.css', placeholder: '{{cssAgentic}}' },
  { name: 'chat-ui.css', placeholder: '{{cssUi}}' },
  { name: 'chat-hunk.css', placeholder: '{{cssHunk}}' },
  { name: 'chat-index.css', placeholder: '{{cssIndex}}' },
  { name: 'chat-misc.css', placeholder: '{{cssMisc}}' },
  // Split JS
  { name: 'chat-globals.js', placeholder: '{{jsGlobals}}' },
  { name: 'chat-scroll.js', placeholder: '{{jsScroll}}' },
  { name: 'chat-ui.js', placeholder: '{{jsUi}}' },
  { name: 'chat-attachments.js', placeholder: '{{jsAttachments}}' },
  { name: 'chat-messages.js', placeholder: '{{jsMessages}}' },
  { name: 'chat-agentic.js', placeholder: '{{jsAgentic}}' },
  { name: 'chat-staging.js', placeholder: '{{jsStaging}}' },
  { name: 'chat-index.js', placeholder: '{{jsIndex}}' },
  { name: 'chat-process.js', placeholder: '{{jsProcess}}' },
  { name: 'chat-events.js', placeholder: '{{jsEvents}}' },
];

export const LIBRARIES_TO_LOAD = [
  { name: 'htmx.min.js', folderName: 'htmx', placeholder: '{{htmxSriptPath}}' },
  { name: 'ace.min.js', folderName: 'ace', placeholder: '{{aceScriptPath}}' },
  { name: 'ace.min.css', folderName: 'ace', placeholder: '{{aceStylePath}}' },
  { name: 'marked.umd.js', folderName: 'marked', placeholder: '{{markedScriptPath}}' },
  { name: 'default.min.css', folderName: 'highlight', placeholder: '{{highlightStylePath}}' },
  { name: 'highlight.min.js', folderName: 'highlight', placeholder: '{{highlightScriptPath}}' },
  { name: 'go.min.js', folderName: 'highlight', placeholder: '{{highlightGoScriptPath}}' },
  { name: 'python.min.js', folderName: 'highlight', placeholder: '{{highlightPythonScriptPath}}' },
  { name: 'javascript.min.js', folderName: 'highlight', placeholder: '{{highlightJsScriptPath}}' },
  { name: 'typescript.min.js', folderName: 'highlight', placeholder: '{{highlightTsScriptPath}}' },
  { name: 'cpp.min.js', folderName: 'highlight', placeholder: '{{highlightCppScriptPath}}' },
  { name: 'rust.min.js', folderName: 'highlight', placeholder: '{{highlightRustScriptPath}}' },
  { name: 'ruby.min.js', folderName: 'highlight', placeholder: '{{highlightRubyScriptPath}}' },
  { name: 'java.min.js', folderName: 'highlight', placeholder: '{{highlightJavaScriptPath}}' },
];


// ENUMS
export enum ROLE {
  USER = 'user',
  BOT = 'bot',
}


// commands messages for chat webview and extension
export enum CHAT_COMMANDS {
  CHAT_WEBVIEW_READY = 'ChatWebviewReady',
  CHAT_RESET = 'resetChat',
  CHAT_REQUEST = 'chatRequest',
  CHAT_LOAD = 'loadChat',
  HISTORY_LOAD = 'loadHistory',
  HISTORY_CLEAR = 'clearHistory',
  CONVERSATION_DELETE = 'deleteHistoryItem',
  HISTORY_SEARCH = 'searchHistory',
  ADD_CONTEXT = 'addContext',
  FILE_CONTEXT_ADDED = 'fileContextAdded',
  PROBLEM_CONTEXT_ADDED = 'problemContextAdded',
  OPEN_IMAGE = 'openImage',
  IMAGE_CONTEXT_ADDED = 'imageContextAdded',
  CHAT_STREAM_START = 'chatStreamStart',
  CHAT_STREAM_CHUNK = 'chatStreamChunk',
  CHAT_STREAM_END = 'chatStreamEnd',
  CHAT_UNDO = 'chatUndo',
  CHAT_AGENT_STEP = 'chatAgentStep',
  CHAT_APPROVAL_UPDATE = 'chatApprovalUpdate',
  CHAT_CHUNK_ACK = 'chatChunkAck',
  CHAT_ID_UPDATE = 'chatIdUpdate',
  CHAT_USAGE_UPDATE = 'chatUsageUpdate',
  CHAT_REVIEW_HUNKS = 'chatReviewHunks',
  COMMIT_SELECTED_HUNKS = 'commitSelectedHunks',
  REVIEW_HUNKS_DATA = 'reviewHunksData',
  CHAT_TOGGLE_HUNK = 'chatToggleHunk',
  CHAT_OPEN_FILE = 'chatOpenFile',
  CHAT_STATE_REHYDRATE = 'chatStateRehydrate',
  CHAT_CONTINUE_PROMPT = 'chatContinuePrompt',
  CHAT_CONTINUE = 'chatContinue'
}



export interface StoredMessage {
  message_id: string;       // Unique ID for every message
  role: ROLE;
  message: string;
  timestamp: string;
  images?: string[];
  imageDescriptions?: string[]; // Cached descriptions for fallback/memory
  files?: any[]; // Lightweight file metadata (name, path) without large content
  agentSteps?: any[]; // Metadata/tool calls/thinking steps associated with this message
  tokensUsed?: number;
}


export interface Conversation {
  chat_id: string;       // The chat_id
  title: string;    // Title (e.g. "How to use React")
  timestamp: string; // Last modified time
  messages: StoredMessage[];
  agentId?: string;  // ID of the agent used for this chat
  totalTokens?: number; // Total tokens used so far in this chat
}


export const COMMANDS = [
  { label: '@workspace', description: 'Search across workspace' },
  { label: '@problems', description: 'Attach workspace diagnostics' },
  { label: '@selection', description: 'Attach current editor selection' },
  { label: '@terminal', description: 'Capture terminal output' },
];

export const WORKFLOWS = [
  // { label: '/fix', description: 'Suggest a fix for code' },
  // { label: '/explain', description: 'Explain code' },
  // { label: '/refactor', description: 'Refactor code' },
  // { label: '/optimize', description: 'Optimize code' },
  // { label: '/test', description: 'Generate unit tests' },
];

