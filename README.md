# 8kinfe-llm-router

可配置的模型自动路由插件：根据每次请求的任务需求，从**已注册的模型**中自动选择最合适的 provider/model，而不是固定使用一个模型。

- 不改 DSH 核心，纯插件实现。
- 模型候选只来自 LLM Registry（`ctx.llm`），**不硬编码任何模型名**。
- 支持视觉（图片）路由、代码任务路由、失败 fallback、能力升级 escalation（有上限）。
- 自动路由可关闭、可手动覆盖、可配置成本/延迟策略。

## 安装

### 从 GitHub 直接安装（推荐）

```bash
npm install github:4060415/8kinfe-llm-router
```

### 从 npm 安装（发布到 npm 后可用）

```bash
npm install 8kinfe-llm-router
```

安装后在你的 profile 的 `cordis.patch.yml` 里挂载本插件（`id` 随意，`name` 必须是包名）：

```yaml
- id: llm-router
  name: '8kinfe-llm-router'
  config:
    mode: auto
    costPolicy: balanced
    maxEscalations: 2
    preferred:
      provider: deepseek-official
      model: deepseek-v4-flash
```

> 本插件是 dsh 生态的**树外插件**，依赖宿主已安装的 `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-settings` / `cordis`（这些由 dsh 本身提供，作为 peerDependencies 声明）。

## 使用教程

### 第 0 步：确认有可路由的模型

Router 只从**已注册**的 Model Registry 里选模型，不硬编码任何模型名。先确认你的 dsh 里注册了至少一个 provider/model：

- **DeepSeek 官方**：dsh 内置 `deepseek-official` provider（在 `.credentials.yaml` 配好 API Key 即可）。
- **其他 OpenAI 兼容 API**（Kimi/月之暗面、阿里百炼、OpenRouter 等）：通过 `dsh-llm-pi-ai` 在 `settings.yaml` 里注册：

```yaml
llm-pi-ai:
  providers:
    moonshotai-cn:
      apiKeyEnv: MOONSHOT_API_KEY   # 从环境变量读 Key
      models:
        - id: kimi-k2.6
        - id: kimi-k2.7-code
```

> `provider` 名（`moonshotai-cn`）和 `model` 名（`kimi-k2.6`）就是后面 Router 配置里要引用的标识。

### 第 1 步：安装插件

进入 dsh 的 profile 目录（通常是 `~/.dsh/profiles/web`）：

```bash
npm install github:4060415/8kinfe-llm-router
```

### 第 2 步：挂载 + 最小配置

编辑该 profile 的 `cordis.patch.yml`：

```yaml
- id: llm-router
  name: '8kinfe-llm-router'
  config:
    mode: auto
    preferred:
      provider: deepseek-official
      model: deepseek-v4-flash
```

启动 dsh 即可工作：普通聊天走 `preferred`，遇到图片/代码等任务会自动切换模型。

### 第 3 步：声明模型能力（推荐）

只有 `preferred` 时，特殊任务只能「兜底」。给模型标上能力元数据后，Router 才能「择优」：

```yaml
- id: llm-router
  name: '8kinfe-llm-router'
  config:
    mode: auto
    preferred:
      provider: deepseek-official
      model: deepseek-v4-flash
    models:
      deepseek-official/deepseek-v4-flash:
        coding: 0.6
        reasoning: 0.6
        vision: 0        # 不支持图片
        cost: 1
        latency: 1
      moonshotai-cn/kimi-k2.6:
        coding: 0.5
        reasoning: 0.7
        vision: 1        # 支持图片
        cost: 3
        latency: 2
```

### 常见场景

#### 场景 A：图片自动切视觉模型

发一张图片，Router 在 `agent/pre-step` 识别到 image 后，会自动跳过不支持视觉的模型、改选 `vision: 1` 的 kimi-k2.6，而不是 flash。配好第 3 步的 `models` 即可，无需额外操作。

#### 场景 B：代码任务走代码模型

复杂代码任务会综合 `coding` / `reasoning` / `cost` / `latency` 加权打分，选综合最优的模型；任务越复杂，越偏向能力强的模型，简单任务则倾向便宜模型。

#### 场景 C：限流自动换 provider（fallback）

某 provider 触发 `RATE_LIMIT`（429）、`QUOTA`、`SERVER`、`TIMEOUT` 等临时/资源错误时，Router 自动 fallback 到**另一个 provider** 的模型并重试：

```yaml
    fallback:
      enabled: true
      routes: {}
      # 留空 = 自动选不同 provider 的最强模型；也可显式指定：
      # routes:
      #   RATE_LIMIT: { provider: deepseek-official, model: deepseek-v4-flash }
```

#### 场景 D：能力不足自动升级（escalation）

模型返回 `EMPTY_RESPONSE`（空回复）或 `CONTEXT_WINDOW_EXCEEDED`（超上下文）时，Router 升级到能力更强的模型，最多 `maxEscalations` 次：

```yaml
    escalation:
      enabled: true
      triggerCodes: [EMPTY_RESPONSE, CONTEXT_WINDOW_EXCEEDED]
    maxEscalations: 2
```

