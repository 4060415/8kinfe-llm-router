/**
 * Fallback and escalation decisions. These are two distinct mechanisms:
 * fallback recovers from a transient/resource failure by trying another route,
 * escalation recovers from a capability failure by moving to a stronger model,
 * bounded by `maxEscalations`.
 *
 * @module @deepseek-ai/dsh-llm-router/fallback
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ResolvedRouterConfig } from './config.ts'
import type { ModelRoute, RegisteredModel } from './types.ts'

/** Transient/resource codes where a different route may succeed. */
export const FALLBACK_CODES = new Set([
  'RATE_LIMIT',
  'QUOTA',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'AUTH',
])

/** Whether a failure should trigger a fallback attempt. */
export function isFallbackTriggered(config: ResolvedRouterConfig, failure: LlmFailure): boolean {
  return config.fallback.enabled && FALLBACK_CODES.has(failure.code)
}

/** Whether a failure should trigger an escalation attempt. */
export function isEscalationTriggered(config: ResolvedRouterConfig, failure: LlmFailure): boolean {
  return config.escalation.enabled && config.escalation.triggerCodes.includes(failure.code)
}

/** Composite model strength used to order escalation and automatic fallback. */
function strength(model: RegisteredModel): number {
  return Math.max(model.capability.coding ?? 0.5, model.capability.reasoning ?? 0.5)
}

/**
 * Pick a fallback route: an explicit `fallback.routes[code]` first, otherwise
 * the strongest model on a DIFFERENT provider (a provider-level failure is not
 * recovered by another model on the same provider).
 * @param excludeProviders - providers already attempted in this fallback chain
 *   (including prior fallback targets); they are skipped so the router never
 *   ping-pongs between two failing providers.
 * @returns a route, or `null` when no alternate provider exists.
 */
export function chooseFallback(
  config: ResolvedRouterConfig,
  failure: LlmFailure,
  candidates: readonly RegisteredModel[],
  failedProvider: string,
  excludeProviders: ReadonlySet<string> = new Set(),
): ModelRoute | null {
  const explicit = config.fallback.routes[failure.code]
  if (explicit !== undefined) return explicit
  const others = candidates.filter(
    model => model.provider !== failedProvider && !excludeProviders.has(model.provider),
  )
  if (others.length === 0) return null
  const best = [...others].sort((a, b) => strength(b) - strength(a))[0]
  if (best === undefined) return null
  return { provider: best.provider, model: best.model }
}

/**
 * Pick an escalation route: the strongest model strictly stronger than the
 * current route. `null` when nothing stronger exists.
 */
export function chooseEscalation(
  candidates: readonly RegisteredModel[],
  currentRoute: ModelRoute,
): ModelRoute | null {
  const current = candidates.find(
    model => model.provider === currentRoute.provider && model.model === currentRoute.model,
  )
  const currentStrength = current === undefined ? 0 : strength(current)
  const stronger = candidates
    .filter(model => strength(model) > currentStrength)
    .sort((a, b) => strength(b) - strength(a))
  const best = stronger[0]
  if (best === undefined) return null
  return { provider: best.provider, model: best.model }
}
