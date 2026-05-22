import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { PromptDef } from '../constants';
import { outputChannel } from '../logger';

export interface RuleDef {
    id: string;
    name: string;
    content: string;
    scope: 'global' | 'workspace' | 'assignable';
    isDefault: boolean;
    filePath: string;
}

export interface ProviderDef {
    id: string; // filename without .yaml, e.g. "openai"
    name: string;
    baseUrl: string;
    models: {
        text: string[];
        image: string[];
    };
    supportsReasoning?: string[];
    tiers?: Record<string, 'frontier' | 'mid' | 'small'>;
    filePath: string;
    isDefault: boolean;
}

export class FileConfigService {
    private static instance: FileConfigService;
    private extensionUri!: vscode.Uri;
    private watchers: vscode.FileSystemWatcher[] = [];

    private _onDidUpdateAgents = new vscode.EventEmitter<PromptDef[]>();
    public readonly onDidUpdateAgents = this._onDidUpdateAgents.event;

    private _onDidUpdateRules = new vscode.EventEmitter<RuleDef[]>();
    public readonly onDidUpdateRules = this._onDidUpdateRules.event;

    private _onDidUpdateProviders = new vscode.EventEmitter<Record<string, ProviderDef>>();
    public readonly onDidUpdateProviders = this._onDidUpdateProviders.event;

    public static getInstance(): FileConfigService {
        if (!FileConfigService.instance) {
            FileConfigService.instance = new FileConfigService();
        }
        return FileConfigService.instance;
    }

    public initialize(context: vscode.ExtensionContext) {
        this.extensionUri = context.extensionUri;
        this.setupWatchers();
    }

    private setupWatchers() {
        // Dispose prior watchers
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];