### 验证路由

临时开 `debug`：

```yaml
      debug: true
```

日志会打印每次请求的任务分类、各模型评分和最终选择（`llm-router: ...` 前缀），确认行为符合预期后关掉即可。

### 手动接管

对话里输入 `/model <name>` 或通过 UI 切换模型，Router 会尊重你的手动选择、不再改写；切回默认后重新接管。

> 配置项完整说明见下文「配置」章节。

## 工作原理

插入 DSH 的三个 agent 扩展点：

| 事件 | 用途 |
|------|------|
| `agent/pre-step` | 读取进入 step 的 user message，做任务分类（规则 + 能力启发式，非 ML） |
| `agent/request` | 对 Registry 中每个模型评分，改写 provider/model |
| `agent/request-error` | 失败恢复：先委托给下游重试（如 `llm-retry`），再 fallback / escalation |

Provider 连接由 `dsh-llm-pi-ai` 等适配器负责；Router 只存「provider 名 + model 名 + 能力元数据」，与 endpoint / API Key 完全解耦。

## 配置

### 插件入口（cordis.yml）

```yaml
- id: llm-router
  name: '8kinfe-llm-router'
  config:
    mode: auto
    costPolicy: balanced
    maxEscalations: 2
    preferred:
      provider: openai
      model: gpt-4o-mini
    models:
      # key = "provider/model"
      openai/gpt-4o-mini:
        coding: 0.6
        reasoning: 0.6
        vision: 1
        cost: 1
        latency: 1
        context: 128000
      openai/gpt-4o:
        coding: 0.85
        reasoning: 0.85
        vision: 1
        cost: 4
        latency: 3
        context: 128000
```

### 配置项（`llm-router` settings namespace，支持热重载）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 总开关，关闭后 Router 完全惰性 |
| `mode` | `auto` \| `manual` | `auto` | `manual` 时永不改写调用方的选择 |
| `debug` | boolean | `false` | 输出选型解释日志 |
| `costPolicy` | `quality_first` \| `balanced` \| `cost_first` \| `speed_first` | `balanced` | 成本/延迟姿态 |
| `maxEscalations` | number | `2` | 每个 agent 自动升级次数上限 |
| `preferred` | `{provider, model}` | — | `auto` 模式下 simple_chat 的偏好模型 |
| `models` | dict | `{}` | 能力元数据，key 为 `provider/model` |
| `weights` | object | 见下 | 评分权重 |
| `escalation` | object | 见下 | 升级触发条件 |
| `fallback` | object | 见下 | 失败降级映射 |

`models` 条目字段（均可选，缺省取中性值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `coding` / `reasoning` / `vision` / `toolCalling` | 0..1 | 能力强度 |
| `context` | number | 上下文窗口 token 数 |
| `cost` | 1..5 | 成本（1 最便宜） |
| `latency` | 1..5 | 延迟（1 最快） |

> `vision` 未配置时，从适配器报告的 `inputModalities` 是否含 `image` 自动推断。

`weights` 默认：

```yaml
capability: 1
cost: 0.3
latency: 0.3
context: 0.2
toolCalling: 0.2
```

`escalation` 默认（能力不足触发升级）：

```yaml
enabled: true
triggerCodes: [EMPTY_RESPONSE, CONTEXT_WINDOW_EXCEEDED]
```

`fallback` 默认（临时/资源错误触发换模型）：

```yaml
enabled: true
routes: {}   # 可显式指定 code -> {provider, model}
```

## Fallback 与 Escalation 的区别

- **Fallback**：`RATE_LIMIT` / `QUOTA` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `AUTH` 等临时或资源性错误 → 换到另一个 provider（显式 `fallback.routes[code]` 优先，否则自动选不同 provider 的最强模型）。
- **Escalation**：`EMPTY_RESPONSE` / `CONTEXT_WINDOW_EXCEEDED` 等能力不足 → 升级到能力更强的模型，受 `maxEscalations` 限制。

两者在 `agent/request-error` 中都会先 `await next()`，把重试机会让给下游（例如 `llm-retry` 的同 provider 重试），只有当重试策略耗尽时才介入。

## 手动覆盖

- `mode: manual`：Router 完全不动模型。
- `mode: auto`：调用方通过 `/model <name>` 或 UI 手动切换后，Router 检测到该覆盖并**尊重它**，不会改写；切换回默认后重新接管。
- `preferred`：simple_chat 或无可服务模型时的偏好兜底。

## 安全边界

模型只能从已注册的 Model Registry 中选择。任何「模型推荐」（包括显式配置的 fallback 路由）都必须经过 `ModelRegistry.resolve()` 验证命中已注册模型后才会执行；API Key、endpoint、权限、系统配置对模型不可写。

## 测试

```bash
npm test
```

覆盖规格书 Test 1–7：普通/复杂 coding 选型、图片选型、复杂视觉选型、Flash→Pro 升级、429 fallback、手动覆盖不被覆盖。
