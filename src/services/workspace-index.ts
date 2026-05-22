import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FileEntry {
    path: string;
    relativePath: string;
    size: number;
    language: string;
}

export interface SymbolEntry {
    name: string;
    kind: string;
    containerName: string;
    range: { startLine: number; endLine: number };
    filePath: string;
}

export interface WorkspaceIndex {
    fileTree: FileEntry[];
    lastUpdated: number;
}

/**
 * Lightweight workspace indexer that exploits VS Code's existing infrastructure.
 * No vector DB, no embeddings — just fast in-memory caching.
 * 
 * Token-saving features:
 * - Compact tree: summarises directories with many files instead of listing every one
 * - Skeleton cache: avoids re-reading file structures the agent has already seen
 * - Active editor context: auto-injects skeletons of currently open files
 */
export class WorkspaceIndexService {
    private static instance: WorkspaceIndexService;
    public static getInstance(): WorkspaceIndexService {
        if (!WorkspaceIndexService.instance) {
            WorkspaceIndexService.instance = new WorkspaceIndexService();
        }
        return WorkspaceIndexService.instance;
    }

    private index: WorkspaceIndex = { fileTree: [], lastUpdated: 0 };
    private disposables: vscode.Disposable[] = [];

    private _onDidUpdate = new vscode.EventEmitter<number>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    /** Cache of file skeletons so repeated read_file_skeleton calls are free */
    private skeletonCache = new Map<string, { skeleton: string; totalLines: number; mtime: number }>();

    // ─── ESSENCE CACHE ─────────────────────────────────────────────────
    /** Max characters per essence file to inject into the context window */
    private static readonly MAX_ESSENCE_CHARS = 8000;

    private essenceCache: {
        blueprint: string | null;
        skill: string | null;
        hasBlueprint: boolean;
        hasSkill: boolean;
        lastUpdated: number;
    } = { blueprint: null, skill: null, hasBlueprint: false, hasSkill: false, lastUpdated: 0 };

    private essenceWatcher: vscode.FileSystemWatcher | undefined;

    private constructor() {
        // Auto-refresh on file changes
        this.disposables.push(
            vscode.workspace.onDidCreateFiles(() => this.refresh()),
            vscode.workspace.onDidDeleteFiles(() => this.refresh()),
            vscode.workspace.onDidRenameFiles(() => this.refresh())
        );

        // Watch for blueprint.md / skill.md changes reactively
        this.initEssenceWatcher();
    }

