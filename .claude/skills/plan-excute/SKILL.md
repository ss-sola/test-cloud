---
name: plan-excute
description: 通过 git worktree 为 docs/plan 下的每个任务计划创建独立分支，按计划实现功能后 lint/test/format 验证，合并到主分支并清理 worktree。当你想要按计划执行功能开发、实现 docs/plan 下的任务、或者提到"执行计划""run plan""implement plan"时立即使用此技能。
---

## 调用方式

**启动 Agent 时严禁使用 `isolation: "worktree"` 参数。** 技能自身会通过 `git worktree add` 在 `.worktree/` 目录下创建隔离工作区。双重隔离会导致 worktree 冲突和清理困难。

正确调用示例：

```
Agent(description: '执行 xxx plan', prompt: '...', subagent_type: 'general-purpose', run_in_background: true)
```

不要写成：

```
Agent(isolation: 'worktree', ...)  // ❌ 禁止
```

### 执行身份：主会话 vs subagent

主 agent 有两种执行身份，决定策略 B/C 是否可用：

| 身份                    | 含义                                           | 策略 A | 策略 B    | 策略 C    |
| ----------------------- | ---------------------------------------------- | ------ | --------- | --------- |
| **主会话（team lead）** | 用户对话的主 Claude 直接担任主 agent           | ✅     | ✅        | ✅        |
| **subagent**            | 主会话用 Agent 工具启动的子 agent 担任主 agent | ✅     | ❌ 降级 A | ❌ 降级 A |

**flat roster 限制**：subagent（teammate）不能再 spawn teammate，只有主会话（team lead）能把 agent 放进 roster。因此策略 B 的 Agent Team 和策略 C 的 Workflow（内部 spawn agent）在 subagent 身份下不可用，自动降级为策略 A（Agent 集群，spawn 普通 subagent，保留并行性）。

- 需要验证真正的策略 B/C 时，由主会话直接执行，不要 subagent 化。
- subagent 执行时，按策略 A 的方式 spawn 普通 subagent + TaskList 共享任务列表模拟协作，并在报告中标注降级。

## 架构：主 Agent + 三级委派策略（五步流程）

**一个 plan 对应一个主 agent。** 主 agent 负责完整的 worktree 生命周期管理（第一步至第五步），根据任务复杂度选择三种执行策略之一。代码实现、测试编写、验证、评审、提交全部融入第三步的策略执行中，不再由主 agent 单独串行处理。

```
用户: "执行 plan A.md"
  ↓
主 Agent (general-purpose, run_in_background: true)
  ├── 第一步：确定功能名称
  ├── 第二步：创建 worktree 分支
  ├── 第三步：读取 plan，评估复杂度，执行集成策略
  │     ├── Phase 1: 代码实现（按策略 A/B/C 并行）
  │     ├── Phase 2: 测试编写（与实现并行或紧随其后）
  │     ├── Phase 3: 代码验证（format → lint → test → tsgo）
  │     ├── Phase 4: 代码评审（code-review agent）
  │     └── Phase 5: 提交变更
  ├── 第四步：清理 worktree
  └── 第五步：完成计划
```

**一次只执行一个 plan**：本 skill 每次只执行一个计划文件，不并行处理多个 plan。若用户同时提供多个 plan，向用户确认选择其中一个执行，或要求逐个提供；不要为多个 plan 同时创建 worktree 或启动多个主 agent。

### 第一步：确定功能名称

从 plan 文件名提取功能名称。规则：

