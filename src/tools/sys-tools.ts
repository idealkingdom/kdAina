import { tool as _tool } from 'ai';
const tool = _tool as any;
import { z } from 'zod';
import { CommandAuditService } from '../services/command-audit';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { outputChannel } from '../logger';
import { ReviewManager } from '../chat/review-manager';
import { ChatViewProvider } from '../chat/chat-view-provider';
import { SettingsManager } from '../services/settings-manager';

// ─── Persistent AI Terminal ─────────────────────────────────────────
// Uses a REAL shell terminal (not pseudoterminal) for full interactivity.
// Users can type, Ctrl+C, run their own commands — it's a real shell.
// AI commands execute via sendText() and capture output via temp files.
let aiTerminal: vscode.Terminal | undefined;

// ─── Background Terminal Registry ───────────────────────────────────
// Supports multiple concurrent background processes (e.g., frontend + backend + DB).
// Each entry is keyed by a unique label derived from the command.
interface BgTerminalEntry {
    terminal: vscode.Terminal;
    command: string;
    cwd: string;
    startedAt: string;
    port?: number;
    label: string;
    outFile: string;
}
const bgTerminals = new Map<string, BgTerminalEntry>();
const MAX_BG_TERMINALS = 5;
const MAX_BG_OUTPUT_BYTES = 512 * 1024; // 512 KB cap per background output file

/**
 * Strips ANSI escape sequences (colors, font weights, etc.) from terminal outputs.
 */
function stripAnsi(str: string): string {
    if (!str) { return ''; }
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function getOrCreateAITerminal(cwd: string): vscode.Terminal {
    // If the terminal was closed by the user, recreate it
    if (aiTerminal && aiTerminal.exitStatus !== undefined) {
        aiTerminal = undefined;
    }

    if (!aiTerminal) {
        aiTerminal = vscode.window.createTerminal({
            name: 'kdAina',
            cwd
        });
    }

    return aiTerminal;
}

/**
 * Wait for a file to appear on disk (polling).
 */
// ─── Smart Command Completion Detection ────────────────────────────────
// Instead of a dumb 30s wall-clock timeout, this monitors BOTH the exit
// file (command finished) AND the output file (is it still producing data?).
// If output stops growing for STALL_THRESHOLD_MS, we check for known
// patterns (watch mode, interactive prompts) and return early with
// actionable context instead of wasting the full timeout.

const STALL_THRESHOLD_MS = 8000;  // 8s of no new output → stalled
const MAX_ACTIVE_TIMEOUT_MS = 120000; // 120s max if output is still flowing
const DEFAULT_TIMEOUT_MS = 30000; // 30s base timeout

/** Known patterns that indicate a command finished its useful work but the process stays alive */
const STALL_PATTERNS: { pattern: RegExp; type: 'watch_mode' | 'interactive' | 'confirm'; tool: string | null; recovery: string }[] = [
    // Test runners in watch mode
    { pattern: /waiting for file changes/i,         type: 'watch_mode',  tool: 'vitest/jest',  recovery: "Send 'q' via terminal_send_input to exit watch mode." },
    { pattern: /press h to show help.*press q/i,    type: 'watch_mode',  tool: 'vitest',       recovery: "Send 'q' via terminal_send_input to exit watch mode." },
    { pattern: /press.*to quit/i,                   type: 'watch_mode',  tool: 'vitest/jest',  recovery: "Send 'q' via terminal_send_input to exit watch mode." },
    { pattern: /watching for file changes/i,        type: 'watch_mode',  tool: 'nodemon',      recovery: 'Use terminal_send_input with { send_ctrl_c: true } to stop.' },
    { pattern: /webpack.*compiled\s+(success|with)/i, type: 'watch_mode', tool: 'webpack',     recovery: 'Use terminal_send_input with { send_ctrl_c: true } to stop.' },
    { pattern: /watching\s+for\s+changes/i,         type: 'watch_mode',  tool: 'tsc',          recovery: 'Use terminal_send_input with { send_ctrl_c: true } to stop.' },
    // Interactive prompts
    { pattern: /\?\s*(y\/n|yes\/no)\s*:?\s*$/im,    type: 'interactive', tool: null,            recovery: "Use terminal_send_input with { text: 'y\\n' } or { text: 'n\\n' } to respond." },
    { pattern: /\(y\/N\)\s*$/im,                    type: 'confirm',     tool: 'npm',           recovery: "Use terminal_send_input with { text: 'y\\n' } to confirm or { text: 'n\\n' } to decline." },
    { pattern: /password.*:\s*$/im,                 type: 'interactive', tool: null,            recovery: 'The command is waiting for a password. Use terminal_send_input to provide it.' },
    { pattern: /enter\s+.*:\s*$/im,                 type: 'interactive', tool: null,            recovery: 'The command is waiting for input. Use terminal_send_input to provide it.' },
];

/** Patterns to infer exit code from test output (when the process didn't actually exit) */
const TEST_PASS_PATTERNS = [/tests?\s+\d+\s+passed/i, /\d+\s+passing/i, /all tests passed/i, /\bPASS\b\s+\S/];
const TEST_FAIL_PATTERNS = [/tests?\s+\d+\s+failed/i, /\d+\s+failed/i, /\bFAIL\b\s/i, /failures?:\s*[1-9]/i, /AssertionError/i];

/** Analyze partial output: detect stall patterns and infer exit code from test output */
function analyzeOutput(partialOutput: string): { stallPattern: typeof STALL_PATTERNS[0] | null; inferredExitCode: number | null } {
    const tail = partialOutput.slice(-1000);
    const stallPattern = STALL_PATTERNS.find(sp => sp.pattern.test(tail)) || null;

    // IMPORTANT: Check fail BEFORE pass. Mixed results ("5 passed, 2 failed")
    // must infer exitCode=1 — fail always wins over pass.
    const hasFail = TEST_FAIL_PATTERNS.some(p => p.test(partialOutput));
    const hasPass = TEST_PASS_PATTERNS.some(p => p.test(partialOutput));
    const inferredExitCode = hasFail ? 1 : hasPass ? 0 : null;

    return { stallPattern, inferredExitCode };
}

interface CommandCompletionResult {
    completed: boolean;
    partialOutput: string;
    stallDetected: boolean;
    stallPattern: typeof STALL_PATTERNS[0] | null;
    inferredExitCode: number | null;
    elapsedMs: number;
}

function waitForCommandCompletion(
    exitFile: string,
    outFile: string,
    outputChannel: vscode.OutputChannel
): Promise<CommandCompletionResult> {
    return new Promise((resolve) => {
        const start = Date.now();
        let lastSize = 0;
        let stallStart = 0;
        let lastActiveTime = start;

        const interval = setInterval(() => {
            const elapsed = Date.now() - start;

            // ── Check 1: Did the command exit normally? ──
            if (fs.existsSync(exitFile)) {
                clearInterval(interval);
                resolve({
                    completed: true,
                    partialOutput: '',
                    stallDetected: false,
                    stallPattern: null,
                    inferredExitCode: null,
                    elapsedMs: elapsed
                });
                return;
            }

            // ── Check 2: Monitor output file growth ──
            let currentSize = 0;
            try {
                if (fs.existsSync(outFile)) {
                    currentSize = fs.statSync(outFile).size;
                }
            } catch {}

            if (currentSize > lastSize) {
                // Output is still flowing — command is working
                lastSize = currentSize;
                stallStart = 0;
                lastActiveTime = Date.now();
            } else if (currentSize > 0 && !stallStart) {
                // Output just stopped growing — start the stall timer
                stallStart = Date.now();
            }

            // ── Check 3: Stall detection ──
            // If output has been captured but stopped growing for STALL_THRESHOLD_MS,
            // read the tail and check for known patterns
            if (stallStart && (Date.now() - stallStart > STALL_THRESHOLD_MS)) {
                clearInterval(interval);

                let partialOutput = '';
                try {
                    if (fs.existsSync(outFile)) {
                        partialOutput = fs.readFileSync(outFile, 'utf-8').trim();
                    }
                } catch {}

                const analysis = analyzeOutput(partialOutput);
                outputChannel.appendLine(`[run_command] Output stalled after ${elapsed}ms (stall: ${Date.now() - stallStart}ms). Pattern: ${analysis.stallPattern?.type || 'none'}. Inferred exit: ${analysis.inferredExitCode}`);

                resolve({
                    completed: false,
                    partialOutput,
                    stallDetected: true,
                    stallPattern: analysis.stallPattern,
                    inferredExitCode: analysis.inferredExitCode,
                    elapsedMs: elapsed
                });
                return;
            }

            // ── Check 4: Adaptive timeout ──
            // If output is actively growing, allow up to MAX_ACTIVE_TIMEOUT_MS
            // If output never appeared or stalled without patterns, use DEFAULT_TIMEOUT_MS
            const effectiveTimeout = (lastSize > 0 && Date.now() - lastActiveTime < STALL_THRESHOLD_MS)
                ? MAX_ACTIVE_TIMEOUT_MS
                : DEFAULT_TIMEOUT_MS;

            if (elapsed > effectiveTimeout) {
                clearInterval(interval);

                let partialOutput = '';
                try {
                    if (fs.existsSync(outFile)) {
                        partialOutput = fs.readFileSync(outFile, 'utf-8').trim();
                    }
                } catch {}

                const analysis = analyzeOutput(partialOutput);
                outputChannel.appendLine(`[run_command] Hard timeout after ${elapsed}ms. Output size: ${lastSize}. Pattern: ${analysis.stallPattern?.type || 'none'}`);

                resolve({
                    completed: false,
                    partialOutput,
                    stallDetected: false,
                    stallPattern: analysis.stallPattern,
                    inferredExitCode: analysis.inferredExitCode,
                    elapsedMs: elapsed
                });
                return;
            }
        }, 300); // Poll every 300ms
    });
}

// ─── TEST → FIX CYCLE TRACKER ──────────────────────────────────────────
// Tracks test/build commands that fail, enforcing a structured retry loop.
// Key = normalized command string, Value = { count, command }
const testRetryTracker = new Map<string, { count: number; command: string }>();
const MAX_TEST_RETRIES = 3;

// ─── GENERAL CONSECUTIVE FAILURE TRACKER ───────────────────────────────
// Tracks consecutive command failures (any type) to prevent infinite retry
// loops when the terminal is fundamentally broken (e.g., fork bomb, system
// resource exhaustion, stuck process). Resets on any successful command.
let consecutiveFailureCount = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

/** Clear the test retry tracker (call at start of each agentic request). */
/**
 * Executes terminal commands safely by wrapping them in platform-specific sandboxes.
 */
export function clearTestRetryTracker() {
    testRetryTracker.clear();
    consecutiveFailureCount = 0;
}

/**
 * Detect if a command is a test or build command that should enter
 * the structured fix cycle when it fails.
 */
function isTestOrBuildCommand(command: string): boolean {
    const cmd = command.toLowerCase().trim();
    const patterns = [
        // Test runners
        /\b(npm|npx|yarn|pnpm)\s+(run\s+)?test/,
        /\bjest\b/, /\bvitest\b/, /\bmocha\b/, /\bava\b/, /\btap\b/,
        /\bpytest\b/, /\bpython\s+-m\s+(unittest|pytest)/,
        /\bcargo\s+test\b/, /\bgo\s+test\b/, /\bdotnet\s+test\b/,
        /\brspec\b/, /\bphpunit\b/, /\bgradle\s+test\b/, /\bmvn\s+test\b/,
        // Build commands
        /\b(npm|npx|yarn|pnpm)\s+(run\s+)?build/,
        /\btsc\b/, /\bcargo\s+build\b/, /\bgo\s+build\b/,
        /\bmake\b/, /\bcmake\b/, /\bdotnet\s+build\b/,
        /\bgcc\b/, /\bg\+\+\b/, /\brustc\b/,
        // Linting (also benefits from fix cycles)
        /\b(npm|npx|yarn|pnpm)\s+(run\s+)?lint/,
        /\beslint\b/, /\bruff\b/, /\bflake8\b/, /\bmypy\b/,
    ];
    return patterns.some(p => p.test(cmd));
}

/**
 * Normalize a command for tracker lookup (strip volatile parts).
 */
function normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, ' ');
}