    /**
     * Watch for creation, modification, or deletion of blueprint.md and skill.md.
     * Fires onDidUpdate so the webview receives an updated essence status.
     */
    private initEssenceWatcher(): void {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return;
        }
        // Watch .kdaina/artifacts/global/ for blueprint.md and skill.md
        const pattern = new vscode.RelativePattern(
            folder,
            '.kdaina/artifacts/global/{blueprint.md,skill.md}'
        );
        this.essenceWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const handler = async () => {
            await this.refreshEssenceCache();
            // Re-fire update so listeners (extension.ts) push new status to webview
            this._onDidUpdate.fire(this.index.fileTree.length);
        };
        this.essenceWatcher.onDidCreate(handler);
        this.essenceWatcher.onDidChange(handler);
        this.essenceWatcher.onDidDelete(handler);
        this.disposables.push(this.essenceWatcher);
    }

    /**
     * Re-read blueprint.md and skill.md into the in-memory cache (async).
     */
    public async refreshEssenceCache(): Promise<void> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            this.essenceCache = { blueprint: null, skill: null, hasBlueprint: false, hasSkill: false, lastUpdated: Date.now() };
            return;
        }
        const fsPromises = fs.promises;
        const artifactsDir = path.join(root, '.kdaina', 'artifacts', 'global');

        const readSafe = async (filePath: string): Promise<string | null> => {
            try {
                return await fsPromises.readFile(filePath, 'utf8');
            } catch {
                return null;
            }
        };

        const [blueprint, skill] = await Promise.all([
            readSafe(path.join(artifactsDir, 'blueprint.md')),
            readSafe(path.join(artifactsDir, 'skill.md'))
        ]);

        this.essenceCache = {
            blueprint,
            skill,
            hasBlueprint: blueprint !== null,
            hasSkill: skill !== null,
            lastUpdated: Date.now()
        };
    }

    public getEssenceStatus(): { isProject: boolean; hasBlueprint: boolean; hasSkill: boolean; needsEssence: boolean } {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const isProject = !!workspaceFolders && workspaceFolders.length > 0;
        if (!isProject) {
            return { isProject: false, hasBlueprint: false, hasSkill: false, needsEssence: false };
        }

        const root = workspaceFolders[0].uri.fsPath;
        const hasGit = fs.existsSync(path.join(root, '.git'));

        const manifestNames = [
            'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
            'setup.py', 'Gemfile', 'composer.json', 'build.gradle', 'pom.xml', 'CMakeLists.txt',
            'Makefile', 'mix.exs'
        ];

        // 1. Direct filesystem check for root manifests (100% reliable, independent of indexer exclusions/warmup)
        const hasRootManifest = manifestNames.some(name => fs.existsSync(path.join(root, name)));

        // 2. Indexer check for monorepos or nested subfolders
        const hasNestedManifest = this.index.fileTree.some(file => {
            const parts = file.relativePath.split(/[\\/]/);
            const fileName = parts[parts.length - 1];
            // Only consider it a project manifest if it's at the root level or 1 level deep
            return parts.length <= 2 && manifestNames.includes(fileName);
        });

        return {
            isProject: true,
            hasBlueprint: this.essenceCache.hasBlueprint,
            hasSkill: this.essenceCache.hasSkill,
            needsEssence: hasGit || hasRootManifest || hasNestedManifest
        };
    }

    /**
     * Returns context string for injecting into the system prompt.
     * Token-safe: each file is capped at MAX_ESSENCE_CHARS (~2000 tokens).
     * Uses cached content — no synchronous I/O.
     */
    public getEssenceContext(): string {
        let context = '';
        const maxChars = WorkspaceIndexService.MAX_ESSENCE_CHARS;

        if (this.essenceCache.blueprint) {
            const content = this.essenceCache.blueprint.length > maxChars
                ? this.essenceCache.blueprint.substring(0, maxChars) + '\n... (truncated — full file is ' + this.essenceCache.blueprint.length + ' chars)'
                : this.essenceCache.blueprint;
            context += `\n\n--- WORKSPACE BLUEPRINT (blueprint.md) ---\n${content}\n`;
        }

        if (this.essenceCache.skill) {
            const content = this.essenceCache.skill.length > maxChars
                ? this.essenceCache.skill.substring(0, maxChars) + '\n... (truncated — full file is ' + this.essenceCache.skill.length + ' chars)'
                : this.essenceCache.skill;
            context += `\n\n--- WORKSPACE SKILLS (skill.md) ---\n${content}\n`;
        }

        return context;
    }

    /**
     * Build or rebuild the file tree index.
     * Excludes: caches, virtual envs, binaries, lock files, IDE configs, etc.
     * Only indexes source code, config, and documentation files.
     */
        /**
     * Rebuilds the in-memory index of workspace files, ignoring build outputs.
     */