- 去掉 `.md` 后缀
- 去掉"实现计划""计划"等后缀（如"对话智能增强-实现计划" → "对话智能增强"）
- 检查 plan 状态：读取 `docs/plan/<plan文件名>` 内容，如果 plan 状态已标记为"已完成"或"已合并"，则跳过该 plan，不执行任何操作。
- 判断当前计划是否已经存在对应的 worktree 分支：**不要仅凭分支存在就跳过**。必须检查分支是否落后于 master（`git log feature/<功能名称>..master --oneline`）。如果分支存在但 `git log feature/<功能名称>..master --oneline` 的输出为空，说明分支没有落后于 master（已包含 master 所有提交），可以复用。如果输出非空，说明分支落后于 master（上一次执行失败或未完成），**停止操作并向用户报告**，不要自动删除或合并。
- 将中文转为有意义的英文 kebab-case 用于分支名：`feature/rag-context-compression`、`feature/chat-plus`

如果文件名无法直接提取有意义的名称，使用文件名去掉 `.md` 和"计划"/"实现计划"后的内容。

### 第二步：准备分支与创建 worktree

1. **确保主分支干净** — 执行 `git status` 检查 master 是否有未提交修改。如果有，先执行 `git stash` 保存。
2. **检查工作分支状态** — 执行 `git branch --list feature/<功能名称>` 检查分支是否存在。
   - 如果分支**不存在**：直接创建。
   - 如果分支**已存在**：执行 `git log feature/<功能名称>..master --oneline` 检查 master 上有多少提交是 feature 分支还没有的。
     - 输出为空 → 分支已追上 master，复用该分支，跳到实现步骤。
     - 输出非空 → 分支落后于 master（上一次执行失败或未完成），**停止操作并向用户报告**，不要自动处理。

```bash
# 如果 .worktree/<功能名称> 目录已存在（上次执行中断未清理），先移除
if [ -d ".worktree/<功能名称>" ]; then git worktree remove .worktree/<功能名称> --force 2>/dev/null; fi
git worktree add -b feature/<功能名称> .worktree/<功能名称>
```

每一个plan都需要建立对应的worktree分支，worktree分支名为`feature/<功能名称>`，如docs/plan目录下有A.md和B.md两个计划文件，则分别创建两个worktree分支：`feature/A`和`feature/B`，对应的worktree目录为`.worktree/A`和`.worktree/B`。
worktree 目录放在项目根目录下 `.worktree`。
**所有计划的实现都必须在对应的 worktree 分支中进行，禁止切换主项目目录的分支。**
**所有文件修改必须在 worktree 分支的目录中进行** — 如果工作目录在 `E:/nest/nest-cloud`，实际修改的文件路径应该是 `E:/nest/nest-cloud/.worktree/<功能名称>/...`。不要在主项目目录下直接修改文件。

### 第二步半：恢复主分支未提交内容（仅当第二步中有 stash 时）

在 worktree 分支创建完成后，切回主项目目录并执行 `git stash pop` 恢复 master 的已跟踪文件未提交内容。后续 worktree 实现期间，master 保持原有未提交状态。

> **注意**：`git stash` 只暂存已跟踪文件的修改，不暂存未跟踪文件（untracked）。如果 master 上有未跟踪文件，请先手动处理。

### 第三步：读取 plan 并执行集成策略（含实现→测试→验证→评审→提交）

**重要：所有文件修改必须在 worktree 目录中进行！** 如果你在主项目目录 `E:/nest/nest-cloud` 下工作，实际要修改的文件路径是 `E:/nest/nest-cloud/.worktree/<功能名称>/...`。例如修改 `scripts/run-tests.mjs`，实际路径是 `.worktree/<功能名称>/scripts/run-tests.mjs`。不要在主项目目录下直接修改任何文件。

读取 `docs/plan/<plan文件名>` 的内容，按以下步骤执行：

1. **解析修改范围** — 找到"修改范围"或"涉及文件清单"章节，提取所有需要修改/新建的文件列表
2. **评估任务复杂度** — 根据修改文件数量和涉及的 domain 判断委派方式：

| 复杂度      | 判定标准                                    | 执行策略                    |
| ----------- | ------------------------------------------- | --------------------------- |
| **Simple**  | 单一 domain，≤ 2 个文件改动                 | Agent 集群（并行 subagent） |
| **Medium**  | 跨 domain（后端+前端+文档），3-5 个文件改动 | Agent Team（共享任务列表）  |
| **Complex** | 多组件、多服务、架构级改动，≥ 6 个文件改动  | Workflow（脚本化 DAG）      |

