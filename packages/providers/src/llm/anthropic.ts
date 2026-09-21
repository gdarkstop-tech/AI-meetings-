import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LLMJsonRequest, LLMJsonResult, LLMProvider } from '../types.js';

/**
 * Anthropic Claude adapter.
 *
 * Uses structured outputs (`output_config.format` with a Zod schema) so the
 * model returns schema-valid JSON; anything that fails validation is an error,
 * never a "best effort" object. Pricing below is the published rate for the
 * configured model as of 2026-09-21 and is recorded per call in provider_calls.
 */
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly modelVersion: string;
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicConfig) {
    this.modelVersion = config.model ?? 'claude-opus-5';
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async completeJson<T>(request: LLMJsonRequest<T>): Promise<LLMJsonResult<T>> {
    try {
      const response = await this.client.messages.parse({
        model: this.modelVersion,
        max_tokens: request.maxTokens ?? this.config.maxTokens ?? 16000,
        system: request.system,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: request.effort ?? this.config.effort ?? 'high',
          format: zodOutputFormat(request.schema),
        },
        messages: [{ role: 'user', content: request.userContent }],
      });

      if (response.stop_reason === 'refusal') {
        throw new Error(`Model declined the request (${response.stop_details?.category ?? 'unspecified'}).`);
      }
      const parsed = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        throw new Error('Model returned no parsable structured output.');
      }

      const pricing = PRICING_PER_MTOK[this.modelVersion];
      const inputTokens = response.usage.input_tokens ?? 0;
      const outputTokens = response.usage.output_tokens ?? 0;
      return {
        value: parsed as T,
        modelVersion: response.model ?? this.modelVersion,
        usage: {
          inputTokens,
          outputTokens,
          costUsd: pricing
            ? Number(((inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output).toFixed(6))
            : undefined,
        },
      };
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new Error('Claude rate limit reached; the job will retry with backoff.');
      }
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error('Claude rejected the configured API key.');
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Claude API error ${error.status}: ${error.message}`);
      }
      throw error;
    }
  }
}
