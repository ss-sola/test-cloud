---
name: plan-create
description: >
  在根目录 docs/plan/ 下生成实施方案。当用户想要为代码变更、功能新增、模块移除、迁移或任何多文件修改制定计划时触发，尤其是涉及 3 个以上文件或跨越多层（前端、后端、数据库、文档、测试）的任务。用户说"写个计划"或"给 docs/plan 起草个东西"时使用此技能。对于涉及跨模块变更、数据库结构调整、前后端协调的任务，主动建议先创建计划。
---

# 制定计划技能

在 `docs/plan/` 下生成结构化的实施方案，并在执行前使用 Workflow 启动多专家并行评审，确保计划完整、无遗漏、无风险。

## 何时使用

- 跨多层代码变更（前端 + 后端 + 数据库）
- 模块移除、新增或大规模重构
- 影响多个文件/服务的迁移任务
- 带种子数据的数据库表结构变更
- 涉及 3 个以上文件或 2 个以上层的变更

简单单文件修复（错别字、一行修复、明显 bug）不需要此技能。

## 工作流

### 0. 与用户确认范围

动手之前，先用一两句话总结你理解的需求范围，和用户确认：
- 涉及哪些模块/文件
- 是移除、新增还是重构
- 有无已知约束（如"不动 legacy 页面""需要同步 Apifox"）

如果用户需求模糊，先问清楚再动手。

### 1. 分析影响范围

起草计划前，彻底调研代码库：

**后端分析**（使用 codegraph）：
- `codegraph_context` 查找与目标模块相关的所有符号
- `codegraph_callers` / `codegraph_callees` 查找交叉引用
- `codegraph_impact` 查看完整影响半径

**手动文件搜索**（codegraph 找不到这些）：
- 遗留页面：`public/index.html`、`public/js/` — HTML section、Modal、JS 入口文件、API 函数、main.js 的 import/pageRegistry/路由映射
- 数据库：`sql/init.sql`（表结构定义）、`sql/init_data.sql`（种子数据 — 权限、菜单路由、角色关联）
- 前端资源：`public/assert/svg/resource/` 下的 SVG 图标、`test/` 下的测试文件
- 文档：`docs/` 目录、`docs/index.md` 导航链接
- 权限常量：`system-permission.constants.ts`
- 路由配置：`appRoutes.tsx`、`menuIconResolver.ts`
- Apifox：如果涉及 HTTP 接口变更，备注需同步更新 Apifox 文档

**核心原则**：一个模块不只是 `src/modules/X/`，还包括所有 import、引用、展示它的位置。

### 2. 起草计划

将计划写到 `docs/plan/<描述性名称>.md`，使用如下结构：

```markdown
# <标题>

## 背景
<为什么要做这个变更>

## 任务清单
| # | 任务 | 阶段 | 状态 | 开始时间 | 结束时间 | 耗时 |
|---|------|------|------|----------|----------|------|
| 1 | ... | ... | 待开始 | YYYY-MM-DD | - | - |

## 详细设计
### 任务 1: <任务名>
**目标**：<做什么>
**改动**：<哪些文件，改什么内容>

## 文件影响范围汇总
| 文件/目录 | 变更类型 | 说明 |

## 开始时间
YYYY-MM-DD
```

任务清单要足够细化，每个任务对应明确的文件或文件组。相关的删除操作（如 entity/service/controller）可以合为一个任务。

### 3. 提交评审

启动一个 Workflow 进行多专家并行评审。Workflow 包含 5 个并行评审节点（每个节点对应一个专业角色的 agent），评审完成后由汇总节点合并意见：

```javascript
export const meta = {
  name: 'plan-review',
  description: '多专家并行评审计划文件',
  phases: [
    { title: '并行评审' },
    { title: '意见汇总' },
  ],
};

const planFile = 'docs/plan/<计划文件名>.md';
const planPath = 'E:\\nest\\nest-cloud\\' + planFile;

// Phase 1: 5 个专家并行评审
const results = await pipeline(
  [
    { key: 'structural', agent: 'code-reviewer',
      prompt: `请从整体结构维度审查计划 ${planPath}。重点关注：
1. 任务顺序是否合理（后端 → 数据库 → 前端 → 文档 → 验证）
2. 任务粒度是否足够细化，每个任务对应明确的文件或文件组
3. 是否符合项目的 AGENTS.md 约束
4. 是否有遗漏的文件/目录
5. 计划是否遗漏了任何引用点（前端、后端、数据库、文档、测试）
给出你的审查意见，指出遗漏和风险。` },
    { key: 'security', agent: 'security-auditor',
      prompt: `请从安全维度审查计划 ${planPath}。重点关注：
1. 权限常量（system-permission.constants.ts）是否同步更新
2. 路由配置（appRoutes.tsx）是否包含变更
3. 认证/鉴权逻辑是否受影响
4. API 接口的安全影响（鉴权、输入校验）
5. 是否有敏感数据暴露风险
给出你的审查意见。` },
    { key: 'backend', agent: 'backend-developer',
      prompt: `请从后端维度审查计划 ${planPath}。重点关注：