3. **按选定策略执行全部 Phase**（实现 → 测试 → 验证 → 评审 → 提交）：

---

#### 策略 A：Agent 集群（Simple）

适用于 Simple 级别任务。使用 `Agent` 工具并行启动多个 subagent，每个 subagent 负责一个文件或一组相关文件，直接在 worktree 目录下修改文件。

**Phase 1：代码实现**

```
// 示例：2 个文件改动，都是后端
Agent(description: '实现 entity', prompt: '...', subagent_type: 'backend-developer', run_in_background: true)
Agent(description: '实现 service', prompt: '...', subagent_type: 'backend-developer', run_in_background: true)
```

- 所有 subagent 在同一个 worktree 目录下工作，互不干扰
- 等待所有 subagent 完成后汇总结果
- 选择原则：按主要改动领域选择 specialist agent

可选快速通道：

| 任务类型     | 推荐 Agent             |
| ------------ | ---------------------- |
| 全栈功能开发 | `fullstack-developer`  |
| API 端点     | `backend-developer`    |
| Bug 修复     | `debugger`             |
| 性能优化     | `performance-engineer` |

**Phase 2：测试编写（强制门槛）**

当改动含可测试的核心逻辑（解析、筛选、计算、转换、格式化、配置合并、缓存策略、身份同步、导入转换等纯函数或方法）时，测试是强制门槛，不得跳过。仅当改动纯属文档/纯配置键值/无逻辑变更时才可不补测试。

- 识别本次改动新增的可测试逻辑，列出需要覆盖的公开方法/纯函数
- `utils`/纯函数优先补单元测试，`service` 优先补行为测试，关键接口补少量集成测试
- 测试文件放在与 `src` 同级的 `test` 目录下
- 主 agent 可直接编写测试，也可启动 `test-automator` agent 并行编写

**Phase 3：代码验证**

在 worktree 目录下执行：

```bash
pnpm run format
pnpm run lint
pnpm run test
pnpm run tsgo
```

如果有任何失败：
1. 读取错误输出，定位根因
2. 修复问题
3. 重新运行直到全部通过。如果连续尝试 3 次仍未通过，请暂停操作并向用户报告具体错误。

**Phase 4：代码评审**

使用一个新的独立 agent 调用 skill `/code-review` 对已实现的代码进行约束合规性审计，评审过程中自行决定修复方式，无需向用户确定。

- 根据 code-review 输出的问题列表，自行决定需要修复的问题并完成修复。
- 如果有问题则回到 Phase 3 重新执行验证，通过后继续。
- 如果未发现需要修复的问题，直接进入 Phase 5。

**Phase 5：提交变更**

在 worktree 分支中提交所有变更。不要提交 plan 文件本身的修改，不要提交 `.gitignore` 中忽略的文件。

```bash
git add -A
git reset HEAD "docs/plan/<plan文件名>"
git commit -m "<type>: <subject>"
```

**commit message 生成方式**：
1. 先分析本次改动的文件列表和变更类型，确定 type（feat/fix/docs/style/refactor/perf/test/chore）
2. 用一句话概括变更内容，作为 subject（中文，50字以内，不加句号）
3. 将 type 和 subject 组合后传入 git commit -m

**不执行合并操作**：提交完成后不将分支合并到 master，保留分支上的提交即可。

---

#### 策略 B：Agent Team（Medium）

适用于 Medium 级别任务。**要求主会话（team lead）身份执行**——teammate 只能由 team lead spawn，subagent 身份会触发 flat roster 限制（见"调用方式"），此时自动降级为策略 A。