        // Watch .kdaina/agents/*.md, .kdaina/rules/*.md, .kdaina/providers/*.yaml
        const workspaces = vscode.workspace.workspaceFolders || [];
        for (const ws of workspaces) {
            const agentWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(ws, '.kdaina/agents/*.md')
            );
            const ruleWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(ws, '.kdaina/rules/*.md')
            );
            const providerWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(ws, '.kdaina/providers/*.yaml')
            );

            const triggerAgents = () => this._onDidUpdateAgents.fire(this.getAgents());
            const triggerRules = () => this._onDidUpdateRules.fire(this.getRules());
            const triggerProviders = () => this._onDidUpdateProviders.fire(this.getProviders());

            agentWatcher.onDidCreate(triggerAgents);
            agentWatcher.onDidChange(triggerAgents);
            agentWatcher.onDidDelete(triggerAgents);

            ruleWatcher.onDidCreate(triggerRules);
            ruleWatcher.onDidChange(triggerRules);
            ruleWatcher.onDidDelete(triggerRules);

            providerWatcher.onDidCreate(triggerProviders);
            providerWatcher.onDidChange(triggerProviders);
            providerWatcher.onDidDelete(triggerProviders);

            this.watchers.push(agentWatcher, ruleWatcher, providerWatcher);
        }
    }

    // ─── AGENTS ────────────────────────────────────────────────────────
    public getAgents(): PromptDef[] {
        const agentsMap = new Map<string, PromptDef>();

        // 1. Load default agents from resources/agents/
        const defaultsPath = path.join(this.extensionUri.fsPath, 'resources', 'agents');
        if (fs.existsSync(defaultsPath)) {
            try {
                const files = fs.readdirSync(defaultsPath).filter(f => f.endsWith('.md'));
                for (const file of files) {
                    const filePath = path.join(defaultsPath, file);
                    const parsed = this.parseAgentFile(filePath, true);
                    if (parsed) {
                        agentsMap.set(parsed.id, parsed);
                    }
                }
            } catch (e) {
                outputChannel.appendLine(`[FileConfig] Error reading default agents: ${e}`);
            }
        }

        // 2. Load workspace agents from .kdaina/agents/
        const workspaces = vscode.workspace.workspaceFolders || [];
        for (const ws of workspaces) {
            const wsAgentsPath = path.join(ws.uri.fsPath, '.kdaina', 'agents');
            if (fs.existsSync(wsAgentsPath)) {
                try {
                    const files = fs.readdirSync(wsAgentsPath).filter(f => f.endsWith('.md'));
                    for (const file of files) {
                        const filePath = path.join(wsAgentsPath, file);
                        const parsed = this.parseAgentFile(filePath, false);
                        if (parsed) {
                            agentsMap.set(parsed.id, parsed);
                        }
                    }
                } catch (e) {
                    outputChannel.appendLine(`[FileConfig] Error reading workspace agents: ${e}`);
                }
            }
        }

        return Array.from(agentsMap.values()).sort((a, b) => (a.order || 99) - (b.order || 99));
    }

    private parseAgentFile(filePath: string, isDefault: boolean): PromptDef | null {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const filename = path.basename(filePath, '.md');
            
            // Parse frontmatter
            const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
            let metadata: any = {};
            let body = content;

            if (match) {
                try {
                    metadata = yaml.load(match[1]) || {};
                    body = match[2];
                } catch (e) {
                    outputChannel.appendLine(`[FileConfig] Error parsing frontmatter in ${filePath}: ${e}`);
                }
            }

            return {
                id: filename,
                name: metadata.name || this.filenameToTitle(filename),
                content: body.trim(),
                temperature: metadata.temperature !== undefined ? metadata.temperature : 0.15,
                isDefault,
                isActive: metadata.active !== false,
                callable: metadata.callable === true,
                model: metadata.model || undefined,
                stepBudget: metadata.stepBudget || undefined,
                order: isDefault ? (filename === 'architect' ? 1 : 2) : 10,
                filePath
            };
        } catch (e) {
            outputChannel.appendLine(`[FileConfig] Error reading agent file ${filePath}: ${e}`);
            return null;
        }
    }

    public createAgent(name: string, content: string, temperature: number, callable?: boolean, model?: string, stepBudget?: number): string {
        const id = this.titleToFilename(name);
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            throw new Error('No workspace folder open');
        }

        const wsAgentsPath = path.join(ws.uri.fsPath, '.kdaina', 'agents');
        if (!fs.existsSync(wsAgentsPath)) {
            fs.mkdirSync(wsAgentsPath, { recursive: true });
        }

        const filePath = path.join(wsAgentsPath, `${id}.md`);
        const frontmatter = {
            name,
            temperature,
            active: true,
            callable: callable ?? false,
            model: model || undefined,
            stepBudget: stepBudget || undefined
        };

        const fileContent = `---\n${yaml.dump(frontmatter)}---\n${content}`;
        fs.writeFileSync(filePath, fileContent, 'utf8');
        return id;
    }

    public updateAgent(id: string, field: string, value: any) {
        // Find agent file path
        const agents = this.getAgents();
        const agent = agents.find(a => a.id === id);
        if (!agent) {
            throw new Error(`Agent ${id} not found`);
        }
        if (agent.isDefault) {
            // Cannot update default agents in resources directory, clone/save as workspace agent
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) { throw new Error('No workspace folder open to clone default agent'); }
            const wsAgentsPath = path.join(ws.uri.fsPath, '.kdaina', 'agents');
            if (!fs.existsSync(wsAgentsPath)) {
                fs.mkdirSync(wsAgentsPath, { recursive: true });
            }
            agent.filePath = path.join(wsAgentsPath, `${id}.md`);
            agent.isDefault = false;
        }

        let content = '';
        try {
            content = fs.readFileSync(agent.filePath, 'utf8');
        } catch (e) {
            content = `---\nname: ${agent.name}\ntemperature: ${agent.temperature}\n---\n${agent.content}`;
        }

        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        let metadata: any = {};
        let body = content;

        if (match) {
            try {
                metadata = yaml.load(match[1]) || {};
                body = match[2];
            } catch (e) { }
        }

        // Map UI/API fields to frontmatter properties
        if (field === 'name') { metadata.name = value; }
        else if (field === 'temperature') { metadata.temperature = value; }
        else if (field === 'content') { body = value; }
        else if (field === 'isActive') { metadata.active = value; }
        else if (field === 'callable') { metadata.callable = value; }
        else if (field === 'model') { metadata.model = value || undefined; }
        else if (field === 'stepBudget') { metadata.stepBudget = value || undefined; }

        const fileContent = `---\n${yaml.dump(metadata)}---\n${body.trim()}`;
        fs.writeFileSync(agent.filePath, fileContent, 'utf8');
        this._onDidUpdateAgents.fire(this.getAgents());
    }

    public deleteAgent(id: string) {
        const agents = this.getAgents();
        const agent = agents.find(a => a.id === id);
        if (!agent) {
            throw new Error(`Agent ${id} not found`);
        }
        if (agent.isDefault) {
            throw new Error(`Cannot delete built-in agent`);
        }
        if (fs.existsSync(agent.filePath)) {
            fs.unlinkSync(agent.filePath);
        }
        this._onDidUpdateAgents.fire(this.getAgents());
    }

    // ─── RULES ─────────────────────────────────────────────────────────
    public getRules(): RuleDef[] {
        const rulesMap = new Map<string, RuleDef>();

        // 1. Load default rules from resources/rules/
        const defaultsPath = path.join(this.extensionUri.fsPath, 'resources', 'rules');
        if (fs.existsSync(defaultsPath)) {
            try {
                const files = fs.readdirSync(defaultsPath).filter(f => f.endsWith('.md'));
                for (const file of files) {
                    const filePath = path.join(defaultsPath, file);
                    const filename = path.basename(file, '.md');
                    const content = fs.readFileSync(filePath, 'utf8').trim();
                    rulesMap.set(filename, {
                        id: filename,
                        name: this.filenameToTitle(filename),
                        content,
                        scope: 'global',
                        isDefault: true,
                        filePath
                    });
                }
            } catch (e) {
                outputChannel.appendLine(`[FileConfig] Error reading default rules: ${e}`);
            }
        }

        // 2. Load workspace rules from .kdaina/rules/
        const workspaces = vscode.workspace.workspaceFolders || [];
        for (const ws of workspaces) {
            const wsRulesPath = path.join(ws.uri.fsPath, '.kdaina', 'rules');
            if (fs.existsSync(wsRulesPath)) {
                try {
                    const files = fs.readdirSync(wsRulesPath).filter(f => f.endsWith('.md'));
                    for (const file of files) {
                        const filePath = path.join(wsRulesPath, file);
                        const filename = path.basename(file, '.md');
                        const content = fs.readFileSync(filePath, 'utf8').trim();
                        rulesMap.set(filename, {
                            id: filename,
                            name: this.filenameToTitle(filename),
                            content,
                            scope: 'workspace', // Default scope for user-defined rules in workspace
                            isDefault: false,
                            filePath
                        });
                    }
                } catch (e) {
                    outputChannel.appendLine(`[FileConfig] Error reading workspace rules: ${e}`);
                }
            }
        }

        return Array.from(rulesMap.values());
    }

    public createRule(name: string, content: string): string {
        const id = this.titleToFilename(name);
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            throw new Error('No workspace folder open');
        }

        const wsRulesPath = path.join(ws.uri.fsPath, '.kdaina', 'rules');
        if (!fs.existsSync(wsRulesPath)) {
            fs.mkdirSync(wsRulesPath, { recursive: true });
        }

        const filePath = path.join(wsRulesPath, `${id}.md`);
        fs.writeFileSync(filePath, content, 'utf8');
        this._onDidUpdateRules.fire(this.getRules());
        return id;
    }

    public updateRule(id: string, field: string, value: any) {
        const rules = this.getRules();
        const rule = rules.find(r => r.id === id);
        if (!rule) {
            throw new Error(`Rule ${id} not found`);
        }
        if (rule.isDefault) {
            // Clone default rule to workspace to override
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) { throw new Error('No workspace folder open to clone default rule'); }
            const wsRulesPath = path.join(ws.uri.fsPath, '.kdaina', 'rules');
            if (!fs.existsSync(wsRulesPath)) {
                fs.mkdirSync(wsRulesPath, { recursive: true });
            }
            rule.filePath = path.join(wsRulesPath, `${id}.md`);
            rule.isDefault = false;
        }

        if (field === 'name') {
            const newId = this.titleToFilename(value);
            const newPath = path.join(path.dirname(rule.filePath), `${newId}.md`);
            if (fs.existsSync(rule.filePath)) {
                fs.renameSync(rule.filePath, newPath);
            } else {
                fs.writeFileSync(newPath, rule.content, 'utf8');
            }
        } else if (field === 'content') {
            fs.writeFileSync(rule.filePath, value, 'utf8');
        }

        this._onDidUpdateRules.fire(this.getRules());
    }

    public deleteRule(id: string) {
        const rules = this.getRules();
        const rule = rules.find(r => r.id === id);
        if (!rule) {
            throw new Error(`Rule ${id} not found`);
        }
        if (rule.isDefault) {
            throw new Error(`Cannot delete built-in rule`);
        }
        if (fs.existsSync(rule.filePath)) {
            fs.unlinkSync(rule.filePath);
        }
        this._onDidUpdateRules.fire(this.getRules());
    }

    // ─── PROVIDERS (MODELS) ────────────────────────────────────────────
    public getProviders(): Record<string, ProviderDef> {
        const providers: Record<string, ProviderDef> = {};

        // 1. Load default providers from resources/providers/
        const defaultsPath = path.join(this.extensionUri.fsPath, 'resources', 'providers');
        if (fs.existsSync(defaultsPath)) {
            try {
                const files = fs.readdirSync(defaultsPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
                for (const file of files) {
                    const filePath = path.join(defaultsPath, file);
                    const parsed = this.parseProviderFile(filePath, true);
                    if (parsed) {
                        providers[parsed.name] = parsed;
                    }
                }
            } catch (e) {
                outputChannel.appendLine(`[FileConfig] Error reading default providers: ${e}`);
            }
        }

        // 2. Load workspace custom providers from .kdaina/providers/
        const workspaces = vscode.workspace.workspaceFolders || [];
        for (const ws of workspaces) {
            const wsProvidersPath = path.join(ws.uri.fsPath, '.kdaina', 'providers');
            if (fs.existsSync(wsProvidersPath)) {
                try {
                    const files = fs.readdirSync(wsProvidersPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
                    for (const file of files) {
                        const filePath = path.join(wsProvidersPath, file);
                        const parsed = this.parseProviderFile(filePath, false);
                        if (parsed) {
                            providers[parsed.name] = parsed;
                        }
                    }
                } catch (e) {
                    outputChannel.appendLine(`[FileConfig] Error reading workspace custom providers: ${e}`);
                }
            }
        }

        return providers;
    }

    private parseProviderFile(filePath: string, isDefault: boolean): ProviderDef | null {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = yaml.load(content) as any;
            if (!data || !data.name) return null;

            const filename = path.basename(filePath, path.extname(filePath));

            return {
                id: filename,
                name: data.name,
                baseUrl: data.baseUrl || '',
                models: {
                    text: Array.isArray(data.models?.text) ? data.models.text : [],
                    image: Array.isArray(data.models?.image) ? data.models.image : []
                },
                supportsReasoning: Array.isArray(data.supportsReasoning) ? data.supportsReasoning : [],
                tiers: data.tiers || {},
                filePath,
                isDefault
            };
        } catch (e) {
            outputChannel.appendLine(`[FileConfig] Error parsing provider file ${filePath}: ${e}`);
            return null;
        }
    }

    // ─── HELPERS ───────────────────────────────────────────────────────
    private filenameToTitle(filename: string): string {
        return filename
            .split(/[-_]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    private titleToFilename(title: string): string {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }
}
