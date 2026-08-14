/**
 * Coding-task heuristics for the classifier and scorer. Rule-based only — the
 * first release deliberately avoids any learned model.
 *
 * @module @deepseek-ai/dsh-llm-router/coding
 */

import type { TaskProfile } from './types.ts'

/** Loose code markers: keywords, punctuation, and debug/crash vocabulary. */
const CODE_MARKERS = [
  /\b(function|def|class|import|from|return|const|let|var|async|await|export|interface|type|enum)\b/,
  /\b(public|private|protected|static|void|int|float|bool|fn|impl|struct|namespace|package|extends|implements)\b/,
  /[{};]|=>|===|!==|==|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\btry\s*\{|\bcatch\s*\(/,
  /```/,
  /\b(debug|bug|error|traceback|stack ?trace|exception|compile|编译|报错|错误|异常|修复|崩溃)\b/i,
]

const DEBUG_MARKERS = /\b(debug|bug|fix|报错|错误|异常|traceback|stack ?trace|崩溃|修复)\b/i

/** Whether the text reads like a coding task. */
export function isCodeText(text: string): boolean {
  if (text.length === 0) return false
  return CODE_MARKERS.some(marker => marker.test(text))
}

/**
 * A 0..1 coding-complexity estimate from marker density, code fences, and
 * debug/crash vocabulary. Higher values bias toward stronger models.
 * @param text - the assembled request text.
 */
export function codingComplexity(text: string): number {
  if (text.length === 0) return 0
  let score = 0
  const markerHits = CODE_MARKERS.filter(marker => marker.test(text)).length
  score += Math.min(markerHits / CODE_MARKERS.length, 1) * 0.5
  if (/```/.test(text)) score += 0.2
  if (DEBUG_MARKERS.test(text)) score += 0.2
  // Length as a weak proxy for task size.
  score += Math.min(text.length / 6000, 1) * 0.1
  return Math.min(score, 1)
}

/** Whether a profile is a coding task needing coding-aware scoring. */
export function isCodingTask(profile: TaskProfile): boolean {
  return profile.labels.has('coding')
}