启用 Agent Teams（需设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`），主 agent 作为负责人协调多个队友并行工作。

**Phase 1：代码实现 + 测试**

**teammate 分配由主 agent 根据 plan 自动决定**：读取 plan 任务清单和涉及文件，按"每个 teammate 拥有不同文件集、不编辑同一文件"的原则拆分。分配维度：

- 按任务：一个 teammate 负责一组相关任务（如配置+依赖、脚本重写、文档、测试）
- 按 domain：后端/前端/文档/测试分别由对应 specialist 担任
- 按文件：确保无文件冲突，有依赖时（如测试依赖脚本）用 SendMessage 协调或排依赖

**测试是必选维度**：teammate 分配必须包含一个测试角色（`test-automator`），为新增/修改的核心业务逻辑补测试，不要遗漏。测试文件产出是 Phase 2 验证的前置条件。

不要写死 teammate 数量和分工，根据 plan 实际任务清单动态划分。每个 teammate 的 spawn prompt 必须含：worktree 绝对目录、目标文件相对路径、plan 对应详细设计章节内容、项目 CLAUDE.md 约束、以及"你是 teammate，完成可用 SendMessage 向 team lead 回报"。

```
// 示例：主 agent 根据 plan 任务清单拆分 teammate（实际数量与分工按 plan 动态决定）
"按 plan 任务清单 spawn teammate，每人不同文件集：
- backend-config（backend-developer）：任务1 配置文件
- backend-script（backend-developer）：任务4 脚本重写
- docs-writer（documentation-engineer）：任务5 文档
- test-writer（test-automator）：任务6 测试"
```

Agent Team 工作机制：

- **共享任务列表**：负责人（主 agent）创建任务，队友自我认领。任务有三种状态：待处理、进行中、已完成。任务可以有依赖关系。
- **队友直接通信**：队友之间可以通过 `SendMessage` 共享发现、质疑彼此结果，不需要全部通过负责人中转。
- **独立 context**：每个队友有自己的 context window，加载项目 CLAUDE.md、skills 和 MCP servers，但不继承负责人的对话历史。
- **权限继承**：队友从负责人的权限设置开始，权限提示会冒泡到负责人会话。
- **subagent 定义复用**：可以按名称引用 subagent 定义中的队友角色（如 `backend-developer`），队友遵守该定义的 tools 允许列表和 model。

最佳实践：

- **团队规模**：从 3-5 个队友开始，每个队友 5-6 个任务
- **避免文件冲突**：每个队友拥有不同的文件集，不编辑同一文件
- **给足 context**：在生成提示中包含特定于任务的详细信息（目标文件、约束条件、预期产出）
- **从研究和审查开始**：如果是第一次使用 Agent Teams，先从明确边界的任务开始
- **监控进度**：不要让团队无人值守运行太长时间，定期检查队友进度并重定向不起作用的方法
- **竞态接管**：teammate 异步通知可能延迟到达，若某 teammate 认领任务后长时间无产出（或完成通知滞后），team lead 可直接接手完成该任务，避免阻塞下游；接管时通过 SendMessage 通知相关 teammate 避免重复劳动
- **优雅关闭**：任务完成后按名称引用队友让其 shut down

队友生成后，负责人可以通过 agent 面板（in-process 模式）或直接点击窗格（split-pane 模式）与队友交互。队友完成工作后自动通知负责人。

**Phase 2：代码验证**

所有实现 teammate（含 test-automator）完成后，主 agent 在 worktree 目录下执行：

```bash
pnpm run format
pnpm run lint
pnpm run test
pnpm run tsgo
```

如果有任何失败：
1. 读取错误输出，定位根因
2. 修复问题
3. 重新运行直到全部通过。如果连续尝试 3 次仍未通过，请暂停操作并向用户报告具体错误。

**Phase 3：代码评审**

使用一个新的独立 agent 调用 skill `/code-review` 对已实现的代码进行约束合规性审计，评审过程中自行决定修复方式，无需向用户确定。

- 根据 code-review 输出的问题列表，自行决定需要修复的问题并完成修复。
- 如果有问题则回到 Phase 2 重新执行验证，通过后继续。
- 如果未发现需要修复的问题，直接进入 Phase 4。

**Phase 4：提交变更**

在 worktree 分支中提交所有变更。不要提交 plan 文件本身的修改，不要提交 `.gitignore` 中忽略的文件。

```bash
git add -A
git reset HEAD "docs/plan/<plan文件名>"
git commit -m "<type>: <subject>"
```

**commit message 生成方式**：同策略 A Phase 5。

**不执行合并操作**：提交完成后不将分支合并到 master，保留分支上的提交即可。

---

#### 策略 C：Workflow（Complex）

适用于 Complex 级别任务。使用 `Workflow` 工具，将编排逻辑写入 JavaScript 脚本，由 runtime 在后台执行。**整个实现→测试→验证→评审→提交流程全部编码为 DAG Phase**，主 agent 只需等待 Workflow 完成。

**执行身份要求**：Workflow 工具需主会话身份调用；subagent 身份下 Workflow 不可用，自动降级为策略 A（Agent 集群，用 Agent 工具 spawn 普通 subagent + TaskList 模拟 DAG 依赖，保留并行性），并在报告中标注降级。不要降级为主 agent 串行执行，那会丢失并行价值。

**workflow agent 分配由主 agent 根据 plan 自动建模 DAG**：读取 plan 任务清单和文件归属，按依赖关系划分 Phase（无依赖任务并行 → 依赖任务 → 测试 → 验证 → 评审 → 提交），每个 workflow agent 负责一组文件、不编辑同一文件。不要写死 agent 数量和分工，根据 plan 实际任务动态划分。**测试 agent 必选**（用 `test-automator`），不要遗漏。每个 workflow agent 的 prompt 必须含 worktree 绝对目录、目标文件、plan 详细设计章节、CLAUDE.md 约束，确保 agent 在 worktree 目录下改文件而非主项目目录。`agent()` 返回 null（用户跳过/agent 失败）时用 `.filter(Boolean)` 过滤，避免下游处理 undefined。

```javascript
// Workflow 脚本示例（含实现→测试→验证→评审→提交全流程）
export const meta = {
  name: 'complex-plan-execution',
  description: 'Complex 复杂度 plan 的 DAG 编排执行',
  phases: [
    { title: 'Phase 1: 无依赖实现' },
    { title: 'Phase 2: 集成层 + 测试' },
    { title: 'Phase 3: 代码验证' },
    { title: 'Phase 4: 代码评审' },
    { title: 'Phase 5: 提交变更' },
  ],
};

