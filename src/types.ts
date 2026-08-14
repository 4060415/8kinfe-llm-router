/**
 * Internal types for the model router. Routing never hardcodes a model name:
 * candidates come from the live LLM registry, and capability metadata comes
 * from the `llm-router` settings section keyed by "provider/model".
 *
 * @module @deepseek-ai/dsh-llm-router/types
 */

/** Coarse task labels the classifier assigns; a request may carry several. */
export type TaskLabel =
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'tool_use'
  | 'long_context'
  | 'summarization'
  | 'simple_chat'

/** The classified shape of one incoming request. */
export interface TaskProfile {
  /** Assigned labels. */
  labels: ReadonlySet<TaskLabel>
  /** Whether the request carries image input. */
  hasImage: boolean
  /** 0..1 complexity estimate (code density, length, tool usage). */
  complexity: number
  /** Rough token demand for context-capacity matching. */
  estimatedContext: number
  /** Human-readable summary used by `debug` logging. */
  reason: string
}

/** Capability metadata for one "provider/model" route, supplied by configuration. */
export interface ModelCapability {
  /** 0..1 coding strength. */
  coding?: number
  /** 0..1 reasoning strength. */
  reasoning?: number
  /** 0..1 vision strength (overrides registry modality when present). */
  vision?: number
  /** 0..1 tool-calling strength. */
  toolCalling?: number
  /** Context window in tokens. */
  context?: number
  /** 1..5 cost level (1 = cheapest). */
  cost?: number
  /** 1..5 latency level (1 = fastest). */
  latency?: number
}

/** A live registered model merged with its capability metadata. */
export interface RegisteredModel {
  provider: string
  model: string
  /** From {@link LlmModelInfo}. */
  name?: string
  description?: string
  /** Input modalities advertised by the adapter (e.g. "text", "image"). */
  inputModalities: ReadonlySet<string>
  /** Merged capability metadata (defaults applied). */
  capability: ModelCapability
}

/** Per-dimension contribution of a scored candidate, for debug logs. */
export interface ModelScoreBreakdown {
  capability: number
  cost: number
  latency: number
  context: number
  toolCalling: number
}

/** A scored candidate during selection. */
export interface ModelScore {
  route: RegisteredModel
  score: number
  /** Per-dimension contribution, keyed by dimension name, for debug logs. */
  breakdown: ModelScoreBreakdown
}

/** A provider + model route. */
export interface ModelRoute {
  provider: string
  model: string
}

/** Per-agent runtime state owned by the router plugin. */
export interface RouterState {
  /** Task profile produced by the pre-step classifier, consumed at request time. */
  task: TaskProfile | null
  /** The "provider/model" key the router last chose automatically. */
  lastChosen: string | null
  /** A fallback/escalation target to apply on the next request, then clear. */
  pendingOverride: ModelRoute | null
  /** Escalations already consumed for this agent (bounded by maxEscalations). */
  escalations: number
  /** Consecutive failed requests, used to trigger escalation. */
  consecutiveFailures: number
  /** Providers already tried in the current fallback chain, to avoid ping-pong. */
  fallbackTriedProviders: string[]
}

/** The canonical "provider/model" key used across maps and state. */
export function routeKey(route: ModelRoute): string {
  return `${route.provider}/${route.model}`
}