1. 数据库变更（sql/init.sql、sql/init_data.sql 种子数据）是否完整
2. Entity/Service/Controller 的 CRUD 链是否都覆盖到
3. Redis key / 缓存策略是否考虑
4. 跨服务调用（ClientService）是否正确
5. 是否有遗漏的后端引用点
给出你的审查意见。` },
    { key: 'frontend', agent: 'frontend-developer',
      prompt: `请从前端维度审查计划 ${planPath}。重点关注：
1. 遗留页面体系（public/index.html Section/Modal、public/js/ 入口文件和 API 函数）
2. 前端路由和组件引用
3. SVG 图标文件（public/assert/svg/resource/）
4. 前端测试文件（test/ 目录）
5. Apifox 接口文档变更
给出你的审查意见。` },
    { key: 'docs', agent: 'documentation-engineer',
      prompt: `请从文档维度审查计划 ${planPath}。重点关注：
1. docs/*/index.md 导航链接是否更新
2. 模块文档（docs/<模块>/）是否同步
3. 测试用例是否补充
4. CHANGELOG 或发布说明
5. 是否有遗漏的文档引用点
给出你的审查意见。` },
  ],
  async (expert) => {
    const result = await agent(expert.prompt, {
      label: `review:${expert.key}`,
      phase: '并行评审',
      agentType: expert.agent,
    });
    return result ? { ...expert, output: result } : null;
  }
);

// Phase 2: 汇总所有评审意见
const findings = results.filter(Boolean);
const summaryPrompt = `以下是 5 位专家的评审意见，请合并去重并按优先级分级：

${findings.map(f => `---\n[${f.key}] (${f.agent}):\n${f.output}\n---`).join('\n')}

请按以下格式输出汇总报告：
## 高优先级（必须修复）
- ...
## 中优先级（建议修复）
- ...
## 低优先级（可选）
- ...

并指出哪些专家发现了哪些问题（去重）。`;

const summary = await agent(summaryPrompt, {
  label: '汇总评审意见',
  phase: '意见汇总',
});
```

评审完成后，阅读汇总结果。对每个发现：
- **高优先级**（遗漏文件、破坏性依赖）：更新计划
- **中优先级**（建议、优化）：酌情考虑
- **低优先级**（细节问题）：记录但不阻塞

合并后重新检查计划一致性。如果新增了任务，同步更新文件影响范围汇总表和任务排序。

### 4. 合并评审反馈

阅读 Workflow 汇总节点输出的评审报告。对每个发现：
- **高优先级**（遗漏文件、破坏性依赖）：更新计划
- **中优先级**（建议、优化）：酌情考虑
- **低优先级**（细节问题）：记录但不阻塞

合并后重新检查计划一致性。如果新增了任务，同步更新文件影响范围汇总表和任务排序。

### 5. 迭代（可选）

如果评审发现重大疏漏，或用户希望更深度的评审：
- 修复计划
- 可选择再次提交评审，附带更具体的评审 prompt
- 所有高优先级问题解决后即可停止

### 6. 定稿

计划满足以下条件即可执行：
- 所有评审发现的高优先级问题已解决
- 文件影响范围汇总表完整
- 任务排序合理（后端 → 数据库 → 前端 → 文档 → 验证）
- 计划自洽（无孤立任务或悬空引用）

## 常见遗漏（从过往评审中学习）

根据以往的经验，以下是最容易被遗漏的项目：

| 类别 | 典型遗漏 | 检查位置 |
|------|---------|---------|
| 遗留 HTML | Section + Modal 区块 | `public/index.html` |
| 遗留 JS | 入口文件、API 函数、main.js 映射 | `public/js/` |
| 种子数据 | 权限、菜单路由、角色关联 | `sql/init_data.sql` |
| 图标 | 解析器中引用的 SVG 文件 | `public/assert/svg/resource/` |
| 测试 | E2E 和单元测试文件 | `test/` 目录 |
| 文档 | 索引文件中的导航链接 | `docs/*/index.md` |
| 权限 | 权限常量定义 | `system-permission.constants.ts` |
| 路由 | import + 路由配置 | `appRoutes.tsx` |
| 图标解析器 | key 条目 | `menuIconResolver.ts` |
| Apifox | HTTP 接口文档 | 外部系统（计划中标注） |

## AGENTS.md 约束

- 计划存放在仓库根目录 `docs/plan/` 下
- 实现完成后，将 `docs/plan/` 中的过程记录移至对应模块的正式文档 `docs/<模块>/` 下
- 参考现有计划格式（参见 `docs/plan/ai-features-phase3.md`）
- 计划内容全部使用中文
- 数据库表和字段一律使用下划线命名（snake_case）
- 移除模块时需清理所有引用：src/、public/、sql/、web/、docs/、test/、assets/
- 如果涉及 HTTP 接口变更，计划获批后需同步更新 Apifox 文档