// Phase 1: 无依赖任务 — 全部并行
const phase1Results = await parallel(
  () =>
    agent('定义 entity 的 prompt', {
      label: 'entity',
      phase: 'Phase 1: 无依赖实现',
      agentType: 'backend-developer',
    }),
  () =>
    agent('定义 service 的 prompt', {
      label: 'service',
      phase: 'Phase 1: 无依赖实现',
      agentType: 'backend-developer',
    }),
  () =>
    agent('定义 controller 的 prompt', {
      label: 'controller',
      phase: 'Phase 1: 无依赖实现',
      agentType: 'backend-developer',
    }),
  () =>
    agent('定义文档的 prompt', {
      label: 'docs',
      phase: 'Phase 1: 无依赖实现',
      agentType: 'documentation-engineer',
    }),
);

// Phase 2: 依赖 Phase 1 — 集成层 + 测试并行
const phase2Results = await parallel(
  () =>
    agent('集成层代码的 prompt', {
      label: 'integration',
      phase: 'Phase 2: 集成层 + 测试',
      agentType: 'backend-developer',
    }),
  () =>
    agent('编写测试的 prompt', {
      label: 'tests',
      phase: 'Phase 2: 集成层 + 测试',
      agentType: 'test-automator',
    }),
);

// Phase 3: 代码验证 — 在 worktree 目录执行 format/lint/test/tsgo
// 验证失败时修复并重试，最多 3 次
const phase3 = await agent('在 worktree 目录执行 pnpm run format && pnpm run lint && pnpm run test && pnpm run tsgo，失败时修复并重试（最多3次）', {
  label: 'verify',
  phase: 'Phase 3: 代码验证',
});