/**
 * Generate a human-readable label for a background process from its command.
 * Produces labels like "vite-frontend", "mongod-database", "flask-backend".
 */
function generateBgLabel(command: string): string {
    const cmd = command.toLowerCase().trim();

    // Server type detection: [pattern, label]
    const labelMap: [RegExp, string][] = [
        // Frontend dev servers
        [/\bvite\b/, 'vite-dev'],
        [/\bnext\s+dev\b/, 'next-dev'],
        [/\bng\s+serve\b/, 'angular-dev'],
        [/\bwebpack\s+serve\b/, 'webpack-dev'],
        [/\blive-server\b/, 'live-server'],
        [/\bhttp-server\b/, 'http-server'],
        // Node.js servers
        [/\bnodemon\b/, 'nodemon'],
        [/\bts-node-dev\b/, 'ts-node-dev'],
        [/\bnpm\s+run\s+dev\b/, 'npm-dev'],
        [/\bnpm\s+run\s+start:dev\b/, 'npm-start-dev'],
        [/\bnpm\s+run\s+serve\b/, 'npm-serve'],
        [/\bnpm\s+start\b/, 'npm-start'],
        [/\byarn\s+dev\b/, 'yarn-dev'],
        [/\bpnpm\s+dev\b/, 'pnpm-dev'],
        // Python servers
        [/\buvicorn\b/, 'uvicorn'],
        [/\bgunicorn\b/, 'gunicorn'],
        [/\bflask\s+run\b/, 'flask'],
        [/manage\.py\s+runserver/, 'django'],
        // Database servers
        [/\bmongod\b/, 'mongod'],
        [/\bredis-server\b/, 'redis'],
        [/\bmysqld\b/, 'mysqld'],
        [/\bpg_ctl\b/, 'postgres'],
        [/\bpostgres\b/, 'postgres'],
        // Java / JVM
        [/\bspring-boot:run\b/, 'spring-boot'],
        [/\bgradle\s+bootRun\b/, 'spring-boot'],
        // Docker
        [/\bdocker[-\s]compose\s+up\b/, 'docker-compose'],
        [/\bdocker\s+compose\s+up\b/, 'docker-compose'],
        // Ruby / PHP
        [/\brails\s+(server|s)\b/, 'rails'],
        [/\bphp\s+artisan\s+serve\b/, 'laravel'],
        // Task queues
        [/\bcelery\b/, 'celery-worker'],
    ];

    for (const [pattern, label] of labelMap) {
        if (pattern.test(cmd)) {
            return label;
        }
    }

    // Fallback: extract the first meaningful token
    const tokens = cmd.split(/\s+/).filter(t => !t.startsWith('-') && t !== 'npx' && t !== 'npm' && t !== 'run');
    return tokens[0]?.substring(0, 20) || 'background';
}

/**
 * Classify command risk for smart auto-approval
 */
