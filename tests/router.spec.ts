import { describe, expect, it } from 'vitest'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { classify } from '../src/classifier.ts'
import { resolveConfig } from '../src/config.ts'
import { chooseEscalation, chooseFallback, isEscalationTriggered, isFallbackTriggered } from '../src/fallback.ts'
import { detectManualOverride } from '../src/index.ts'
import { ModelRegistry } from '../src/registry.ts'
import { pickBest, scoreModels } from '../src/scoring.ts'
import type { RegisteredModel, TaskProfile } from '../src/types.ts'

function textMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function imageMessage(): UserMessage {
  return createUserMessage({ content: [{ type: 'image', attachment: {} as never }], source: { kind: 'user' } })
}

function model(provider: string, id: string, opts: {
  vision?: boolean
  coding?: number
  reasoning?: number
  toolCalling?: number
  cost?: number
  latency?: number
  context?: number
} = {}): RegisteredModel {
  return {
    provider,
    model: id,
    name: id,
    inputModalities: new Set(opts.vision === true ? ['text', 'image'] : ['text']),
    capability: {
      coding: opts.coding ?? 0.5,
      reasoning: opts.reasoning ?? 0.5,
      toolCalling: opts.toolCalling ?? 0.5,
      vision: opts.vision === true ? 1 : 0,
      cost: opts.cost ?? 3,
      latency: opts.latency ?? 3,
      ...(opts.context === undefined ? {} : { context: opts.context }),
    },
  }
}

function codingTask(complexity: number, labels: TaskProfile['labels'] = new Set(['coding'])): TaskProfile {
  return { labels, hasImage: false, complexity, estimatedContext: 500, reason: 'code' }
}

describe('classifier', () => {
  it('labels code input as coding', () => {
    const task = classify([textMessage('function sort(arr) { return arr.sort() }')])
    expect(task.labels.has('coding')).toBe(true)
  })

  it('labels plain chat as simple_chat', () => {
    const task = classify([textMessage('你好，今天天气怎么样？')])
    expect(task.labels.has('simple_chat')).toBe(true)
  })

  it('labels image input as vision', () => {
    const task = classify([imageMessage(), textMessage('描述这张图')])
    expect(task.labels.has('vision')).toBe(true)
    expect(task.hasImage).toBe(true)
  })

  it('labels long input as long_context and summarization', () => {
    const long = '这是一段很长的内容。'.repeat(2000)
    const task = classify([textMessage(`请总结：${long}`)])
    expect(task.labels.has('long_context')).toBe(true)
    expect(task.labels.has('summarization')).toBe(true)
  })

  it('assigns higher complexity to a code task than to a chat', () => {
    const code = classify([textMessage('function debug() { // 报错 here } ``` nested class')])
    const chat = classify([textMessage('你好')])
    expect(code.complexity).toBeGreaterThan(chat.complexity)
  })
})

describe('scoring (Test 1-4)', () => {
  const flash = model('p', 'flash', { coding: 0.4, cost: 1, latency: 1 })
  const pro = model('p', 'pro', { coding: 0.9, cost: 5, latency: 4 })
  const vl = model('p', 'vl', { vision: true, coding: 0.6, cost: 3, latency: 3 })
  const cfg = resolveConfig({})

  it('Test 1: routes simple coding to the cheap model', () => {
    const scores = scoreModels([flash, pro], codingTask(0.1), cfg)
    const best = pickBest(scores)
    expect(best?.route.model).toBe('flash')
  })

  it('Test 2: routes complex coding to the strong model', () => {
    const scores = scoreModels([flash, pro], codingTask(0.9), cfg)
    const best = pickBest(scores)
    expect(best?.route.model).toBe('pro')
  })

  it('Test 3: routes image input to a vision model', () => {
    const task: TaskProfile = { labels: new Set(['vision']), hasImage: true, complexity: 0.1, estimatedContext: 500, reason: 'vision' }
    const scores = scoreModels([flash, pro, vl], task, cfg)
    const best = pickBest(scores)
    expect(best?.route.model).toBe('vl')
  })

  it('Test 4: excludes non-vision models entirely for image input', () => {
    const task: TaskProfile = { labels: new Set(['vision']), hasImage: true, complexity: 0.9, estimatedContext: 500, reason: 'vision' }
    const scores = scoreModels([flash, pro, vl], task, cfg)
    const servable = scores.filter(s => s.score >= 0)
    expect(servable).toHaveLength(1)
    expect(servable[0]?.route.model).toBe('vl')
  })
})