// Phase 4: 代码评审 — 独立 agent 执行 /code-review
const phase4 = await agent('使用 skill /code-review 对变更进行约束合规性审计，自行修复发现的问题，修复后重新验证', {
  label: 'code-review',
  phase: 'Phase 4: 代码评审',
});

// Phase 5: 提交变更
const phase5 = await agent('在 worktree 目录执行 git add -A && git reset HEAD docs/plan/<plan文件名> && git commit -m "<type>: <subject>"', {
  label: 'commit',
  phase: 'Phase 5: 提交变更',
});
```

Workflow 核心特性：

- **脚本化编排**：将计划编码为 JavaScript 脚本，`agent()` 启动子 agent，`parallel()` 并行执行，`pipeline()` 顺序处理列表
- **上下文隔离**：中间结果保存在脚本变量中，不占用主对话 context window
- **DAG 依赖**：通过 `parallel()` + 顺序 `await` 建模任务依赖关系，无依赖任务并行执行
- **规模**：最多 16 个并发 agent，总计 1000 个 agent，适合数十到数百个 agent 的大规模任务
- **可恢复**：如果中途停止，可以通过 `/workflows` 恢复运行，已完成的 agent 返回缓存结果
- **可保存复用**：运行满意后可以通过 `/workflows` 按 `s` 保存为命令，后续通过 `/<name>` 直接调用

**依赖分析原则**：将 plan 中的任务按依赖关系建模为 DAG：

- **Phase 1（无依赖）**：新增的实体、Service、Util、文档文件 — **全部并行**
- **Phase 2（依赖 Phase 1）**：集成层代码（如修改 Service 来调用新服务）、测试编写 — **并行**
- **Phase 3（验证）**：format → lint → test → tsgo，失败修复重试
- **Phase 4（评审）**：code-review agent，有问题修复后回到 Phase 3
- **Phase 5（提交）**：git add + commit

Agent 简报（启动每个 agent 时提供丰富上下文）：

```
你是 [specialist type]，在一个协调的团队任务中工作。

