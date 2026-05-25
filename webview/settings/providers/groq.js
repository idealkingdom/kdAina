import { BaseProvider } from './base.js';

export class GroqProvider extends BaseProvider {
    constructor() {
        super('Groq');
    }

    getDefaults() {
        return {
            apiKey: '',
            baseUrl: 'https://api.groq.com/openai/v1',
            textModel: 'llama-3.3-70b-versatile',
            imageModel: 'llama-3.3-70b-versatile'
        };
    }
}
