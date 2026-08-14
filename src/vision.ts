/**
 * Vision routing helpers: image detection and capability checks. Kept free of
 * the scorer so it stays independently testable and reusable.
 *
 * @module @deepseek-ai/dsh-llm-router/vision
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { RegisteredModel } from './types.ts'

/** Recursively test content blocks for an image block. */
function blocksHaveImage(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && blocksHaveImage(block.content)) return true
  }
  return false
}

/** Whether any message carries image input. */
export function hasImage(messages: readonly Message[]): boolean {
  return messages.some(message => blocksHaveImage(message.content))
}

/**
 * Whether a model can accept image input. Trusts the adapter's advertised
 * modalities first, then falls back to a configured `vision` capability above
 * zero — the latter covers gateways whose modality the adapter could not probe.
 * @param model - the registered model.
 */
export function visionCapable(model: RegisteredModel): boolean {
  if (model.inputModalities.has('image')) return true
  const vision = model.capability.vision
  return vision !== undefined && vision > 0
}