**总体目标**: [高层项目目标]
**你的具体任务**: [精确的子任务描述]
**你的 worktree 目录**: E:/nest/nest-cloud/.worktree/<功能名称>/
**你的目标文件**: [具体文件路径，相对于 worktree 目录]
**上下文**:
- 其他 agent 的工作: [相关工作的描述，特别是你有依赖的任务]
- 你将接收: [上游 agent 的输出，如果有]
- 你需要产出: [预期输出，必须是实际代码文件]
- 约束条件: [技术/业务约束]
**集成点**: 你的输出将被 [下游 agent/流程] 使用
**努力级别**: [low/medium/high]
```

按任务类型选择 specialist agent：

| 任务类型         | 推荐 Agent                      | 示例                 |
| ---------------- | ------------------------------- | -------------------- |
| 数据库迁移 / SQL | `backend-developer`             | 新增列、索引、生成列 |
| 实体定义         | `backend-developer`             | 新增字段、类型       |
| 后端服务         | `backend-developer`             | 新增 Service、Util   |
| Controller 修改  | `backend-developer`             | 接口变更             |
| 前端页面 / 组件  | `frontend-developer`            | 布局、交互、样式     |
| 前端测试         | `frontend-developer`            | 组件测试             |
| 单元测试         | `test-automator` 或 `qa-expert` | Service/Util 测试    |
| 文档             | `documentation-engineer`        | 模块文档、实现逻辑   |

---

### 通用约束（所有策略共享）

对于新建文件，创建完整的实现代码（禁止留空函数或 TODO）。

**测试强制门槛（所有策略）**：当改动含可测试的核心逻辑（解析、筛选、计算、转换、格式化、配置合并、缓存策略、身份同步、导入转换等纯函数或方法）时，测试是强制门槛，不得跳过——不得以"脚本是脚本""非业务代码"为由省略；脚本的纯函数解析逻辑同样需要测试覆盖。仅当改动纯属文档/纯配置键值/无逻辑变更时才可不补测试。

- 策略 A：主 agent 在 Phase 2 直接编写测试或启动 test-automator agent
- 策略 B：test-automator teammate 负责，其测试文件产出是 Phase 2 验证的前置依赖
- 策略 C：DAG 必须包含一个测试 agent（`test-automator`），在 Phase 2 完成，测试文件产出是 Phase 3 验证的前置

**反模式（禁止行为）**：

- ❌ 过度协调：不要为了实现步骤而设计复杂的多 agent 编排
- ❌ 错误专家：不要将前端工作分配给 backend-developer
- ❌ 无集成：不要让 agent 输出成为孤立的片段
- ❌ 忽略失败：关键 agent 失败时不要继续
- ❌ 上下文饥饿：不要带着模糊指令启动 agent
- ❌ **在主分支上修改文件**：所有改动必须在 `.worktree/<功能名称>/` 下进行，不是主项目目录
- ❌ **分支存在就跳过**：分支存在但落后于 master = 上一次执行失败，停止操作并报告
- ❌ **只输出建议不落地**：agent 输出不能只是文字说明，必须有实际的文件修改和 git commit
- ❌ **串行执行可并行的任务**：多个无依赖的独立任务必须并行，不要一个一个等
- ❌ **一个 agent 干所有活**：Complex 任务必须由多个 specialist agent 并行完成
- ❌ **跳过测试**：改动含可测试核心逻辑时必须补测试；策略 B/C 必须有 test agent 产出测试文件

**成功标准**：

- ✅ 所有子任务完成
- ✅ 产出可工作、已集成的产物
- ✅ 比单 agent 更快/更好
- ✅ 提供清晰的审计轨迹，说明每个 agent 做了什么
- ✅ 每个 specialist agent 都在正确的 worktree 目录下修改了文件
- ✅ 可测试的核心逻辑有对应测试覆盖
- ✅ 修复的 bug 有回归测试
- ✅ 所有测试用例可通过 `pnpm run test` 执行
- ✅ 验证通过（format/lint/test/tsgo）
- ✅ 代码评审通过

### 第四步：清理 worktree

```bash
git worktree remove .worktree/<功能名称>
```

**保留 `feature/<功能名称>` 分支**，不删除分支。

### 第五步：完成计划

- 将计划中的所有子任务标记为"已完成"，并在 plan 文件中添加"已实现标记"

## 注意事项

- 验证失败时不要跳过，必须先修复再继续
- plan 中的"不变的部分"章节也需要遵守，不要意外修改那些部分
- 如果 plan 中有验证步骤（如特定接口的测试），在 worktree 中完成实现后，简要确认这些步骤的逻辑可行性
- **代码评审环节是必过的关卡**：评审发现的问题必须修复后再回到验证步骤，不允许跳过评审或带已知不规范问题进入提交阶段
- 不要将主项目目录切换分支
- **不要重复启动** — 如果一个 plan 的主 agent 仍在运行中，不要为其再次创建新的 agent。可以通过检查 `git worktree list` 和 `git branch --list feature/<功能名称>` 来确认是否有 agent 正在执行该 plan。
- **Agent Teams 需要预配置**：使用策略 B（Agent Team）前确保 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 已配置；如果未启用则降级为策略 A（Agent 集群）
- **flat roster 限制**：subagent（teammate）不能再 spawn teammate，策略 B/C 在 subagent 身份下自动降级为策略 A（保留并行）；需验证真 Agent Team/Workflow 时由主会话直接执行