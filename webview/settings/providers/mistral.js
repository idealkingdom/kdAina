import { BaseProvider } from './base.js';

export class MistralProvider extends BaseProvider {
    constructor() {
        super('Mistral');
    }

    getDefaults() {
        return {
            apiKey: '',
            baseUrl: 'https://api.mistral.ai/v1',
            textModel: 'mistral-large-latest',
            imageModel: 'mistral-large-latest'
        };
    }
}
