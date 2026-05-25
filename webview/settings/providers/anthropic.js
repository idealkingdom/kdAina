import { BaseProvider } from './base.js';

export class AnthropicProvider extends BaseProvider {
    constructor() {
        super('Anthropic');
    }

    getDefaults() {
        return {
            apiKey: '',
            baseUrl: 'https://api.anthropic.com/v1',
            textModel: 'claude-3-5-sonnet-latest',
            imageModel: 'claude-3-5-sonnet-latest'
        };
    }
}
