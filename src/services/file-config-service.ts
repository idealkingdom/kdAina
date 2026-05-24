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
    scope: 'global' | 'agent' | 'disabled';
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
                            const existing = agentsMap.get(parsed.id);
                            if (existing && existing.isDefault) {
                                parsed.order = existing.order;
                                parsed.isBuiltinOverride = true;
                                if (!parsed.description && existing.description) {
                                    parsed.description = existing.description;
                                }
                            }
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
                description: metadata.description || undefined,
                temperature: metadata.temperature !== undefined ? metadata.temperature : 0.15,
                isDefault,
                isActive: metadata.active !== false,
                callable: metadata.callable === true,
                model: metadata.model || undefined,
                stepBudget: metadata.stepBudget || undefined,
                tools: Array.isArray(metadata.tools) ? metadata.tools : undefined,
                subagents: Array.isArray(metadata.subagents) ? metadata.subagents : undefined,
                rules: Array.isArray(metadata.rules) ? metadata.rules : undefined,
                order: metadata.order !== undefined ? Number(metadata.order) : (isDefault ? (filename === 'architect' ? 1 : 2) : 10),
                filePath
            };
        } catch (e) {
            outputChannel.appendLine(`[FileConfig] Error reading agent file ${filePath}: ${e}`);
            return null;
        }
    }

    private parseRuleFile(filePath: string, isDefault: boolean): RuleDef | null {
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

            const scope = metadata.scope || 'global';

            let truncatedContent = body.trim();
            if (truncatedContent.length > 2000) {
                outputChannel.appendLine(`[FileConfig] Warning: Rule "${filename}" exceeds 2000 characters (${truncatedContent.length}). Truncating.`);
                truncatedContent = truncatedContent.substring(0, 2000) + '...';
            }

            return {
                id: filename,
                name: metadata.name || this.filenameToTitle(filename),
                content: truncatedContent,
                scope: scope as 'global' | 'agent' | 'disabled',
                isDefault,
                filePath
            };
        } catch (e) {
            outputChannel.appendLine(`[FileConfig] Error reading rule file ${filePath}: ${e}`);
            return null;
        }
    }

    public createAgent(name: string, content: string, temperature: number, callable?: boolean, model?: string, stepBudget?: number, tools?: string[], subagents?: string[], rules?: string[]): string {
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
            stepBudget: stepBudget || undefined,
            tools: tools || undefined,
            subagents: subagents || undefined,
            rules: rules || undefined
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
        else if (field === 'tools') { metadata.tools = Array.isArray(value) ? value : undefined; }
        else if (field === 'subagents') { metadata.subagents = Array.isArray(value) ? value : undefined; }
        else if (field === 'rules') { metadata.rules = Array.isArray(value) ? value : undefined; }

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
                    const parsed = this.parseRuleFile(filePath, true);
                    if (parsed) {
                        rulesMap.set(parsed.id, parsed);
                    }
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
                        const parsed = this.parseRuleFile(filePath, false);
                        if (parsed) {
                            rulesMap.set(parsed.id, parsed);
                        }
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
        const frontmatter = {
            name,
            scope: 'global'
        };
        const fileContent = `---\n${yaml.dump(frontmatter)}---\n${content}`;
        fs.writeFileSync(filePath, fileContent, 'utf8');
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

        let content = '';
        try {
            content = fs.readFileSync(rule.filePath, 'utf8');
        } catch (e) {
            content = `---\nname: ${rule.name}\nscope: ${rule.scope}\n---\n${rule.content}`;
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

        if (field === 'name') {
            metadata.name = value;
            const newId = this.titleToFilename(value);
            const newPath = path.join(path.dirname(rule.filePath), `${newId}.md`);
            const fileContent = `---\n${yaml.dump(metadata)}---\n${body.trim()}`;
            fs.writeFileSync(newPath, fileContent, 'utf8');
            if (fs.existsSync(rule.filePath) && rule.filePath !== newPath) {
                fs.unlinkSync(rule.filePath);
            }
        } else if (field === 'content') {
            body = value;
            const fileContent = `---\n${yaml.dump(metadata)}---\n${body.trim()}`;
            fs.writeFileSync(rule.filePath, fileContent, 'utf8');
        } else if (field === 'scope') {
            metadata.scope = value;
            const fileContent = `---\n${yaml.dump(metadata)}---\n${body.trim()}`;
            fs.writeFileSync(rule.filePath, fileContent, 'utf8');
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

    // ─── PROVIDER CRUD ─────────────────────────────────────────────────

    public createProvider(name: string, baseUrl: string): string {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) { throw new Error('No workspace folder open'); }
        const wsProvidersPath = path.join(ws.uri.fsPath, '.kdaina', 'providers');
        if (!fs.existsSync(wsProvidersPath)) {
            fs.mkdirSync(wsProvidersPath, { recursive: true });
        }
        const id = this.titleToFilename(name);
        const filePath = path.join(wsProvidersPath, `${id}.yaml`);
        const content = yaml.dump({
            name,
            baseUrl,
            models: { text: [], image: [] },
            supportsReasoning: [],
            tiers: {}
        });
        fs.writeFileSync(filePath, content, 'utf8');
        this._onDidUpdateProviders.fire(this.getProviders());
        return id;
    }

    public deleteProvider(id: string) {
        const providers = this.getProviders();
        const provider = Object.values(providers).find(p => p.id === id);
        if (!provider) { throw new Error(`Provider ${id} not found`); }
        if (provider.isDefault) { throw new Error('Cannot delete built-in provider'); }
        if (fs.existsSync(provider.filePath)) {
            fs.unlinkSync(provider.filePath);
        }
        this._onDidUpdateProviders.fire(this.getProviders());
    }

    public addModelToProvider(providerId: string, modelName: string, types: ('text' | 'image')[]) {
        const providers = this.getProviders();
        const provider = Object.values(providers).find(p => p.id === providerId);
        if (!provider) { throw new Error(`Provider ${providerId} not found`); }

        // Must clone to workspace if built-in
        let filePath = provider.filePath;
        if (provider.isDefault) {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) { throw new Error('No workspace folder open'); }
            const wsProvidersPath = path.join(ws.uri.fsPath, '.kdaina', 'providers');
            if (!fs.existsSync(wsProvidersPath)) {
                fs.mkdirSync(wsProvidersPath, { recursive: true });
            }
            filePath = path.join(wsProvidersPath, `${providerId}.yaml`);
            fs.copyFileSync(provider.filePath, filePath);
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const data = yaml.load(content) as any || {};
        if (!data.models) { data.models = { text: [], image: [] }; }

        for (const type of types) {
            if (!Array.isArray(data.models[type])) { data.models[type] = []; }
            if (!data.models[type].includes(modelName)) {
                data.models[type].push(modelName);
            }
        }

        fs.writeFileSync(filePath, yaml.dump(data), 'utf8');
        this._onDidUpdateProviders.fire(this.getProviders());
    }

    public removeModelFromProvider(providerId: string, modelName: string) {
        const providers = this.getProviders();
        const provider = Object.values(providers).find(p => p.id === providerId);
        if (!provider) { throw new Error(`Provider ${providerId} not found`); }

        let filePath = provider.filePath;
        if (provider.isDefault) {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) { throw new Error('No workspace folder open'); }
            const wsProvidersPath = path.join(ws.uri.fsPath, '.kdaina', 'providers');
            if (!fs.existsSync(wsProvidersPath)) {
                fs.mkdirSync(wsProvidersPath, { recursive: true });
            }
            filePath = path.join(wsProvidersPath, `${providerId}.yaml`);
            fs.copyFileSync(provider.filePath, filePath);
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const data = yaml.load(content) as any || {};
        if (data.models) {
            if (Array.isArray(data.models.text)) {
                data.models.text = data.models.text.filter((m: string) => m !== modelName);
            }
            if (Array.isArray(data.models.image)) {
                data.models.image = data.models.image.filter((m: string) => m !== modelName);
            }
        }
        if (data.supportsReasoning && Array.isArray(data.supportsReasoning)) {
            data.supportsReasoning = data.supportsReasoning.filter((m: string) => m !== modelName);
        }
        if (data.tiers && data.tiers[modelName]) {
            delete data.tiers[modelName];
        }

        fs.writeFileSync(filePath, yaml.dump(data), 'utf8');
        this._onDidUpdateProviders.fire(this.getProviders());
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
