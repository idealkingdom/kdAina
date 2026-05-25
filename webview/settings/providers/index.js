import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { AnthropicProvider } from './anthropic.js';
import { MistralProvider } from './mistral.js';
import { OpenRouterProvider } from './openrouter.js';
import { DeepInfraProvider } from './deepinfra.js';
import { GroqProvider } from './groq.js';

class Registry {
    constructor() {
        this.providers = {
            'OpenAI': new OpenAIProvider(),
            'Gemini': new GeminiProvider(),
            'Anthropic': new AnthropicProvider(),
            'Mistral': new MistralProvider(),
            'OpenRouter': new OpenRouterProvider(),
            'DeepInfra': new DeepInfraProvider(),
            'Groq': new GroqProvider()
        };
    }

    get(name) {
        return this.providers[name] || this.providers['OpenAI'];
    }

    getAll() {
        return Object.values(this.providers);
    }
}

export const ProviderRegistry = new Registry();
