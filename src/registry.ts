/**
 * Model Registry: the single source of truth for routing candidates. Candidate
 * models come ONLY from the live LLM registry (`ctx.llm`); capability metadata
 * is layered on from the `llm-router` settings section keyed by "provider/model".
 * No model name is hardcoded anywhere.
 *
 * @module @deepseek-ai/dsh-llm-router/registry
 */

import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ResolvedRouterConfig } from './config.ts'
import type { ModelCapability, ModelRoute, RegisteredModel } from './types.ts'

/** Neutral defaults for capability fields a configuration does not specify. */
const DEFAULT_CAPABILITY: ModelCapability = {
  coding: 0.5,
  reasoning: 0.5,
  toolCalling: 0.5,
  cost: 3,
  latency: 3,
}

/** Merge adapter-discovered model facts with configured capability metadata. */
function toRegistered(info: LlmModelInfo, config: ResolvedRouterConfig): RegisteredModel {
  const modalities = new Set<string>(info.inputModalities ?? ['text'])
  const meta = config.models[`${info.provider}/${info.id}`] ?? {}
  return {
    provider: info.provider,
    model: info.id,
    name: info.name,
    ...(info.description === undefined ? {} : { description: info.description }),
    inputModalities: modalities,
    capability: {
      ...DEFAULT_CAPABILITY,
      // Vision defaults from the adapter's advertised modality; configuration
      // may override it explicitly.
      vision: modalities.has('image') ? 1 : 0,
      ...meta,
    },
  }
}

/**
 * Cached view of every registered model. Rebuilt lazily and invalidated on
 * `llm/adapters-updated`, so a topology change reaches the next request
 * without a restart.
 */
export class ModelRegistry {
  private cache: RegisteredModel[] | null = null

  constructor(
    private readonly llm: LlmRuntime,
    private readonly config: () => ResolvedRouterConfig,
  ) {}

  /** Drop the cache so the next {@link list} re-reads the registry. */
  invalidate(): void {
    this.cache = null
  }

  /** List every registered model across all providers, with capability merged. */
  async list(): Promise<RegisteredModel[]> {
    if (this.cache !== null) return this.cache
    const config = this.config()
    const models: RegisteredModel[] = []
    for (const provider of this.llm.listProviders()) {
      const infos = await this.llm.listModels(provider.id)
      for (const info of infos) {
        models.push(toRegistered(info, config))
      }
    }
    this.cache = models
    return models
  }

  /**
   * Resolve a proposed route against the registry. Returns the registered
   * model, or `undefined` when the route is not a live, registered model. This
   * is the security boundary: a "model recommendation" (e.g. from an LLM) only
   * ever becomes a route after this check passes.
   */
  async resolve(route: ModelRoute): Promise<RegisteredModel | undefined> {
    const all = await this.list()
    return all.find(model => model.provider === route.provider && model.model === route.model)
  }
}
