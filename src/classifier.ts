/**
 * Rule-based task classification. Reads user content and produces a
 * {@link TaskProfile} consumed by the scorer. No learned model is involved:
 * labels come from content type, keyword heuristics, and length.
 *
 * @module @deepseek-ai/dsh-llm-router/classifier
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { TaskLabel, TaskProfile } from './types.ts'
import { hasImage } from './vision.ts'
import { codingComplexity, isCodeText } from './coding.ts'

const SUMMARY_PATTERN = /(总结|摘要|概括|提炼|summar|summary|tl;dr)/i
const REASON_PATTERN = /(解释|分析|为什么|原因|推理|讲讲|explain|analyz|why|reason|elaborate)/i
/** Image file extensions referenced in text imply a vision task (read_image path). */
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|webp|gif|bmp)\b/i
/** Explicit "look at / describe this image" intent. */
const IMAGE_INTENT_PATTERN = /(看图|读图|识图|这张图|这张图片|图片里|图像里|describe.*image|look at.*image)/i
/** Rough bytes-per-token proxy for context estimation. */
const CHARS_PER_TOKEN = 4
/** Context threshold (tokens) above which a request is "long". */
const LONG_CONTEXT_TOKENS = 4000
/** Message count above which a request is "long". */
const LONG_CONTEXT_MESSAGES = 6

function walkBlocks(blocks: readonly ContentBlock[], texts: string[], sawToolResult: () => void): void {
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') {
      texts.push(block.text)
    } else if (block.type === 'tool-result') {
      sawToolResult()
      walkBlocks(block.content, texts, sawToolResult)
    }
  }
}

/** Collect all user-visible text and note tool-result presence. */
function collect(messages: readonly Message[]): { text: string; hasToolResult: boolean } {
  const texts: string[] = []
  let hasToolResult = false
  for (const message of messages) {
    walkBlocks(message.content, texts, () => { hasToolResult = true })
  }
  return { text: texts.join('\n'), hasToolResult }
}

/**
 * Whether the request's text signals a vision task without an actual image
 * block yet — a referenced image path or an explicit "look at this image"
 * intent. This lets the router switch to a vision-capable model BEFORE the
 * agent calls `read_image`, so that tool's capability gate passes.
 */
function hasImageIntent(text: string): boolean {
  return IMAGE_EXT_PATTERN.test(text) || IMAGE_INTENT_PATTERN.test(text)
}

/**
 * Classify one batch of incoming messages. `messages` are the user messages a
 * step is about to enter (the `agent/pre-step` payload).
 * @returns a detached task profile.
 */
export function classify(messages: readonly Message[]): TaskProfile {
  const { text, hasToolResult } = collect(messages)
  const image = hasImage(messages)
  const imageIntent = hasImageIntent(text)
  const labels = new Set<TaskLabel>()
  const reasons: string[] = []

  if (image || imageIntent) {
    labels.add('vision')
    reasons.push(image ? 'image input' : 'image file reference')
  }

  if (isCodeText(text)) {
    labels.add('coding')
    reasons.push('code task')
  }

  if (hasToolResult) {
    labels.add('tool_use')
    reasons.push('tool loop')
  }

  if (SUMMARY_PATTERN.test(text) && text.length > 200) {
    labels.add('summarization')
    reasons.push('summarization')
  }

  if (REASON_PATTERN.test(text)) {
    labels.add('reasoning')
    reasons.push('reasoning')
  }

  const estimatedContext = Math.ceil(text.length / CHARS_PER_TOKEN)
  if (estimatedContext > LONG_CONTEXT_TOKENS || messages.length > LONG_CONTEXT_MESSAGES) {
    labels.add('long_context')
    reasons.push('long context')
  }

  if (labels.size === 0) {
    labels.add('simple_chat')
    reasons.push('simple chat')
  }

  let complexity = isCodeText(text) ? codingComplexity(text) : 0
  complexity = Math.min(1, complexity + Math.min(text.length / 8000, 1) * 0.2)

  return {
    labels,
    hasImage: image,
    complexity,
    estimatedContext,
    reason: reasons.join(', '),
  }
}
