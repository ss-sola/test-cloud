export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OpenAiCompatibleRequest {
  ai: OpenAiCompatibleConfig;
  prompt: string;
  systemMessage: string;
  timeoutMs: number;
  maxPromptCharacters: number;
  maxResponseCharacters: number;
  temperature?: number;
}

export type OpenAiCompatibleFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