describe('fallback and escalation (Test 5-6)', () => {
  const flash = model('p1', 'flash', { coding: 0.4, cost: 1, latency: 1 })
  const pro = model('p1', 'pro', { coding: 0.9, cost: 5, latency: 4 })
  const other = model('p2', 'other', { coding: 0.7, cost: 2, latency: 2 })

  it('Test 6: triggers fallback on a transient code', () => {
    const cfg = resolveConfig({})
    expect(isFallbackTriggered(cfg, { message: 'rate limited', code: 'RATE_LIMIT' })).toBe(true)
    expect(isFallbackTriggered(cfg, { message: 'bad input', code: 'EMPTY_RESPONSE' })).toBe(false)
  })

  it('Test 6: fallback prefers an explicit route, else a different provider', () => {
    const cfg = resolveConfig({ fallback: { enabled: true, routes: { RATE_LIMIT: { provider: 'p2', model: 'other' } } } })
    const target = chooseFallback(cfg, { message: 'x', code: 'RATE_LIMIT' }, [flash, pro, other], 'p1')
    expect(target).toEqual({ provider: 'p2', model: 'other' })

    const auto = resolveConfig({ fallback: { enabled: true, routes: {} } })
    const picked = chooseFallback(auto, { message: 'x', code: 'SERVER' }, [flash, pro, other], 'p1')
    expect(picked?.provider).toBe('p2')
  })

  it('Test 5: escalation picks a strictly stronger model', () => {
    const cfg = resolveConfig({})
    expect(isEscalationTriggered(cfg, { message: 'no content', code: 'EMPTY_RESPONSE' })).toBe(true)
    const target = chooseEscalation([flash, pro, other], { provider: 'p1', model: 'flash' })
    expect(target?.provider).toBe('p1')
    expect(target?.model).toBe('pro')
  })

  it('Test 5: escalation returns null when nothing stronger exists', () => {
    const target = chooseEscalation([flash], { provider: 'p1', model: 'flash' })
    expect(target).toBeNull()
  })
})

describe('registry', () => {
  const fakeLlm = {
    listProviders: () => [
      { id: 'p1', name: 'Provider 1' },
      { id: 'p2', name: 'Provider 2' },
    ],
    listModels: async (provider: string): Promise<LlmModelInfo[]> => {
      if (provider === 'p1') {
        return [
          { provider: 'p1', id: 'flash', name: 'Flash', inputModalities: ['text'] },
          { provider: 'p1', id: 'pro', name: 'Pro', inputModalities: ['text'] },
        ]
      }
      if (provider === 'p2') {
        return [{ provider: 'p2', id: 'vl', name: 'Vision', inputModalities: ['text', 'image'] }]
      }
      return []
    },
  } as unknown as LlmRuntime

  it('merges configured capability metadata over registry facts', async () => {
    const registry = new ModelRegistry(fakeLlm, () => resolveConfig({ models: { 'p1/flash': { coding: 0.3, cost: 1 } } }))
    const models = await registry.list()
    expect(models).toHaveLength(3)
    const flash = models.find(m => m.model === 'flash')
    expect(flash?.capability.coding).toBe(0.3)
    expect(flash?.capability.cost).toBe(1)
    const vl = models.find(m => m.model === 'vl')
    expect(vl?.capability.vision).toBe(1)
  })

  it('resolve only returns registered models (security boundary)', async () => {
    const registry = new ModelRegistry(fakeLlm, () => resolveConfig({}))
    expect(await registry.resolve({ provider: 'p1', model: 'flash' })).toBeDefined()
    expect(await registry.resolve({ provider: 'p9', model: 'nope' })).toBeUndefined()
  })
})

describe('manual override (Test 7)', () => {
  it('does not treat the configured default or the router last choice as an override', () => {
    expect(detectManualOverride({ provider: 'p', model: 'flash' }, null, { provider: 'p', model: 'flash' })).toBe(false)
    expect(detectManualOverride({ provider: 'p', model: 'flash' }, 'p/flash', { provider: 'p', model: 'base' })).toBe(false)
  })

  it('treats a caller-changed route as an override', () => {
    expect(detectManualOverride({ provider: 'p', model: 'custom' }, 'p/flash', { provider: 'p', model: 'base' })).toBe(true)
  })

  it('does not treat an empty route as an override', () => {
    expect(detectManualOverride({ provider: '', model: '' }, null, undefined)).toBe(false)
  })
})
