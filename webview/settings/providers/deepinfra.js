import { BaseProvider } from './base.js';

export class DeepInfraProvider extends BaseProvider {
    constructor() {
        super('DeepInfra');
    }

    getDefaults() {
        return {
            apiKey: '',
            baseUrl: 'https://api.deepinfra.com/v1/openai',
            textModel: 'deepseek-ai/DeepSeek-V3',
            imageModel: 'meta-llama/Llama-3.3-70B-Instruct'
        };
    }
}
