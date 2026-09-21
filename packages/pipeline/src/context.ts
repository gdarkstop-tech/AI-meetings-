import type { Pool } from '@alia/db';
import type { ProviderRegistry } from '@alia/providers';
import type { Logger } from '@alia/observability';

/** Everything a pipeline step needs, injected rather than imported globally. */
export interface PipelineContext {
  pool: Pool;
  registry: ProviderRegistry;
  log: Logger;
  /** 32-byte key for integration-token encryption. */
  secretsKey: Buffer;
  publicBaseUrl: string | null;
}
