/**
 * Debug formatting for selection explanations. Enabled via `debug: true`.
 *
 * @module @deepseek-ai/dsh-llm-router/explain
 */

import type { ResolvedRouterConfig } from './config.ts'
import type { ModelScore, TaskProfile } from './types.ts'

/** Render one selection decision as a multi-line, human-readable log. */
export function formatSelection(
  task: TaskProfile,
  scores: readonly ModelScore[],
  chosen: ModelScore,
  config: ResolvedRouterConfig,
): string {
  const lines = [
    `llm-router: task=[${task.reason}] complexity=${task.complexity.toFixed(2)} ctx~${task.estimatedContext} policy=${config.costPolicy}`,
    'llm-router: candidates:',
  ]
  for (const score of scores) {
    const b = score.breakdown
    const label = score.score < 0 ? 'skip(no vision)' : score.score.toFixed(3)
    lines.push(
      `  - ${score.route.provider}/${score.route.model} score=${label}`
      + ` (cap=${b.capability.toFixed(2)} cost=${b.cost.toFixed(2)} lat=${b.latency.toFixed(2)}`
      + ` ctx=${b.context.toFixed(2)} tool=${b.toolCalling.toFixed(2)})`,
    )
  }
  lines.push(`llm-router: chose ${chosen.route.provider}/${chosen.route.model}`)
  return lines.join('\n')
}
