/**
 * Configurable model router for the DeepSeek Harness.
 *
 * Classifies each request at `agent/pre-step`, scores every model the live LLM
 * registry advertises, and rewrites the selected provider/model at
 * `agent/request`. Recovery composes two distinct mechanisms at
 * `agent/request-error`: fallback (transient/resource failure → another route)
 * and escalation (capability failure → a stronger model, bounded by
 * `maxEscalations`).
 *
 * No model name is hardcoded; candidates come only from the registry, and a
 * proposed route (including an explicit fallback) is only ever applied after
 * {@link ModelRegistry.resolve} confirms it is registered.
 *
 * @module @deepseek-ai/dsh-llm-router
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { classify } from './classifier.ts'
import { Config, ROUTER_NAMESPACE, resolveConfig } from './config.ts'
import type { ResolvedRouterConfig, RouterConfig } from './config.ts'
import { formatSelection } from './explain.ts'
import { chooseEscalation, chooseFallback, isEscalationTriggered, isFallbackTriggered } from './fallback.ts'
import { ModelRegistry } from './registry.ts'
import { pickBest, scoreModels } from './scoring.ts'
import { routeKey } from './types.ts'
import type { ModelRoute, RouterState, TaskProfile } from './types.ts'

export type { CostPolicy, ResolvedRouterConfig, RouterConfig } from './config.ts'
export { Config } from './config.ts'
export type { ModelCapability, ModelScore, RegisteredModel, TaskLabel, TaskProfile } from './types.ts'
export { classify } from './classifier.ts'

export const name = 'llm-router'
export const inject = ['llm', 'agents']

/** Fallback profile used when a request reaches routing without a classification. */
function neutralTask(): TaskProfile {
  return {
    labels: new Set(['simple_chat']),
    hasImage: false,
    complexity: 0,
    estimatedContext: 0,
    reason: 'no classification',
  }
}

/** Split a "provider/model" key back into its route. */
function parseRouteKey(key: string): ModelRoute | null {
  const index = key.indexOf('/')
  if (index <= 0 || index === key.length - 1) return null
  return { provider: key.slice(0, index), model: key.slice(index + 1) }
}

/**
 * Whether a resolved call config represents a caller-made manual override
 * (e.g. `/model` or a UI selection) rather than the router's last choice or
 * the agent's configured default. Exported for testing.
 * @param resolved - the config `next()` produced.
 * @param lastChosen - the "provider/model" key the router last chose, if any.
 * @param base - the agent's configured default route, if any.
 */
export function detectManualOverride(
  resolved: { provider: string; model: string },
  lastChosen: string | null,
  base: { provider?: string; model?: string } | undefined,
): boolean {
  const key = `${resolved.provider}/${resolved.model}`
  const baseKey = base?.provider !== undefined && base?.provider !== ''
    && base?.model !== undefined && base?.model !== ''
    ? `${base.provider}/${base.model}`
    : null
  return resolved.provider !== '' && resolved.model !== '' && key !== lastChosen && key !== baseKey
}

