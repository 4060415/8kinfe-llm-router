/**
 * Configuration schema and resolution for the `llm-router` settings namespace.
 *
 * The schema is the shape a configuration surface renders and what an absent
 * section resolves through; a separate `resolveConfig` materializes the same
 * defaults for deployments without a settings provider, so behavior is
 * identical whether the section comes from the document or the composition.
 *
 * @module @deepseek-ai/dsh-llm-router/config
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ModelCapability, ModelRoute } from './types.ts'

/** Settings namespace carrying the router section. */
export const ROUTER_NAMESPACE = settingsNamespace('llm-router')

export type CostPolicy = 'quality_first' | 'balanced' | 'cost_first' | 'speed_first'

/** Configuration for the router plugin. Every field is optional in composition. */
export interface RouterConfig {
  /** Master switch; when false the router is inert. */
  enabled?: boolean
  /** `auto` routes every request; `manual` never overrides the caller's choice. */
  mode?: 'auto' | 'manual'
  /** Emit selection explanation logs. */
  debug?: boolean
  /** Cost/latency posture shaping the score. */
  costPolicy?: CostPolicy
  /** Upper bound on automatic escalation per agent. */
  maxEscalations?: number
  /** Preferred route when classification gives no strong signal. */
  preferred?: ModelRoute
  /** Capability metadata keyed by "provider/model". */
  models?: Record<string, ModelCapability>
  /** Score weights. */
  weights?: {
    capability?: number
    cost?: number
    latency?: number
    context?: number
    toolCalling?: number
  }
  escalation?: {
    enabled?: boolean
    /** Failure codes that trigger escalation toward a stronger model. */
    triggerCodes?: string[]
  }
  fallback?: {
    enabled?: boolean
    /** Optional explicit per-code routes; unlisted codes pick automatically. */
    routes?: Record<string, ModelRoute>
  }
}

/** The same configuration with every default materialized. */
export interface ResolvedRouterConfig {
  enabled: boolean
  mode: 'auto' | 'manual'
  debug: boolean
  costPolicy: CostPolicy
  maxEscalations: number
  preferred: ModelRoute | undefined
  models: Readonly<Record<string, ModelCapability>>
  weights: Readonly<Required<NonNullable<RouterConfig['weights']>>>
  escalation: {
    enabled: boolean
    triggerCodes: readonly string[]
  }
  fallback: {
    enabled: boolean
    routes: Readonly<Record<string, ModelRoute>>
  }
}

const capabilitySchema: z<ModelCapability> = z.object({
  coding: z.number().min(0).max(1),
  reasoning: z.number().min(0).max(1),
  vision: z.number().min(0).max(1),
  toolCalling: z.number().min(0).max(1),
  context: z.number().min(0),
  cost: z.number().min(1).max(5),
  latency: z.number().min(1).max(5),
})

const modelRouteSchema: z<ModelRoute> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})

/** Runtime schema for {@link RouterConfig}. */
export const Config: z<RouterConfig> = z.object({
  enabled: z.boolean().default(true),
  mode: z.union(['auto', 'manual']).default('auto'),
  debug: z.boolean().default(false),
  costPolicy: z.union(['quality_first', 'balanced', 'cost_first', 'speed_first']).default('balanced'),
  maxEscalations: z.natural().default(2),
  preferred: modelRouteSchema,
  models: z.dict(capabilitySchema).default({}),
  weights: z.object({
    capability: z.number().min(0).default(1),
    cost: z.number().min(0).default(0.3),
    latency: z.number().min(0).default(0.3),
    context: z.number().min(0).default(0.2),
    toolCalling: z.number().min(0).default(0.2),
  }).default({ capability: 1, cost: 0.3, latency: 0.3, context: 0.2, toolCalling: 0.2 }),
  escalation: z.object({
    enabled: z.boolean().default(true),
    // Capability failures (not transient/resource failures, which fall back).
    triggerCodes: z.array(z.string()).default(['EMPTY_RESPONSE', 'CONTEXT_WINDOW_EXCEEDED']),
  }).default({ enabled: true, triggerCodes: ['EMPTY_RESPONSE', 'CONTEXT_WINDOW_EXCEEDED'] }),
  fallback: z.object({
    enabled: z.boolean().default(true),
    routes: z.dict(modelRouteSchema).default({}),
  }).default({ enabled: true, routes: {} }),
})

/**
 * Materialize defaults over a composition entry. The schema's own defaults
 * drive the settings-seam resolution; this function makes a settings-less
 * composition behave identically.
 * @param raw - the composition/config entry, possibly partial.
 * @returns a fully defaulted, detached configuration.
 */
export function resolveConfig(raw: RouterConfig | undefined): ResolvedRouterConfig {
  const config = raw ?? {}
  return {
    enabled: config.enabled ?? true,
    mode: config.mode ?? 'auto',
    debug: config.debug ?? false,
    costPolicy: config.costPolicy ?? 'balanced',
    maxEscalations: config.maxEscalations ?? 2,
    preferred: config.preferred,
    models: config.models ?? {},
    weights: {
      capability: config.weights?.capability ?? 1,
      cost: config.weights?.cost ?? 0.3,
      latency: config.weights?.latency ?? 0.3,
      context: config.weights?.context ?? 0.2,
      toolCalling: config.weights?.toolCalling ?? 0.2,
    },
    escalation: {
      enabled: config.escalation?.enabled ?? true,
      triggerCodes: config.escalation?.triggerCodes ?? ['EMPTY_RESPONSE', 'CONTEXT_WINDOW_EXCEEDED'],
    },
    fallback: {
      enabled: config.fallback?.enabled ?? true,
      routes: config.fallback?.routes ?? {},
    },
  }
}