export function classifyCommandRisk(command: string): 'safe' | 'moderate' | 'dangerous' {
    const cmd = command.trim().toLowerCase();
    
    // SAFE: read-only or build/test commands
    const safePatterns = [
        /^\s*(git\s+(status|log|diff|branch|show|rev-parse))\b/,
        /^\s*(ls|cat|head|tail|wc|grep|find|which|pwd|echo|printf)\b/,
        /^\s*(npm|npx|yarn|pnpm)\s+(run\s+)?(build|test|lint|check|typecheck|format)\b/,
        /^\s*(tsc|eslint|prettier|jest|vitest|pytest|cargo\s+(build|test|check))\b/,
        /^\s*(node|python|ruby|go)\s+.*\.(js|ts|py|rb|go)\b/,  // Running scripts
        /^\s*lsof\b/, /^\s*ps\b/, /^\s*df\b/, /^\s*du\b/,
        /^\s*curl\s+-s\b/,  // Silent curl (fetching, not piping)
    ];
    
    // DANGEROUS: destructive or privileged
    const dangerousPatterns = [
        /\brm\s/i, /\brmdir\b/i,
        /\bmv\s/i,  // Moving files can be destructive
        /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
        /\bchmod\b/i, /\bchown\b/i,
        /\bsudo\b/i,
        /\bcurl\b.*\|/i,  // Curl piped to anything
        /\bwget\b/i,
        />\s*\/(usr|etc|var|boot|sys|proc|dev|root|tmp)\b/i,  // Redirect overwriting system paths
        /\bgit\s+(push|reset\s+--hard|clean\s+-fd)/i,
        // #80: Package installers execute arbitrary code (postinstall scripts, setup.py)
        /\b(npm|yarn|pnpm)\s+install\b/i,
        /\bpip3?\s+install\b/i,
        // #80: Docker can mount host FS, run as root, expose ports
        /\bdocker\s+(run|exec|compose\s+up)\b/i,
        // #80: Arbitrary code execution primitives
        /\beval\b/i, /\bexec\b/i, /\bsource\b/i,
        // #80: Raw device/disk operations
        /\bdd\s+/i,
    ];
    
    // CRITICAL: Check dangerous patterns FIRST (deny-first security model).
    // Chained commands like 'echo test && rm -rf /' must NOT be classified as 'safe'
    // just because 'echo' matches a safe prefix. If ANY part of the command matches
    // a dangerous pattern, it's dangerous — regardless of how it starts.
    if (dangerousPatterns.some(p => p.test(cmd))) { return 'dangerous'; }
    if (safePatterns.some(p => p.test(cmd))) { return 'safe'; }
    return 'moderate';
}

/**
 * Validate that the command does not stray outside the workspace
 */
export function validateCommandScope(command: string, cwd: string, workspaceRoot: string): string | null {
    // Ensure cwd is within the workspace
    const resolvedCwd = path.resolve(cwd);
    if (!resolvedCwd.startsWith(workspaceRoot)) {
        return `Working directory "${cwd}" is outside the workspace. Commands must run within ${workspaceRoot}.`;
    }
    
    // #78: Build the system path regex dynamically — never hardcode a username.
    // We exclude the current user's home directory (which contains the workspace)
    // so that legitimate workspace paths like /home/<user>/project/... don't get blocked.
    const currentUser = os.userInfo().username;
    const escapedUser = currentUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathPattern = new RegExp(
        `(?:^|\\s)(\\/(?:usr|etc|var|boot|sys|proc|dev|root|home\\/(?!${escapedUser}))[^\\s]*)`,
        'gi'
    );
    const systemPaths = command.match(pathPattern);
    if (systemPaths) {
        return `Command references system paths: ${systemPaths.join(', ')}. Commands should only affect workspace files.`;
    }
    
    return null; // No issues
}

// NOTE: Resource limits via `ulimit` have been intentionally removed.
// On Linux, `ulimit -u` (process limit) is per-UID global — setting it below
// the user's current process count bricks the terminal system-wide.
// `ulimit -v` (virtual memory) breaks Node.js fork() because Node maps large
// virtual address spaces (10-20GB) even when physical usage is low.
// Neither provides meaningful sandbox isolation without cgroups.
// Security is enforced by: hard blocklist, risk classifier, workspace scoping,
// user confirmation prompts, and the consecutive failure circuit breaker.

let bwrapAvailable: boolean | undefined = undefined;
function isBwrapAvailable(): boolean {
    if (bwrapAvailable !== undefined) { return bwrapAvailable; }
    try {
        const result = cp.spawnSync('which', ['bwrap']);
        bwrapAvailable = result.status === 0;
    } catch {
        bwrapAvailable = false;
    }
    return bwrapAvailable;
}

let sandboxExecAvailable: boolean | undefined = undefined;
function isSandboxExecAvailable(): boolean {
    if (sandboxExecAvailable !== undefined) { return sandboxExecAvailable; }
    try {
        const result = cp.spawnSync('which', ['sandbox-exec']);
        sandboxExecAvailable = result.status === 0;
    } catch {
        sandboxExecAvailable = false;
    }
    return sandboxExecAvailable;
}