public async refresh(currentChatId?: string): Promise<void> {
        // Comprehensive glob exclusion — covers all major ecosystems
        const excludeGlob = [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/.git/**',
            '**/out/**',
            '**/.vscode/**',
            '**/__pycache__/**',
            '**/.venv/**',
            '**/venv/**',
            '**/env/**',
            '**/.env/**',
            '**/.tox/**',
            '**/*.egg-info/**',
            '**/.mypy_cache/**',
            '**/.pytest_cache/**',
            '**/.ruff_cache/**',
            '**/target/**',          // Rust/Java build output
            '**/.gradle/**',
            '**/.idea/**',
            '**/.vs/**',
            '**/bin/**',
            '**/obj/**',             // .NET build
            '**/vendor/**',          // Go/PHP vendor
            '**/coverage/**',
            '**/.next/**',
            '**/.nuxt/**',
            '**/.svelte-kit/**',
            '**/.turbo/**',
            '**/.cache/**',
            '**/.parcel-cache/**',
            '**/tmp/**',
            '**/.DS_Store',
            '**/Thumbs.db',
        ].join(',');

        const files = await vscode.workspace.findFiles('**/*', `{${excludeGlob}}`);

        // Post-filter: only keep files with meaningful extensions
        const relevantExtensions = new Set([
            // Source code
            'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
            'py', 'pyi', 'pyw',
            'rs', 'go', 'java', 'kt', 'kts', 'scala',
            'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
            'cs', 'fs', 'fsx',
            'rb', 'php', 'swift', 'dart', 'lua', 'zig',
            'r', 'R', 'jl', 'ex', 'exs', 'erl', 'hrl',
            'vue', 'svelte', 'astro',
            'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
            'sql', 'graphql', 'gql', 'prisma',
            'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
            // Config & docs
            'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
            'xml', 'plist',
            'md', 'mdx', 'rst', 'txt', 'adoc',
            'env', 'env.local', 'env.example',
            'dockerfile', 'containerfile',
            'makefile', 'cmake',
            'tf', 'hcl',                      // Terraform
            'proto',                           // Protobuf
            // Project files
            // 'lock' — intentionally excluded: lock files waste tokens with no useful AI context
            'gitignore', 'dockerignore', 'eslintrc', 'prettierrc',
        ]);

        // Also allow files without extensions if they are common config files
        const allowedNoExt = new Set([
            'Makefile', 'Dockerfile', 'Containerfile', 'Rakefile', 'Gemfile',
            'Procfile', 'Vagrantfile', 'Brewfile', 'Justfile',
            '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc',
            '.prettierrc', '.babelrc', '.env', '.env.local', '.env.example',
        ]);

        // Binary/generated extensions to always skip
        const binaryExtensions = new Set([
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'avif',
            'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mkv', 'mov',
            'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'woff', 'woff2', 'ttf', 'otf', 'eot',
            'pyc', 'pyo', 'class', 'o', 'so', 'dll', 'dylib', 'exe',
            'wasm', 'map', 'vsix',
            'min.js', 'min.css',
            'db', 'sqlite', 'sqlite3',
        ]);

        this.index.fileTree = files
            .filter(uri => {
                const rel = vscode.workspace.asRelativePath(uri);
                const fileName = rel.split(/[\\/]/).pop() || '';
                const ext = fileName.split('.').pop()?.toLowerCase() || '';

                // Skip binary files
                if (binaryExtensions.has(ext)) { return false; }

                // Exclude artifacts from OTHER sessions
                if (rel.includes('.kdaina/artifacts/sessions/')) {
                    if (!currentChatId) { return false; } // If no active session, exclude all session artifacts
                    if (!rel.includes(`.kdaina/artifacts/sessions/${currentChatId}/`)) {
                        return false;
                    }
                }

                // Allow known config files with no extension
                if (!ext || ext === fileName.toLowerCase()) {
                    return allowedNoExt.has(fileName);
                }

                return relevantExtensions.has(ext);
            })
            .map(uri => {
                const rel = vscode.workspace.asRelativePath(uri);
                const ext = uri.fsPath.split('.').pop()?.toLowerCase() || '';
                return {
                    path: uri.fsPath,
                    relativePath: rel,
                    size: 0,
                    language: ext
                };
            })
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

        this.index.lastUpdated = Date.now();

        // Seed/refresh essence cache alongside the file index
        await this.refreshEssenceCache();

        this._onDidUpdate.fire(this.index.fileTree.length);
    }

    /**
     * Returns a compact file tree string for the AI (token-efficient).
     * Full tree mode: every file listed (legacy behaviour, used by list_workspace tool).
     */
    public getFileTreeString(): string {
        if (this.index.fileTree.length === 0) {
            return 'Workspace index is empty. Call refresh first.';
        }

        let tree = '';
        let prevParts: string[] = [];

        for (const file of this.index.fileTree) {
            const parts = file.relativePath.split(/[\\/]/);
            const fileName = parts.pop()!;

            // Print new directories
            let commonLen = 0;
            while (commonLen < parts.length && commonLen < prevParts.length && parts[commonLen] === prevParts[commonLen]) {
                commonLen++;
            }

            for (let i = commonLen; i < parts.length; i++) {
                tree += '  '.repeat(i) + parts[i] + '/\n';
            }

            tree += '  '.repeat(parts.length) + fileName + '\n';
            prevParts = parts;
        }

        return tree;
    }

    /**
     * Returns a COMPACT tree string that summarises large directories.
     * Directories with > maxFilesPerDir files get collapsed to "{dir}/ (N files)".
     * Top-level files and key directories (src, lib, app) are always expanded.
     * This dramatically reduces token count for large projects.
     */
    public getCompactTreeString(maxFilesPerDir: number = 8): string {
        if (this.index.fileTree.length === 0) {
            return '(empty workspace)';
        }

        // Group files by their top-level directory
        const rootFiles: string[] = [];
        const dirMap = new Map<string, string[]>(); // dir -> list of relative paths under it

        for (const file of this.index.fileTree) {
            const parts = file.relativePath.split(/[\\/]/);
            if (parts.length === 1) {
                rootFiles.push(parts[0]);
            } else {
                const topDir = parts[0];
                if (!dirMap.has(topDir)) {
                    dirMap.set(topDir, []);
                }
                dirMap.get(topDir)!.push(file.relativePath);
            }
        }

        let tree = '';

        // Root files first
        for (const f of rootFiles) {
            tree += f + '\n';
        }

        // Key directories that should always be expanded
        const keyDirs = new Set(['src', 'lib', 'app', 'pages', 'components', 'webview', 'test', 'tests', '__tests__']);

        // Directories
        for (const [dir, files] of dirMap.entries()) {
            const shouldExpand = keyDirs.has(dir) || files.length <= maxFilesPerDir;

            if (shouldExpand) {
                // Build a mini-tree for this directory
                let prevParts: string[] = [];
                for (const relPath of files) {
                    const parts = relPath.split(/[\\/]/);
                    const fileName = parts.pop()!;

                    let commonLen = 0;
                    while (commonLen < parts.length && commonLen < prevParts.length && parts[commonLen] === prevParts[commonLen]) {
                        commonLen++;
                    }
                    for (let i = commonLen; i < parts.length; i++) {
                        tree += '  '.repeat(i) + parts[i] + '/\n';
                    }
                    tree += '  '.repeat(parts.length) + fileName + '\n';
                    prevParts = parts;
                }
            } else {
                // Collapse: just show directory name and count
                // But list unique subdirectories as hints
                const subDirs = new Set<string>();
                const exts = new Map<string, number>();
                for (const relPath of files) {
                    const parts = relPath.split(/[\\/]/);
                    if (parts.length > 2) {
                        subDirs.add(parts[1]);
                    }
                    const ext = relPath.split('.').pop()?.toLowerCase() || '';
                    exts.set(ext, (exts.get(ext) || 0) + 1);
                }

                const extSummary = Array.from(exts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([ext, count]) => `${count} .${ext}`)
                    .join(', ');

                tree += `${dir}/ (${files.length} files: ${extSummary})`;
                if (subDirs.size > 0) {
                    tree += ` [subdirs: ${Array.from(subDirs).slice(0, 6).join(', ')}]`;
                }
                tree += '\n';
            }
        }

        return tree;
    }

    /**
     * Get the raw file list (for tool results)
     */
    public getFileList(): string[] {
        return this.index.fileTree.map(f => f.relativePath);
    }

    /**
     * Get the full FileEntry objects (path, relativePath, size, language)
     */
    public getFileEntries(): FileEntry[] {
        return this.index.fileTree;
    }

    // ─── SKELETON CACHE ────────────────────────────────────────────────

    /**
     * Get a cached skeleton for a file path. Returns null if not cached or stale.
     */
    public getCachedSkeleton(absPath: string): { skeleton: string; totalLines: number } | null {
        const cached = this.skeletonCache.get(absPath);
        if (!cached) { return null; }

        // Check freshness — invalidate if file was modified
        try {
            const stat = fs.statSync(absPath);
            if (stat.mtimeMs > cached.mtime) {
                this.skeletonCache.delete(absPath);
                return null;
            }
        } catch {
            this.skeletonCache.delete(absPath);
            return null;
        }

        return { skeleton: cached.skeleton, totalLines: cached.totalLines };
    }

    /**
     * Store a skeleton in the cache
     */
    public cacheSkeleton(absPath: string, skeleton: string, totalLines: number): void {
        let mtime = Date.now();
        try {
            const stat = fs.statSync(absPath);
            mtime = stat.mtimeMs;
        } catch { /* use current time as fallback */ }

        this.skeletonCache.set(absPath, { skeleton, totalLines, mtime });

        // Evict old entries if cache is too large
        if (this.skeletonCache.size > 100) {
            const oldest = this.skeletonCache.keys().next().value;
            if (oldest) { this.skeletonCache.delete(oldest); }
        }
    }

    // ─── ACTIVE EDITOR CONTEXT ─────────────────────────────────────────

    /**
     * Returns context for the user's active editor state.
     * - The FOCUSED editor gets full AST skeleton + cursor context.
     * - Other visible editors are listed as a compact manifest (name + line count).
     * The agent can use read_file_skeleton to pull details for other files on-demand.
     */
    public async getActiveEditorContext(): Promise<string> {
        const activeEditor = vscode.window.activeTextEditor;
        const visibleEditors = vscode.window.visibleTextEditors;

        if (!activeEditor && visibleEditors.length === 0) { return ''; }

        const sections: string[] = [];
        const seen = new Set<string>();

        // ── 1. Full context for the FOCUSED editor ──────────────────────
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            const uri = activeEditor.document.uri;
            seen.add(uri.fsPath);
            const relPath = vscode.workspace.asRelativePath(uri);
            const content = activeEditor.document.getText();
            const lines = content.split('\n');

            let skeletonLines: string[] = [];
            const astSkeleton = await this.buildAstSkeleton(uri);
            if (astSkeleton) {
                skeletonLines = astSkeleton.split('\n');
            } else {
                skeletonLines = this.extractSkeleton(lines);
            }

            const cursorLine = activeEditor.selection.active.line;
            const cursorStart = Math.max(0, cursorLine - 5);
            const cursorEnd = Math.min(lines.length - 1, cursorLine + 5);
            const cursorContext = lines.slice(cursorStart, cursorEnd + 1)
                .map((l, i) => `L${cursorStart + i + 1}: ${l}`)
                .join('\n');

            let errorText = '';
            const diagnostics = vscode.languages.getDiagnostics(uri);
            const activeErrors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (activeErrors.length > 0) {
                errorText = `\n--- active compile errors ---\n` + activeErrors
                    .map(d => `L${d.range.start.line + 1}: ${d.message}`)
                    .join('\n') + `\n`;
            }

            const skeletonStr = skeletonLines.length > 0 ? skeletonLines.join('\n') + '\n' : '';
            sections.push(`[ACTIVE] ${relPath} (${lines.length} lines, cursor at L${cursorLine + 1})\n${skeletonStr}${errorText}--- cursor context ---\n${cursorContext}`);
        }

        // ── 2. Lightweight manifest for other visible editors ───────────
        const otherFiles: string[] = [];
        for (const editor of visibleEditors) {
            const uri = editor.document.uri;
            if (uri.scheme !== 'file') { continue; }
            if (seen.has(uri.fsPath)) { continue; }
            seen.add(uri.fsPath);
            const relPath = vscode.workspace.asRelativePath(uri);
            const lineCount = editor.document.lineCount;
            otherFiles.push(`  - ${relPath} (${lineCount} lines)`);
        }

        if (otherFiles.length > 0) {
            sections.push(`[OTHER OPEN FILES] Use read_file_skeleton to inspect these if needed:\n${otherFiles.join('\n')}`);
        }

        return sections.join('\n\n');
    }

    /**
     * Build an AST skeleton by querying the language server symbols.
     * Recursively formats the tree into a flat text list with line numbers.
     */
    public async buildAstSkeleton(uri: vscode.Uri): Promise<string | null> {
        try {
            const symbols: vscode.DocumentSymbol[] | undefined = await vscode.commands.executeCommand(
                'vscode.executeDocumentSymbolProvider', uri
            );

            if (!symbols || symbols.length === 0) {
                return null;
            }

            const out: string[] = [];
            this.formatSymbolsRecursively(symbols, out, 0);
            return out.join('\n');
        } catch {
            return null;
        }
    }

    private formatSymbolsRecursively(symbols: vscode.DocumentSymbol[], out: string[], depth: number) {
        // Sort symbols by line number
        symbols.sort((a, b) => a.range.start.line - b.range.start.line);

        for (const sym of symbols) {
            // Filter out Variable/Constant noise unless they are at the root
            if (depth > 0 && (sym.kind === vscode.SymbolKind.Variable || sym.kind === vscode.SymbolKind.Constant)) {
                continue;
            }

            const indent = '  '.repeat(depth);
            const kindName = vscode.SymbolKind[sym.kind] || 'Unknown';
            const lineNum = sym.range.start.line + 1;

            out.push(`L${lineNum}: ${indent}[${kindName}] ${sym.name}`);

            if (sym.children && sym.children.length > 0) {
                this.formatSymbolsRecursively(sym.children, out, depth + 1);
            }
        }
    }

    /**
     * Extract skeleton lines from file content (imports, exports, signatures)
     */
    private extractSkeleton(lines: string[]): string[] {
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
        return skeleton;
    }

    /**
     * Use VS Code's built-in document symbol provider (Language Server)
     * Returns function/class signatures for a given file.
     */
    public async getFileSymbols(filePath: string): Promise<SymbolEntry[]> {
        const uri = vscode.Uri.file(filePath);
        const symbols: vscode.DocumentSymbol[] | undefined = await vscode.commands.executeCommand(
            'vscode.executeDocumentSymbolProvider', uri
        );

        if (!symbols) { return []; }

        const results: SymbolEntry[] = [];
        this.flattenSymbols(symbols, filePath, results);
        return results;
    }

    private flattenSymbols(symbols: vscode.DocumentSymbol[], filePath: string, out: SymbolEntry[], container = ''): void {
        for (const sym of symbols) {
            out.push({
                name: sym.name,
                kind: vscode.SymbolKind[sym.kind],
                containerName: container,
                range: { startLine: sym.range.start.line + 1, endLine: sym.range.end.line + 1 },
                filePath: filePath
            });

            if (sym.children && sym.children.length > 0) {
                this.flattenSymbols(sym.children, filePath, out, sym.name);
            }
        }
    }

    /**
     * Search workspace using VS Code's built-in workspace symbol provider
     */
    public async findSymbol(query: string): Promise<SymbolEntry[]> {
        const symbols: vscode.SymbolInformation[] | undefined = await vscode.commands.executeCommand(
            'vscode.executeWorkspaceSymbolProvider', query
        );

        if (!symbols) { return []; }

        return symbols.slice(0, 30).map(sym => ({
            name: sym.name,
            kind: vscode.SymbolKind[sym.kind],
            containerName: sym.containerName,
            range: {
                startLine: sym.location.range.start.line + 1,
                endLine: sym.location.range.end.line + 1
            },
            filePath: sym.location.uri.fsPath
        }));
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