/** Install the router plugin. */
export function apply(ctx: Context, config: RouterConfig = {}): void {
  let current: () => ResolvedRouterConfig = () => resolveConfig(config)
  const registry = new ModelRegistry(ctx.llm, () => current())
  const states = new Map<string, RouterState>()

  const stateFor = (agent: Agent): RouterState => {
    let state = states.get(agent.id)
    if (state === undefined) {
      state = {
        task: null,
        lastChosen: null,
        pendingOverride: null,
        escalations: 0,
        consecutiveFailures: 0,
        fallbackTriedProviders: [],
      }
      states.set(agent.id, state)
    }
    return state
  }

  // Rebuild the cached candidate set when the provider topology changes.
  const disposeAdapters = ctx.on('llm/adapters-updated', () => { registry.invalidate() })

  // Classify at the pre-step boundary so the request waterfall can consume it.
  const disposePreStep = ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    const state = stateFor(payload.agent)
    if (decision.kind === 'reject') {
      state.task = null
      return decision
    }
    // Classify over both the step's claimed messages and the session history.
    // Tool results carrying image blocks (e.g. read_image) commit through the
    // `tool/result` event into session history, not through the inbox's
    // next-step queue, so classifying claimed messages alone would miss the
    // image and misroute a vision follow-up to a non-vision model.
    const history = payload.agent.session.deriveMessages()
    state.task = classify([...decision.messages, ...history])
    state.fallbackTriedProviders = []
    return decision
  })

  // Select provider/model per request.
  const disposeRequest = ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const cfg = current()
    if (!cfg.enabled) return resolved
    const state = stateFor(payload.agent)

    // 1. A pending fallback/escalation target wins and is consumed.
    if (state.pendingOverride !== null) {
      const target = state.pendingOverride
      state.pendingOverride = null
      state.lastChosen = routeKey(target)
      return { ...resolved, provider: target.provider, model: target.model }
    }

    // 2. Manual mode never overrides the caller's choice.
    if (cfg.mode === 'manual') return resolved

    // 3. Detect a manual override (/model or UI selection) and respect it.
    if (detectManualOverride(resolved, state.lastChosen, payload.agent.options)) {
      state.lastChosen = null
      return resolved
    }

    // 4. Classify + score + select.
    const task = state.task ?? neutralTask()
    const candidates = await registry.list()
    const scores = scoreModels(candidates, task, cfg)
    let chosen = pickBest(scores)

    // Preferred model wins simple chats (and rescues an unserviceable pick).
    if ((chosen === null || task.labels.has('simple_chat')) && cfg.preferred !== undefined) {
      const preferred = await registry.resolve(cfg.preferred)
      if (preferred !== undefined) {
        chosen = {
          route: preferred,
          score: 1,
          breakdown: { capability: 0.5, cost: 1, latency: 1, context: 1, toolCalling: 0.5 },
        }
      }
    }

    if (chosen === null) {
      ctx.logger.warn('llm-router: no serviceable model; leaving route unchanged')
      return resolved
    }

    state.lastChosen = routeKey(chosen.route)
    if (cfg.debug) ctx.logger.debug(formatSelection(task, scores, chosen, cfg))

    if (chosen.route.provider === resolved.provider && chosen.route.model === resolved.model) {
      return resolved
    }
    return { ...resolved, provider: chosen.route.provider, model: chosen.route.model }
  })

  // Recover from failures: delegate retry downstream first, then fallback/escalate.
  const disposeError = ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream

    const cfg = current()
    if (!cfg.enabled) return downstream
    const state = stateFor(payload.agent)
    state.consecutiveFailures += 1

    const failure = payload.failure
    const candidates = await registry.list()

    if (isFallbackTriggered(cfg, failure)) {
      const tried = new Set([...state.fallbackTriedProviders, payload.provider])
      const target = chooseFallback(cfg, failure, candidates, payload.provider, tried)
      if (target !== null && await registry.resolve(target) !== undefined) {
        state.pendingOverride = target
        state.fallbackTriedProviders = [...tried, target.provider]
        if (cfg.debug) ctx.logger.debug(`llm-router: fallback ${failure.code} -> ${routeKey(target)}`)
        return { kind: 'retry' }
      }
    }

    if (isEscalationTriggered(cfg, failure) && state.escalations < cfg.maxEscalations) {
      const currentRoute = state.lastChosen === null ? null : parseRouteKey(state.lastChosen)
      if (currentRoute !== null) {
        const target = chooseEscalation(candidates, currentRoute)
        if (target !== null && await registry.resolve(target) !== undefined) {
          state.escalations += 1
          state.pendingOverride = target
          if (cfg.debug) {
            ctx.logger.debug(`llm-router: escalate ${failure.code} -> ${routeKey(target)} (${state.escalations}/${cfg.maxEscalations})`)
          }
          return { kind: 'retry' }
        }
      }
    }

    return downstream
  })

  const disposeDisposed = ctx.on('agent/disposed', (payload) => { states.delete(payload.agent.id) })

  ctx.effect(() => () => {
    disposeAdapters()
    disposePreStep()
    disposeRequest()
    disposeError()
    disposeDisposed()
    states.clear()
  }, 'llm-router: dispose')

  installSettingsSection(ctx, ROUTER_NAMESPACE, Config, config, {
    setSource: (source) => { current = () => resolveConfig(source()) },
    onChange: () => { registry.invalidate() },
  })
}