function wrapCommandLinux(command: string, execCwd: string, workspaceRoot: string): string {
    if (!isBwrapAvailable()) {
        outputChannel.appendLine("[Sandbox] ⚠️ bwrap is enabled but not available on this system. Falling back to normal execution.");
        return command;
    }

    const pathsToBind = ['/usr', '/etc', '/run', '/opt'];
    const symlinksOrBinds = ['/bin', '/sbin', '/lib', '/lib64'];

    const bwrapArgs: string[] = [];

    for (const p of pathsToBind) {
        if (fs.existsSync(p)) {
            bwrapArgs.push('--ro-bind', p, p);
        }
    }

    for (const p of symlinksOrBinds) {
        if (fs.existsSync(p)) {
            try {
                const stats = fs.lstatSync(p);
                if (stats.isSymbolicLink()) {
                    const target = fs.readlinkSync(p);
                    bwrapArgs.push('--symlink', target, p);
                } else {
                    bwrapArgs.push('--ro-bind', p, p);
                }
            } catch {
                bwrapArgs.push('--ro-bind', p, p);
            }
        }
    }

    bwrapArgs.push('--bind', workspaceRoot, workspaceRoot);
    bwrapArgs.push('--proc', '/proc');
    bwrapArgs.push('--dev', '/dev');
    bwrapArgs.push('--dir', '/tmp');
    bwrapArgs.push('--dir', '/var');
    bwrapArgs.push('--chdir', execCwd);
    bwrapArgs.push('--unshare-user');
    bwrapArgs.push('--unshare-ipc');
    bwrapArgs.push('--unshare-pid');
    bwrapArgs.push('--setenv', 'HOME', '/tmp');
    bwrapArgs.push('--setenv', 'PATH', process.env.PATH || '');

    const escapedCommand = command.replace(/'/g, "'\\''");
    const argsStr = bwrapArgs.map(arg => {
        if (/[^\w\/\.\-]/.test(arg)) {
            return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
    }).join(' ');

    return `bwrap ${argsStr} -- /bin/bash -c '${escapedCommand}'`;
}

function wrapCommandMac(command: string, execCwd: string, workspaceRoot: string): string {
    if (!isSandboxExecAvailable()) {
        outputChannel.appendLine("[Sandbox] ⚠️ sandbox-exec is enabled but not available on macOS. Falling back to normal execution.");
        return command;
    }

    const tmpDir = path.join(workspaceRoot, '.kdaina', 'tmp');
    if (!fs.existsSync(tmpDir)) {
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
        } catch {}
    }
    const profilePath = path.join(tmpDir, 'mac-sandbox.sb');

    // Split PATH to allow execution of binaries in system/user PATH
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const allowedPathRules = pathDirs
        .filter(dir => {
            try {
                return dir && fs.existsSync(dir);
            } catch {
                return false;
            }
        })
        .map(dir => {
            // Allow the bin dir and its parent directory (for libraries/node_modules access)
            const escapedDir = dir.replace(/"/g, '\\"');
            const parentDir = path.dirname(dir);
            const escapedParent = parentDir.replace(/"/g, '\\"');
            return `(allow file-read* process-exec (subpath "${escapedDir}"))
(allow file-read* (subpath "${escapedParent}"))`;
        })
        .join('\n');

    const profileContent = `(version 1)
(deny default)
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/var"))
(allow file-read* (subpath "/private/etc"))
(allow file-read* file-write* (subpath "/private/tmp"))
(allow file-read* file-write* (subpath "/var/folders"))
(allow file-read* file-write* (subpath "${workspaceRoot}"))
(allow process-exec (subpath "/bin"))
(allow process-exec (subpath "/usr/bin"))
(allow process-exec (subpath "/usr/local/bin"))
(allow process-exec (subpath "${workspaceRoot}"))
(allow process-fork)
(allow network-outbound)
${allowedPathRules}
`;

    try {
        fs.writeFileSync(profilePath, profileContent, 'utf-8');
    } catch (e) {
        outputChannel.appendLine(`[Sandbox] Failed to write macOS sandbox profile: ${e}. Falling back to normal execution.`);
        return command;
    }

    const escapedCommand = command.replace(/'/g, "'\\''");
    return `sandbox-exec -f ${JSON.stringify(profilePath)} /bin/bash -c '${escapedCommand}'`;
}

function wrapCommandWindows(command: string, execCwd: string, workspaceRoot: string): string {
    outputChannel.appendLine("[Sandbox] ℹ️ Terminal Sandbox is not natively supported on Windows. Falling back to normal execution with safety filters.");
    return command;
}

function wrapCommandWithSandbox(command: string, execCwd: string, workspaceRoot: string): string {
    const platform = process.platform;
    if (platform === 'linux') {
        return wrapCommandLinux(command, execCwd, workspaceRoot);
    } else if (platform === 'darwin') {
        return wrapCommandMac(command, execCwd, workspaceRoot);
    } else if (platform === 'win32') {
        return wrapCommandWindows(command, execCwd, workspaceRoot);
    }
    return command;
}

/**
 * Creates the system/terminal tools for the agentic loop.
 * NOTE: AI SDK v6 uses 'inputSchema' (not 'parameters') for tool schemas.
 */
export function createSysTools(chatId?: string) {

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    const getTempDir = () => {
        if (!workspaceRoot) { return os.tmpdir(); }
        const dir = path.join(workspaceRoot, '.kdaina', 'tmp');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    };

    // ─── TOOL: run_command ──────────────────────────────────────────────
    const run_command = tool({
        description: 'Execute a shell command in the workspace directory. Output is capped at 3000 characters. Use for: running tests, installing packages, checking git status, building projects. IMPORTANT: For long-running processes (dev servers, watchers, DB servers like `npm run dev`, `vite`, `mongod`, `redis-server`), set background=true so it runs in a separate terminal without blocking. DO NOT append `&` or redirect output (e.g. `> log.txt`) manually; the tool automatically captures and manages output. You can run up to 5 background processes simultaneously. Use list_background_processes to see what is running.',
        inputSchema: z.object({
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().describe('Working directory (defaults to workspace root)'),
            background: z.boolean().optional().describe('Set to true for long-running processes (dev servers, watchers, DB servers). Runs in a separate terminal and returns immediately after capturing initial output.'),
            label: z.string().optional().describe('Optional label for background processes (e.g., "frontend", "backend", "database"). Auto-generated if not provided. Used to identify the process in list_background_processes and stop_background_process.')
        }),
        execute: async (params: { command: string; cwd?: string; background?: boolean; label?: string }, { toolCallId }: any) => {
            // Sanitize command: strip patterns that break the output capture pipeline.
            // The wrapper appends `2>&1 | tee <file>` — a trailing `&` forks before
            // the pipe, and manual redirections (`> log.txt`) divert stdout away from it.
            let sanitizedCommand = params.command.trim();
            const originalCommand = sanitizedCommand;

            // 1. Strip trailing background operator `&` (but not `&&`)
            if (sanitizedCommand.endsWith('&') && !sanitizedCommand.endsWith('&&')) {
                sanitizedCommand = sanitizedCommand.slice(0, -1).trim();
            }

            // 2. Strip manual stdout/stderr file redirections that bypass the tee wrapper
            //    Matches: > file, >> file, 1> file, 2> file, &> file, 2>&1 (with optional quotes)
            //    Applied in a loop to handle chained redirections (e.g. > log.txt 2>&1)
            let prev = '';
            while (prev !== sanitizedCommand) {
                prev = sanitizedCommand;
                sanitizedCommand = sanitizedCommand.replace(/\s*(?:\d|&)?>{1,2}\s*(?:"[^"]*"|'[^']*'|&?\d|\S+)\s*$/g, '').trim();
            }

            if (sanitizedCommand !== originalCommand) {
                outputChannel.appendLine(`[run_command] ⚠️ Sanitized command: "${originalCommand}" → "${sanitizedCommand}"`);
            }
            params.command = sanitizedCommand;

            const execCwd = params.cwd || workspaceRoot;
            const risk = classifyCommandRisk(params.command);

            // Workspace Scope Validation
            const scopeError = validateCommandScope(params.command, execCwd, workspaceRoot);
            if (scopeError) {
                outputChannel.appendLine(`[run_command] ⛔ BLOCKED scope error: ${scopeError}`);
                CommandAuditService.getInstance().log({
                    timestamp: new Date().toISOString(),
                    command: params.command,
                    cwd: execCwd,
                    risk,
                    approved: false,
                    autoApproved: false,
                    exitCode: 1,
                    blocked: true,
                    blockReason: 'scope_error',
                    chatId
                });
                return {
                    exitCode: 1,
                    output: `⛔ BLOCKED: ${scopeError}`,
                    _reflection: 'Your command was blocked because it tries to operate outside the workspace root. Do not modify system paths.'
                };
            }

            // Check if this was auto-approved or manually approved (we inject this in tool-registry.ts)
            // If it's not set, assume it was auto-approved for safety wrapping
            const isAutoApproved = (params as any)._autoApproved !== false;

            const bgPatterns = /\b(npm\s+run\s+dev|npm\s+start|npx\s+vite|yarn\s+dev|pnpm\s+dev|next\s+dev|ng\s+serve|python\s+.*manage\.py\s+runserver|flask\s+run|uvicorn|gunicorn|nodemon|ts-node-dev|webpack\s+serve|vite\s+preview|mongod|mongos|redis-server|redis-cli\s+--pipe|mysqld|mysql_safe|pg_ctl\s+start|postgres\s+-D|docker[-\s]compose\s+up|docker\s+compose\s+up|gradle\s+bootRun|mvn\s+spring-boot:run|php\s+artisan\s+serve|rails\s+server|rails\s+s\b|bundle\s+exec\s+rails|celery\s+worker|celery\s+-A|npm\s+run\s+start:dev|npm\s+run\s+serve|http-server|live-server|serve\s+-s)\b/i;
            const isBackground = params.background === true || bgPatterns.test(params.command);

            // ─── SAFETY: Block commands that could kill the IDE ──────
            // The IDE runs on Node.js/Electron — broad `pkill node` or `killall node` will crash it
            const dangerousPatterns = [
                /\bpkill\b.*\b(node|electron|antigravity|code)\b/i,
                /\bkillall\b.*\b(node|electron|antigravity|code)\b/i,
                /\bkill\s+-9\b.*\b(node|electron)\b/i,
                /\bpkill\s+-9\s+-f\b.*\bnode\b/i,
            ];
            const isDangerous = dangerousPatterns.some(p => p.test(params.command));
            if (isDangerous) {
                outputChannel.appendLine(`[run_command] ⛔ BLOCKED dangerous command: ${params.command}`);
                CommandAuditService.getInstance().log({
                    timestamp: new Date().toISOString(),
                    command: params.command,
                    cwd: execCwd,
                    risk,
                    approved: false,
                    autoApproved: false,
                    exitCode: 1,
                    blocked: true,
                    blockReason: 'hard_blocklist',
                    chatId
                });
                return {
                    exitCode: 1,
                    output: `⛔ BLOCKED: This command would kill the IDE (which runs on Node.js). Use a targeted approach instead:\n- Kill by port: \`lsof -ti:5174 | xargs kill\`\n- Kill specific process: \`kill $(pgrep -f "vite.*${execCwd}")\`\n- Or use terminal_send_input with send_ctrl_c to stop the server gracefully.`,
                    _reflection: 'Your command was blocked because it would kill ALL Node.js processes including the IDE itself. Use a port-specific kill command instead.'
                };
            }

            // ─── CONSECUTIVE FAILURE CIRCUIT BREAKER ────────────────────
            // If the terminal is fundamentally broken (resource exhaustion,
            // stuck process, etc.), stop wasting tokens on retries.
            // Placed before the isBackground branch so it covers ALL paths.
            if (consecutiveFailureCount >= MAX_CONSECUTIVE_FAILURES) {
                outputChannel.appendLine(`[run_command] ⛔ CIRCUIT BREAKER: ${consecutiveFailureCount} consecutive failures — blocking further commands`);
                return {
                    exitCode: 1,
                    output: `⛔ BLOCKED: ${consecutiveFailureCount} consecutive commands have failed. The terminal appears to be broken or stuck.`,
                    _reflection: `STOP: The terminal is not responding. ${consecutiveFailureCount} consecutive commands have failed. Do NOT attempt any more run_command calls. Instead:\n1. Tell the user the terminal is unresponsive.\n2. Suggest they check for stuck processes, restart the terminal, or reload the IDE window.\n3. Wait for the user to confirm the terminal is working before trying again.`
                };
            }

            // Check sandbox setting
            const context = ChatViewProvider.getContext();
            let enableTerminalSandbox = false;
            if (context) {
                const settingsManager = new SettingsManager(context);
                const settings = settingsManager.getSettings();
                enableTerminalSandbox = settings.permissions?.enableTerminalSandbox === true;
            }

            const commandToExecute = enableTerminalSandbox 
                ? wrapCommandWithSandbox(params.command, execCwd, workspaceRoot)
                : params.command;

            if (isBackground) {
                // ─── BACKGROUND MODE ────────────────────────────────────
                // Spawn in a dedicated terminal. Supports up to MAX_BG_TERMINALS
                // concurrent background processes (frontend + backend + DB, etc.)

                // Generate a base label for this background process
                const baseLabel = params.label || generateBgLabel(params.command);

                // Clean up dead terminals from the registry and delete their temp log files
                for (const [key, entry] of bgTerminals) {
                    if (entry.terminal.exitStatus !== undefined) {
                        outputChannel.appendLine(`[run_command] Cleaning up dead background terminal and log: ${key}`);
                        try { fs.unlinkSync(entry.outFile); } catch {}
                        bgTerminals.delete(key);
                    }
                }

                // Smart label deduplication:
                // If a terminal with this exact label already exists:
                // - If command and cwd match, we intend to restart/replace it.
                // - Otherwise, generate a unique label to let them run concurrently.
                let label = baseLabel;
                let counter = 1;
                while (bgTerminals.has(label)) {
                    const existing = bgTerminals.get(label)!;
                    if (existing.command === params.command && existing.cwd === execCwd) {
                        // Exact match - replace/restart
                        break;
                    }
                    counter++;
                    label = `${baseLabel}-${counter}`;
                }

                // If replacing an existing background terminal, stop it and clean up its file
                const existingEntry = bgTerminals.get(label);
                if (existingEntry && existingEntry.terminal.exitStatus === undefined) {
                    outputChannel.appendLine(`[run_command] Replacing existing background terminal: ${label}`);
                    existingEntry.terminal.sendText('\x03', false); // Ctrl+C first
                    await new Promise(r => setTimeout(r, 500));
                    existingEntry.terminal.dispose();
                    try { fs.unlinkSync(existingEntry.outFile); } catch {}
                    bgTerminals.delete(label);
                }

                // Enforce max concurrent background terminals
                if (bgTerminals.size >= MAX_BG_TERMINALS) {
                    // Find the oldest entry and kill it
                    let oldestKey = '';
                    let oldestTime = Infinity;
                    for (const [key, entry] of bgTerminals) {
                        const t = new Date(entry.startedAt).getTime();
                        if (t < oldestTime) {
                            oldestTime = t;
                            oldestKey = key;
                        }
                    }
                    if (oldestKey) {
                        const oldest = bgTerminals.get(oldestKey)!;
                        outputChannel.appendLine(`[run_command] Max background terminals reached (${MAX_BG_TERMINALS}). Killing oldest: ${oldestKey}`);
                        oldest.terminal.sendText('\x03', false);
                        await new Promise(r => setTimeout(r, 500));
                        oldest.terminal.dispose();
                        try { fs.unlinkSync(oldest.outFile); } catch {}
                        bgTerminals.delete(oldestKey);
                    }
                }

                const newTerminal = vscode.window.createTerminal({
                    name: `kdAina [${label}]`,
                    cwd: execCwd
                });
                newTerminal.show(true);

                const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const outFile = path.join(getTempDir(), `ai-bg-${id}.txt`);

                // Run command and tee -a (append) output to a capped log file.
                // We use `tee -a` for real-time terminal display + append file capture.
                // This ensures external log truncation works perfectly without causing sparse null-byte gap files!
                newTerminal.sendText(`cd ${JSON.stringify(execCwd)} && ${commandToExecute} 2>&1 | tee -a ${JSON.stringify(outFile)}`, true);

                outputChannel.appendLine(`[run_command] Background [${label}]: $ ${params.command} (cwd: ${execCwd})`);

                // Register in the background terminal registry
                const entry: BgTerminalEntry = {
                    terminal: newTerminal,
                    command: params.command,
                    cwd: execCwd,
                    startedAt: new Date().toISOString(),
                    label,
                    outFile
                };
                bgTerminals.set(label, entry);

                // Wait a few seconds to capture initial output (e.g. "Server running on port 5174")
                await new Promise(r => setTimeout(r, 5000));

                let output = '(server starting...)';
                try {
                    if (fs.existsSync(outFile)) {
                        output = fs.readFileSync(outFile, 'utf-8') || '(no output yet)';
                        output = stripAnsi(output);
                    }
                } catch {}

                // Try to extract port from output for the registry
                const portMatch = output.match(/(?:port|listening on|running at|localhost:)\s*:?\s*(\d{3,5})/i);
                if (portMatch) {
                    entry.port = parseInt(portMatch[1], 10);
                }

                if (output.length > 3000) {
                    output = output.substring(0, 3000) + '\n... [output truncated]';
                }

                CommandAuditService.getInstance().log({
                    timestamp: new Date().toISOString(),
                    command: params.command,
                    cwd: execCwd,
                    risk,
                    approved: !isAutoApproved,
                    autoApproved: isAutoApproved,
                    exitCode: 0,
                    blocked: false,
                    chatId
                });

                // Build summary of all active background processes
                const activeList = [...bgTerminals.values()]
                    .filter(e => e.terminal.exitStatus === undefined)
                    .map(e => `  - [${e.label}]${e.port ? ` :${e.port}` : ''} — ${e.command.substring(0, 50)}`)
                    .join('\n');

                return {
                    exitCode: 0,
                    output,
                    _label: label,
                    _port: entry.port || null,
                    _note: `Background process "${label}" started in terminal "${newTerminal.name}". The main terminal is free for more commands.\n\nActive background processes (${bgTerminals.size}/${MAX_BG_TERMINALS}):\n${activeList}\n\nUse list_background_processes to check status, stop_background_process to stop one, or browser_open to verify a server.`
                };
            }

            // Standard (blocking) mode: use the shared AI terminal
            const terminal = getOrCreateAITerminal(execCwd);
            terminal.show(true); // Show terminal, preserve focus

            outputChannel.appendLine(`[run_command] $ ${params.command} (cwd: ${execCwd})`);

            // Use temp files for output capture
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const outFile = path.join(getTempDir(), `ai-out-${id}.txt`);
            const exitFile = path.join(getTempDir(), `ai-exit-${id}.txt`);

            // Build the wrapped command:
            // 1. cd to the correct directory
            // 2. Run the actual command, tee output to file
            // 3. Write exit code to a separate file
            // The user sees the command + output in the real terminal
            const cdCmd = `cd ${JSON.stringify(execCwd)}`;
            const runCmd = `${commandToExecute} 2>&1 | tee ${JSON.stringify(outFile)}; echo $? > ${JSON.stringify(exitFile)}`;
            
            ReviewManager.getInstance().setTerminalRunning(true);
            let output = '(no output)';
            let exitCode = 1;
            

            try {
                terminal.sendText(`${cdCmd} && ${runCmd}`, true);

                // ── Smart wait: monitors both exit file AND output activity ──
                const result = await waitForCommandCompletion(exitFile, outFile, outputChannel);

                if (result.completed) {
                    // ── NORMAL COMPLETION: command exited cleanly ──
                    (ReviewManager.getInstance() as any)._timeoutCount = 0;
                    
                    // Small delay to ensure file is fully written
                    await new Promise(r => setTimeout(r, 100));

                    try {
                        output = fs.readFileSync(outFile, 'utf-8') || '(no output)';
                        const exitStr = fs.readFileSync(exitFile, 'utf-8').trim();
                        exitCode = parseInt(exitStr, 10) || 0;
                    } catch (e) {
                        output = `(failed to read output: ${e})`;
                    }
                } else if (result.stallDetected && result.stallPattern) {
                    // ── STALL WITH KNOWN PATTERN: watch mode or interactive prompt ──
                    (ReviewManager.getInstance() as any)._timeoutCount = 0; // Not a real timeout

                    output = result.partialOutput || '(no output)';

                    // Use inferred exit code if available, otherwise 124
                    exitCode = result.inferredExitCode ?? 124;

                    // Append structured recovery guidance
                    const sp = result.stallPattern;
                    const stallNote = sp.type === 'watch_mode'
                        ? `\n\n⏸ Process is in ${sp.tool ? sp.tool + ' ' : ''}watch mode (output stalled after ${Math.round(result.elapsedMs / 1000)}s). ${sp.recovery}`
                        : sp.type === 'interactive' || sp.type === 'confirm'
                        ? `\n\n⏳ Process is waiting for input (output stalled after ${Math.round(result.elapsedMs / 1000)}s). ${sp.recovery}`
                        : '';
                    if (stallNote) {
                        output += stallNote;
                    }
                } else {
                    // ── HARD TIMEOUT or STALL WITHOUT KNOWN PATTERN ──
                    const failCount = (ReviewManager.getInstance() as any)._timeoutCount || 0;
                    (ReviewManager.getInstance() as any)._timeoutCount = failCount + 1;

                    // Use inferred exit code if available
                    exitCode = result.inferredExitCode ?? 124;

                    let timeoutMsg: string;
                    if (failCount >= 2) {
                        timeoutMsg = `(command timed out for the ${failCount + 1}th time. The terminal is unresponsive — likely a stuck process or system resource issue. STOP trying commands and report this to the user.)`;
                    } else if (failCount >= 1) {
                        timeoutMsg = '(command timed out AGAIN. The background process is stubbornly blocking the terminal. Use terminal_send_input with { send_ctrl_c: true } to recover the terminal. If you already tried that and it is still stuck, STOP and ask the user to manually kill the process or restart the server.)';
                    } else {
                        timeoutMsg = `(command did not exit after ${Math.round(result.elapsedMs / 1000)}s — it may still be running in the terminal. ${result.stallPattern?.recovery || 'Use terminal_send_input with { send_ctrl_c: true } to recover the terminal before running more commands.'})`;
                    }

                    if (result.partialOutput) {
                        output = result.partialOutput + '\n\n' + timeoutMsg;
                    } else {
                        output = timeoutMsg;
                    }
                }

                // Cleanup temp files
                try { fs.unlinkSync(outFile); } catch {}
                try { fs.unlinkSync(exitFile); } catch {}

                outputChannel.appendLine(`[run_command] exit code: ${exitCode} (elapsed: ${result.elapsedMs}ms, stall: ${result.stallDetected}, pattern: ${result.stallPattern?.type || 'none'})`);
            } finally {
                // Allow a small delay for FS watchers to fire
                setTimeout(() => ReviewManager.getInstance().setTerminalRunning(false), 500);
            }

            output = stripAnsi(output);

            if (output.length > 3000) {
                output = output.substring(0, 3000) + '\n... [output truncated at 3000 chars]';
            }

            CommandAuditService.getInstance().log({
                timestamp: new Date().toISOString(),
                command: params.command,
                cwd: execCwd,
                risk,
                approved: !isAutoApproved,
                autoApproved: isAutoApproved,
                exitCode: exitCode,
                blocked: false,
                chatId
            });

            // ─── TEST → FIX CYCLE ENFORCEMENT ──────────────────────────
            const isTestCmd = isTestOrBuildCommand(params.command);
            const cmdKey = normalizeCommand(params.command);

            if (isTestCmd && exitCode !== 0 && exitCode !== 124) {
                // Failed test/build command — track retries
                const tracker = testRetryTracker.get(cmdKey) || { count: 0, command: params.command };
                tracker.count++;
                testRetryTracker.set(cmdKey, tracker);
                consecutiveFailureCount++;  // Also feed the general circuit breaker

                outputChannel.appendLine(`[run_command] Test/build failure detected: "${cmdKey}" — attempt ${tracker.count}/${MAX_TEST_RETRIES}`);

                if (tracker.count >= MAX_TEST_RETRIES) {
                    // Max retries exhausted — stop the cycle
                    testRetryTracker.delete(cmdKey);
                    return {
                        exitCode,
                        output,
                        _testCycle: {
                            status: 'exhausted',
                            attempts: tracker.count,
                            maxRetries: MAX_TEST_RETRIES
                        },
                        _reflection: `STOP: Test/build command "${params.command}" has failed ${tracker.count} times. You have exhausted your retry budget.
Do NOT re-run this command. Instead:
1. Summarize what you tried and why each attempt failed.
2. Report the remaining errors to the user.
3. Ask the user for guidance on how to proceed.`
                    };
                }

                return {
                    exitCode,
                    output,
                    _testCycle: {
                        status: 'failed',
                        attempt: tracker.count,
                        maxRetries: MAX_TEST_RETRIES,
                        retriesRemaining: MAX_TEST_RETRIES - tracker.count
                    },
                    _reflection: `Test/build FAILED (attempt ${tracker.count}/${MAX_TEST_RETRIES}). Follow this cycle:
1. Analyze the error output above — identify the root cause (file, line, error type).
2. Read the relevant code with read_line_range.
3. Fix the issue with chunk_replace.
4. Re-run the EXACT same command: \`${params.command}\`
You have ${MAX_TEST_RETRIES - tracker.count} retries remaining. Do NOT skip the re-run step.`
                };
            }

            if (isTestCmd && exitCode === 0) {
                // Test passed — clear the tracker and celebrate
                consecutiveFailureCount = 0;  // Reset general circuit breaker
                const hadRetries = testRetryTracker.has(cmdKey);
                const previousAttempts = testRetryTracker.get(cmdKey)?.count || 0;
                testRetryTracker.delete(cmdKey);

                if (hadRetries) {
                    outputChannel.appendLine(`[run_command] Test/build PASSED after ${previousAttempts} failed attempts`);
                    return {
                        exitCode,
                        output,
                        _testCycle: {
                            status: 'passed',
                            attemptsBeforeSuccess: previousAttempts + 1
                        },
                        _note: `Test/build passed after ${previousAttempts} failed attempt(s). The fix worked. Continue with the next task.`
                    };
                }

                return { exitCode, output };
            }

            // ─── TRACK CONSECUTIVE FAILURES (all command types) ────────
            if (exitCode !== 0) {
                consecutiveFailureCount++;
                outputChannel.appendLine(`[run_command] Consecutive failure #${consecutiveFailureCount}`);
            } else {
                consecutiveFailureCount = 0; // Reset on any success
            }

            // Non-test commands: return output without a reflection prompt.
            // Reflection is only for test/build commands to prevent infinite
            // self-correction loops on arbitrary failing commands.
            return {
                exitCode,
                output
            };
        }
    } as any);

    // ─── TOOL: terminal_send_input ──────────────────────────────────────
    const terminal_send_input = tool({
        description: 'Send raw text or special keys to a terminal. Can target the main terminal or a specific background process by label. Use this to interact with prompts (like "y" or "n"), recover a stuck terminal (send_ctrl_c: true), or send input to a background process.',
        inputSchema: z.object({
            text: z.string().optional().describe('Text to send to the terminal (e.g. "y\\n")'),
            send_ctrl_c: z.boolean().optional().describe('Set to true to send a Ctrl+C signal to interrupt the current process'),
            target: z.string().optional().describe('Optional: label of a background process to target (from list_background_processes). If not specified, targets the main AI terminal.')
        }),
        execute: async (params: { text?: string; send_ctrl_c?: boolean; target?: string }) => {
            let terminal: vscode.Terminal;

            if (params.target) {
                // Target a specific background terminal by label
                const entry = bgTerminals.get(params.target);
                if (!entry || entry.terminal.exitStatus !== undefined) {
                    return { output: `No active background process found with label "${params.target}". Use list_background_processes to see active processes.` };
                }
                terminal = entry.terminal;
            } else {
                terminal = getOrCreateAITerminal(workspaceRoot);
            }
            terminal.show(true);

            if (params.send_ctrl_c) {
                outputChannel.appendLine(`[terminal_send_input] Sending Ctrl+C to ${params.target || 'main'}`);
                terminal.sendText('\x03', false);
                terminal.sendText('\x03', false); // Fire twice!
                return { output: `Sent Ctrl+C to ${params.target ? `background process "${params.target}"` : 'main terminal'} (fired twice to ensure interrupt).` };
            }

            if (params.text) {
                outputChannel.appendLine(`[terminal_send_input] Sending text to ${params.target || 'main'}: ${params.text}`);
                terminal.sendText(params.text, false);
                return { output: `Sent text to ${params.target ? `background process "${params.target}"` : 'main terminal'}.` };
            }

            return { output: 'No action taken.' };
        }
    } as any);

    // ─── TOOL: list_background_processes ─────────────────────────────────
    const list_background_processes = tool({
        description: 'List all active background processes started by run_command with background=true. Shows label, command, port (if detected), uptime, and terminal status. Use this to check which servers are running before starting new ones.',
        inputSchema: z.object({}),
        execute: async () => {
            // Clean up dead terminals and their log files
            for (const [key, entry] of bgTerminals) {
                if (entry.terminal.exitStatus !== undefined) {
                    try { fs.unlinkSync(entry.outFile); } catch {}
                    bgTerminals.delete(key);
                }
            }

            if (bgTerminals.size === 0) {
                return {
                    processes: [],
                    summary: 'No background processes are currently running.',
                    capacity: `0/${MAX_BG_TERMINALS} slots used`
                };
            }

            const processes = [...bgTerminals.entries()].map(([label, entry]) => {
                const uptimeMs = Date.now() - new Date(entry.startedAt).getTime();
                const uptimeSec = Math.floor(uptimeMs / 1000);
                const uptimeStr = uptimeSec < 60
                    ? `${uptimeSec}s`
                    : uptimeSec < 3600
                        ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
                        : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

                // Efficiently read last 5 lines via fd+seek (avoids loading entire file)
                let latestOutput = '';
                try {
                    if (fs.existsSync(entry.outFile)) {
                        const stat = fs.statSync(entry.outFile);
                        // Read only the last 2KB to extract 5 lines — avoids loading 512KB files
                        const readBytes = Math.min(stat.size, 2048);
                        const fd = fs.openSync(entry.outFile, 'r');
                        const buf = Buffer.alloc(readBytes);
                        fs.readSync(fd, buf, 0, readBytes, Math.max(0, stat.size - readBytes));
                        fs.closeSync(fd);
                        const tail = buf.toString('utf-8');
                        const lines = tail.trim().split('\n');
                        latestOutput = lines.slice(-5).join('\n');
                    }
                } catch {}

                return {
                    label,
                    command: entry.command,
                    cwd: entry.cwd,
                    port: entry.port || null,
                    uptime: uptimeStr,
                    startedAt: entry.startedAt,
                    alive: entry.terminal.exitStatus === undefined,
                    latestOutput: latestOutput ? latestOutput.substring(0, 500) : '(no output captured)'
                };
            });

            return {
                processes,
                summary: `${processes.length} background process(es) running.`,
                capacity: `${bgTerminals.size}/${MAX_BG_TERMINALS} slots used`
            };
        }
    } as any);

    // ─── TOOL: stop_background_process ───────────────────────────────────
    const stop_background_process = tool({
        description: 'Stop a background process by its label. Sends Ctrl+C first for graceful shutdown, then disposes the terminal. Use list_background_processes to see available labels.',
        inputSchema: z.object({
            label: z.string().describe('Label of the background process to stop (from list_background_processes)'),
            force: z.boolean().optional().describe('If true, skip graceful Ctrl+C and immediately kill the terminal. Default: false.')
        }),
        execute: async (params: { label: string; force?: boolean }) => {
            const entry = bgTerminals.get(params.label);
            if (!entry) {
                // Check if the label is a partial match
                const candidates = [...bgTerminals.keys()].filter(k => k.toLowerCase().includes(params.label.toLowerCase()));
                if (candidates.length > 0) {
                    return {
                        output: `No exact match for "${params.label}". Did you mean: ${candidates.join(', ')}?`,
                        exitCode: 1
                    };
                }
                return {
                    output: `No background process found with label "${params.label}". Use list_background_processes to see active processes.`,
                    exitCode: 1
                };
            }

            if (entry.terminal.exitStatus !== undefined) {
                try { fs.unlinkSync(entry.outFile); } catch {}
                bgTerminals.delete(params.label);
                return {
                    output: `Background process "${params.label}" was already stopped.`,
                    exitCode: 0
                };
            }

            if (!params.force) {
                // Graceful: send Ctrl+C, wait, then dispose
                outputChannel.appendLine(`[stop_background_process] Graceful stop: ${params.label}`);
                entry.terminal.sendText('\x03', false);
                entry.terminal.sendText('\x03', false);
                await new Promise(r => setTimeout(r, 2000));
            }

            outputChannel.appendLine(`[stop_background_process] Disposing terminal: ${params.label}`);
            entry.terminal.dispose();
            bgTerminals.delete(params.label);

            // Clean up temp output file
            try { fs.unlinkSync(entry.outFile); } catch {}

            return {
                output: `Background process "${params.label}" (${entry.command}) has been stopped.${entry.port ? ` Port ${entry.port} should be freed.` : ''}`,
                exitCode: 0
            };
        }
    } as any);

    // ─── TOOL: get_background_output ─────────────────────────────────────
    const get_background_output = tool({
        description: 'Read the recent output/logs from a running background process. Use this to check for errors, verify a server started correctly, or debug issues with a background service. Returns the tail of the output log.',
        inputSchema: z.object({
            label: z.string().describe('Label of the background process (from list_background_processes)'),
            lines: z.number().optional().describe('Number of lines to read from the end of the output. Default: 50. Max: 200.'),
            search: z.string().optional().describe('Optional: filter output to only lines containing this text (case-insensitive). Useful for finding errors or specific log messages.')
        }),
        execute: async (params: { label: string; lines?: number; search?: string }) => {
            // Find the entry (exact match first, then fuzzy)
            let entry = bgTerminals.get(params.label);
            if (!entry) {
                // Try fuzzy match
                const candidates = [...bgTerminals.entries()].filter(([k]) =>
                    k.toLowerCase().includes(params.label.toLowerCase())
                );
                if (candidates.length === 1) {
                    entry = candidates[0][1];
                } else if (candidates.length > 1) {
                    return {
                        output: `Multiple matches for "${params.label}": ${candidates.map(c => c[0]).join(', ')}. Be more specific.`,
                        exitCode: 1
                    };
                } else {
                    return {
                        output: `No background process found with label "${params.label}". Use list_background_processes to see active processes.`,
                        exitCode: 1
                    };
                }
            }

            const maxLines = Math.min(params.lines || 50, 200);
            const alive = entry.terminal.exitStatus === undefined;

            // Cap the output file if it has grown too large
            try {
                if (fs.existsSync(entry.outFile)) {
                    const stat = fs.statSync(entry.outFile);
                    if (stat.size > MAX_BG_OUTPUT_BYTES) {
                        // Keep only the last half of the max size
                        const keepBytes = Math.floor(MAX_BG_OUTPUT_BYTES / 2);
                        const fd = fs.openSync(entry.outFile, 'r');
                        const buffer = Buffer.alloc(keepBytes);
                        fs.readSync(fd, buffer, 0, keepBytes, stat.size - keepBytes);
                        fs.closeSync(fd);
                        // Find the first newline to start at a clean line boundary
                        const firstNewline = buffer.indexOf(10); // '\n'
                        const cleanContent = firstNewline >= 0
                            ? buffer.subarray(firstNewline + 1).toString('utf-8')
                            : buffer.toString('utf-8');
                        fs.writeFileSync(entry.outFile, `[... earlier output truncated (file exceeded ${Math.floor(MAX_BG_OUTPUT_BYTES / 1024)}KB cap) ...]\n${cleanContent}`);
                        outputChannel.appendLine(`[get_background_output] Truncated ${entry.outFile} from ${stat.size} to ~${keepBytes} bytes`);
                    }
                }
            } catch (e) {
                outputChannel.appendLine(`[get_background_output] Error capping output file: ${e}`);
            }

            // Read the output file
            let output = '';
            try {
                if (fs.existsSync(entry.outFile)) {
                    let full = fs.readFileSync(entry.outFile, 'utf-8');
                    full = stripAnsi(full);
                    let allLines = full.split('\n');

                    // Apply search filter if provided
                    if (params.search) {
                        const searchLower = params.search.toLowerCase();
                        allLines = allLines.filter(line => line.toLowerCase().includes(searchLower));
                        output = allLines.slice(-maxLines).join('\n');
                        if (allLines.length === 0) {
                            output = `(no lines matching "${params.search}" found in output)`;
                        }
                    } else {
                        output = allLines.slice(-maxLines).join('\n');
                    }
                } else {
                    output = '(output file not found — the process may not have produced any output yet)';
                }
            } catch (e) {
                output = `(failed to read output file: ${e})`;
            }

            if (output.length > 5000) {
                output = output.substring(output.length - 5000);
                // Find the first newline for a clean start
                const firstNewline = output.indexOf('\n');
                if (firstNewline >= 0) {
                    output = '... [output truncated]\n' + output.substring(firstNewline + 1);
                }
            }

            // Try to detect port if we haven't yet
            if (!entry.port && output) {
                const portMatch = output.match(/(?:port|listening on|running at|localhost:)\s*:?\s*(\d{3,5})/i);
                if (portMatch) {
                    entry.port = parseInt(portMatch[1], 10);
                }
            }

            return {
                label: entry.label,
                command: entry.command,
                alive,
                port: entry.port || null,
                totalLines: output.split('\n').length,
                output,
                _note: alive
                    ? `Process "${entry.label}" is still running. Output shows the last ${maxLines} lines${params.search ? ` matching "${params.search}"` : ''}.`
                    : `Process "${entry.label}" has exited. Output shows the final ${maxLines} lines${params.search ? ` matching "${params.search}"` : ''}.`
            };
        }
    } as any);

    // ─── TOOL: search_workspace ─────────────────────────────────────────
    const search_workspace = tool({
        description: 'Search for text patterns across the workspace. Returns matching file paths and line contents. Max 30 results.',
        inputSchema: z.object({
            query: z.string().describe('Text pattern to search for'),
            fileGlob: z.string().optional().describe('Optional glob filter, e.g. "*.ts"'),
            caseSensitive: z.boolean().optional().describe('Default false')
        }),
        execute: async (params: { query: string; fileGlob?: string; caseSensitive?: boolean }) => {
            return new Promise<{ results: any[] }>((resolve) => {
                const args = ['-rn'];
                if (!params.caseSensitive) {
                    args.push('-i');
                }
                if (params.fileGlob) {
                    args.push(`--include=${params.fileGlob}`);
                }
                args.push('--exclude-dir=node_modules');
                args.push('--exclude-dir=dist');
                args.push('--exclude-dir=.git');
                args.push(params.query);
                args.push(workspaceRoot);

                cp.execFile('grep', args, { timeout: 15000, maxBuffer: 1024 * 1024 * 5 }, (error, stdout) => {
                    if (!stdout) {
                        resolve({ results: [] });
                        return;
                    }
                    const results = stdout.trim().split('\n').slice(0, 30).map((line: string) => {
                        const match = line.match(/^(.+?):(\d+):(.*)$/);
                        if (match) {
                            return {
                                file: vscode.workspace.asRelativePath(match[1]),
                                line: parseInt(match[2]),
                                content: match[3].trim().substring(0, 200)
                            };
                        }
                        return { file: '', line: 0, content: line.substring(0, 200) };
                    });
                    resolve({ results });
                });
            });
        }
    } as any);

    // ─── TOOL: get_workspace_problems ───────────────────────────────────
    const get_workspace_problems = tool({
        description: 'Get current workspace problems (errors, warnings) from the IDE. Optionally scope to a single file for detailed diagnostics after an edit. Without filePath, returns a capped summary of all workspace problems.',
        inputSchema: z.object({
            filePath: z.string().optional().describe('Optional: scope to a specific file path for detailed diagnostics. Without this, returns workspace-wide summary (capped at 50).')
        }),
        execute: async (params: { filePath?: string }) => {
            const MAX_PROBLEMS = 50;
            const diagnostics = vscode.languages.getDiagnostics();
            let problemsText = "";
            let totalCount = 0;
            let shownCount = 0;

            // If scoped to a single file, return ALL errors/warnings for that file
            if (params.filePath) {
                const absPath = params.filePath.startsWith('/')
                    ? params.filePath
                    : require('path').join(workspaceRoot, params.filePath);
                const targetUri = vscode.Uri.file(absPath);
                const fileDiags = vscode.languages.getDiagnostics(targetUri);
                const relevant = fileDiags.filter(d =>
                    d.severity === vscode.DiagnosticSeverity.Error ||
                    d.severity === vscode.DiagnosticSeverity.Warning
                );

                if (relevant.length === 0) {
                    return { problems: `No errors or warnings in ${params.filePath}.` };
                }

                problemsText = `File: ${params.filePath}\n`;
                relevant.forEach(p => {
                    problemsText += `  - [${vscode.DiagnosticSeverity[p.severity]}] Line ${p.range.start.line + 1}: ${p.message}\n`;
                });
                return { problems: problemsText, count: relevant.length };
            }

            // Workspace-wide: filter to Error/Warning, cap at MAX_PROBLEMS
            for (const [uri, fileDiagnostics] of diagnostics) {
                const relevant = fileDiagnostics.filter(d =>
                    d.severity === vscode.DiagnosticSeverity.Error ||
                    d.severity === vscode.DiagnosticSeverity.Warning
                );
                if (relevant.length === 0) { continue; }

                totalCount += relevant.length;

                if (shownCount >= MAX_PROBLEMS) { continue; } // keep counting total but stop printing

                problemsText += `File: ${vscode.workspace.asRelativePath(uri)}\n`;
                for (const p of relevant) {
                    if (shownCount >= MAX_PROBLEMS) { break; }
                    problemsText += `  - [${vscode.DiagnosticSeverity[p.severity]}] Line ${p.range.start.line + 1}: ${p.message}\n`;
                    shownCount++;
                }
                problemsText += "\n";
            }

            if (!problemsText) {
                return { problems: "No errors or warnings found in the workspace." };
            }

            if (totalCount > MAX_PROBLEMS) {
                problemsText += `... [${totalCount - MAX_PROBLEMS} more problems hidden. Use get_workspace_problems with a filePath to see details for a specific file.]\n`;
            }

            return { problems: problemsText, total: totalCount, shown: shownCount };
        }
    } as any);

    return {
        run_command,
        terminal_send_input,
        list_background_processes,
        stop_background_process,
        get_background_output,
        search_workspace,
        get_workspace_problems
    };
}
