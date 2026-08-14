/**
 * Capability scoring and candidate selection. Weighted, deterministic, and
 * cost-policy-aware — the first release is rules + capability, not a learned
 * router.
 *
 * @module @deepseek-ai/dsh-llm-router/scoring
 */

import type { ResolvedRouterConfig } from './config.ts'
import type { ModelScore, RegisteredModel, TaskProfile } from './types.ts'
import { visionCapable } from './vision.ts'

/** 1..5 → 0..1 where 1 is best (lowest cost/latency). */
function levelScore(level: number | undefined): number {
  const value = level ?? 3
  return (6 - value) / 5
}

/** Capability match: 1 when strength covers the demand, else the covered ratio. */
function matchStrength(have: number, need: number): number {
  if (need <= 0) return 1
  return Math.min(1, have / need)
}

/**
 * Capability match: average of the model's strength over the demanded axes.
 * Coding/reasoning demand scales with task complexity, so a cheap model can win
 * simple coding while a stronger one wins complex coding.
 */
function capabilityScore(model: RegisteredModel, task: TaskProfile): number {
  let demanded = 0
  let matched = 0
  if (task.labels.has('vision')) {
    demanded += 1
    matched += visionCapable(model) ? 1 : 0
  }
  if (task.labels.has('coding')) {
    demanded += 1
    matched += matchStrength(model.capability.coding ?? 0.5, 0.4 + 0.6 * task.complexity)
  }
  if (task.labels.has('reasoning')) {
    demanded += 1
    matched += matchStrength(model.capability.reasoning ?? 0.5, 0.4 + 0.6 * task.complexity)
  }
  if (task.labels.has('tool_use')) {
    demanded += 1
    matched += model.capability.toolCalling ?? 0.5
  }
  if (demanded === 0) return 0.5
  return matched / demanded
}

/** Context fit: 1 when the window covers the estimate, else the covered ratio. */
function contextScore(model: RegisteredModel, task: TaskProfile): number {
  const capacity = model.capability.context
  if (capacity === undefined) return 0.5
  if (task.estimatedContext <= 0) return 0.5
  return Math.min(1, capacity / task.estimatedContext)
}

/** Per-policy weight multipliers for capability / cost / latency. */
function policyMultipliers(config: ResolvedRouterConfig): { capability: number; cost: number; latency: number } {
  switch (config.costPolicy) {
    case 'quality_first':
      return { capability: 1, cost: 0, latency: 0 }
    case 'cost_first':
      return { capability: 0.5, cost: 3, latency: 1 }
    case 'speed_first':
      return { capability: 1, cost: 1, latency: 3 }
    case 'balanced':
    default:
      return { capability: 1, cost: 1, latency: 1 }
  }
}

/**
 * Score every candidate against a task. Models that cannot serve the task are
 * retained with a negative score so the caller can surface them in debug logs
 * while `pickBest` filters them out.
 */
export function scoreModels(
  candidates: readonly RegisteredModel[],
  task: TaskProfile,
  config: ResolvedRouterConfig,
): ModelScore[] {
  const w = config.weights
  const policy = policyMultipliers(config)
  const wCapability = w.capability * policy.capability
  const wCost = w.cost * policy.cost
  const wLatency = w.latency * policy.latency
  const total = wCapability + wCost + wLatency + w.context + w.toolCalling

  return candidates.map((model) => {
    const visionOk = !task.labels.has('vision') || visionCapable(model)
    const breakdown = {
      capability: capabilityScore(model, task),
      cost: levelScore(model.capability.cost),
      latency: levelScore(model.capability.latency),
      context: contextScore(model, task),
      toolCalling: task.labels.has('tool_use') ? (model.capability.toolCalling ?? 0.5) : 0.5,
    }
    const raw = (
      wCapability * breakdown.capability
      + wCost * breakdown.cost
      + wLatency * breakdown.latency
      + w.context * breakdown.context
      + w.toolCalling * breakdown.toolCalling
    ) / total
    return { route: model, score: visionOk ? raw : -1, breakdown }
  })
}

/** Highest-scoring serviceable candidate, or `null` when none can serve. */
export function pickBest(scores: readonly ModelScore[]): ModelScore | null {
  let best: ModelScore | null = null
  for (const score of scores) {
    if (score.score < 0) continue
    if (best === null || score.score > best.score) best = score
  }
  return best
}
