import { BaseProvider } from './base.js';

export class OpenRouterProvider extends BaseProvider {
    constructor() {
        super('OpenRouter');
    }

    getDefaults() {
        return {
            apiKey: '',
            baseUrl: 'https://openrouter.ai/api/v1',
            textModel: 'anthropic/claude-3.5-sonnet',
            imageModel: 'openai/gpt-4o'
        };
    }
}
