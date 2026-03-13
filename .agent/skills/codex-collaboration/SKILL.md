---
name: codex-collaboration
description: 与 Codex 交叉验证的协作技能。包含方案审查、代码审查和测试执行（均通过 MCP）三个能力。触发词：和 Codex 协作、Codex 审查、交叉验证。
---

# Codex 协作技能

## ⚠️ 铁律（任何情况不可违反）

1. **复审闭环**：Codex 反馈的问题修复后，必须用 `mcp_codex_codex-reply` 发回 Codex 复审，**不能修完就结束**
2. **保持会话**：首次调用 `mcp_codex_codex` 时必须在 prompt 末尾要求 Codex 输出 `CODEX_THREAD_ID`，提取后用 `mcp_codex_codex-reply` 保持多轮对话
3. **独立判断**：收到 Codex 反馈必须独立判断是否为真问题，**不能盲从**，需核对已有决策和项目规范
4. **交接完整**：提交测试前，必须整理完整的交接信息并先询问用户授权
5. **sandbox 分级**：方案/代码审查用 `workspace-write`，测试执行用 `danger-full-access`（需用户授权）。**严禁使用 `read-only`**，Codex 需要写入能力才能执行审查和测试
6. **豁免清单**：审查前**必须先读取** `.agent/review-exceptions.md`，匹配的问题直接跳过，不报告给用户。用户确认"不用修改"时，必须主动追加到豁免清单

## 概述

- Antigravity：实现方（写方案、写代码）
- Codex：测试与审查方（审方案、审代码、跑测试）
- Codex 拥有 `v2-admin-test-hub` 技能，具备全链路测试能力

### 通信方式

| 阶段 | 方式 | 原因 |
|------|------|------|
| 方案审查 | MCP（`mcp_codex_codex`） | 纯文本分析，MCP 可用 |
| 代码审查 | MCP（`mcp_codex_codex`） | 读文件+分析，MCP 可用 |
| 测试执行 | MCP（`mcp_codex_codex` + `danger-full-access`） | 需用户授权后执行 |

### 强制流程门控

代码实现任务必须按序经过三个阶段，**禁止跳过任何一个**：

```
1. 方案审查 → 2. 代码审查 → 3. 测试执行 → 通知用户完成
```

- 每个阶段的退出条件是下一个阶段的进入条件
- 通知用户完成前，必须确认三个阶段全部执行或有记录地跳过（如 Codex 不可用）
- **禁止**修完代码后直接写 walkthrough 通知用户

## 对话启动自检

每次新对话开始，且任务涉及代码实现时，执行一次自检：

1. 检查本技能升级日志末尾是否有未确认的升级提案
2. 自检结果不阻塞正常工作流程

---

## MCP 调用规范

### 工具

| 工具 | 用途 |
|------|------|
| `mcp_codex_codex` | 启动新 Codex 会话（首轮） |
| `mcp_codex_codex-reply` | 用 threadId 继续已有会话（增量复审/多轮对话） |

### 固化基础指令

```
developer-instructions: "用中文回答。项目是 Vue 3 + MidwayJS 3 + TypeORM + MySQL 的前后端分离 ERP 管理系统。前端在 v2-vue，后端在 v2-midway。编码规范见 .agent/rules/houduan.md（后端）和 .agent/rules/qianduan.md（前端）。你是测试与审查方，Antigravity 是实现方。"
```

参数：
- `cwd`: `c:\Users\Administrator\Desktop\v2-admin`
- `sandbox`：
  - 方案审查 / 代码审查：`workspace-write`（需要读文件）
  - 测试执行：`danger-full-access`（需要运行命令和操作浏览器）
- `approval-policy`: 统一用 `never`

### ⚡ 调用模板（直接复制，禁止手写参数）

**模板 A：方案审查 / 代码审查（首轮）**

```javascript
mcp_codex_codex({
  cwd: "c:\\Users\\Administrator\\Desktop\\v2-admin",
  sandbox: "workspace-write",
  "approval-policy": "never",
  "developer-instructions": "用中文回答。项目是 Vue 3 + MidwayJS 3 + TypeORM + MySQL 的前后端分离 ERP 管理系统。前端在 v2-vue，后端在 v2-midway。编码规范见 .agent/rules/houduan.md（后端）和 .agent/rules/qianduan.md（前端）。你是测试与审查方，Antigravity 是实现方。",
  prompt: "【审查内容写在这里】\n\n## 审查豁免清单（以下问题已经用户确认，请直接跳过不要报告）\n【从 .agent/review-exceptions.md 复制豁免条目】\n\n请在回复末尾附带你的 CODEX_THREAD_ID 环境变量值，格式：[THREAD_ID:xxx]"
})
```

**模板 B：测试执行（需用户授权后使用）**

```javascript
mcp_codex_codex({
  cwd: "c:\\Users\\Administrator\\Desktop\\v2-admin",
  sandbox: "danger-full-access",
  "approval-policy": "never",
  "developer-instructions": "用中文回答。项目是 Vue 3 + MidwayJS 3 + TypeORM + MySQL 的前后端分离 ERP 管理系统。前端在 v2-vue，后端在 v2-midway。编码规范见 .agent/rules/houduan.md（后端）和 .agent/rules/qianduan.md（前端）。你是测试与审查方，Antigravity 是实现方。",
  prompt: "【测试交接信息写在这里】\n\n请在回复末尾附带你的 CODEX_THREAD_ID 环境变量值，格式：[THREAD_ID:xxx]"
})
```

**模板 C：多轮复审（使用已有 threadId）**

```javascript
mcp_codex_codex-reply({
  threadId: "【从上一轮提取的 threadId】",
  prompt: "我已修复以下问题：\n1. [问题A] → [修复方式]\n\n请只复审这些修改点。"
})
```

> ⚠️ **铁律**：每次调用必须从上面的模板复制，仅修改 prompt 内容。禁止手写 `sandbox`、`approval-policy` 等参数。

### threadId 获取与多轮对话

MCP 返回值中不直接包含 threadId，但 Codex 进程有 `CODEX_THREAD_ID` 环境变量。获取方法：

**步骤 1：首次调用时，在 prompt 末尾加一句**：

```
请在回复末尾附带你的 CODEX_THREAD_ID 环境变量值，格式：[THREAD_ID:xxx]
```

**步骤 2：从返回文本中解析 threadId**：

Codex 会在回复末尾输出类似 `[THREAD_ID:019cc8a0-711a-7190-9c65-e26a608a96ad]` 的内容，提取 UUID 部分。

**步骤 3：后续用 `mcp_codex_codex-reply` 保持会话**：

```
mcp_codex_codex-reply({
  threadId: "019cc8a0-711a-7190-9c65-e26a608a96ad",
  prompt: "我已修复以下问题：\n1. [问题A] → [修复方式]\n\n请只复审这些修改点。"
})
```

> ✅ 已验证：Codex 能记住上一轮对话内容，多轮上下文完全保持。

### threadId 提取失败兜底

如果 Codex 回复中未包含 `[THREAD_ID:xxx]`：
1. 本轮审查结果仍然有效，正常使用
2. 下次需要多轮对话时，开新会话（`mcp_codex_codex`），在 prompt 中附带前轮上下文摘要
3. 不中断工作流程

---

## 阶段一：方案审查（双盲交叉验证）

### 触发条件

写好 `implementation_plan.md` 后，提交给用户前。

> Codex 方案审查仅在首版方案完成后执行一次。用户反馈导致的方案调整不需要重新送审 Codex，除非调整涉及架构或安全方面的重大变更。

### 流程（双盲交叉 + 最多 3 轮复审）

```
步骤 0：加载豁免清单
  读取 .agent/review-exceptions.md
  审查过程中匹配到的条目 → 直接跳过，不纳入报告
  发送给 Codex 的 prompt 中附带豁免清单内容

步骤 1：双盲独立分析（⚡ I/O 并行优化）
  1a. 在同一个工具批次中，同时发出：
      - mcp_codex_codex 审查请求（不附带 Antigravity 的结论）
      - 分析所需的文件读取（view_file、grep_search 等）
  1b. 批次完成后，Codex 结果和文件内容同时到手，直接开始 Antigravity 独立分析
  ⚠️ 并行范围：是批次级 I/O 并行（节省文件读取时间），不是真异步
  ⚠️ 双盲保证：发给 Codex 的 prompt 不能包含 Antigravity 的结论

步骤 2：交换报告
  拿到 Codex 的独立报告 → 对比两份报告：
    • 两边都发现的问题 → 高置信度，直接纳入
    • 只有一方发现的 → 独立判断后决定是否纳入
    • 两边都漏的盲区 → 无法自知，但双盲模式已最大化降低概率
    ⚠️ 匹配豁免清单的问题 → 即使双方都发现也跳过

步骤 3：合并与复审（最多 3 轮）
  round = 0
  while (round < 3) {
      将合并后的报告发给 Codex 交叉确认
      收到反馈 → 对每条独立判断：
          🔕 匹配豁免清单 → 不改，不报告
          ✅ 确认是真问题 → 修改计划书
          ❌ 是误判 → 不改，附注理由
          ⚠️ 与已有决策冲突 → 不改，说明决策
          ❓ 不确定 → 记录为分歧项，转交用户
      if (本轮无修改) break
      round++
  }
  if (round == 3 且仍有新问题) 整理分歧项 → 转交用户决策
  在方案中标注"已与 Codex 双盲交叉验证达成一致"
  提交给用户审批
```

**关键原则**：
- 步骤 1 中发给 Codex 的 prompt **不能包含** Antigravity 的审查结论，确保双盲
- **步骤 3 交叉确认是必须的**，禁止跳过。合并报告必须发回 Codex 确认后才能提交给用户
- 只有判定为 ✅ 的问题才修改计划书，❌/⚠️ 的不改
- 每轮只发修改的部分给 Codex 复审，不重复发全文
- 3 轮仍不收敛 → 停止循环，转交用户

---

## 阶段二：代码审查（双盲交叉验证）

### 触发条件

代码修改完成后，**必须**进入此阶段：
- **禁止**修完代码直接跳到 walkthrough
- **禁止**用"是否需要 Codex 审查？"询问用户

### 流程（双盲交叉）

```
步骤 0：加载豁免清单
  读取 .agent/review-exceptions.md
  审查过程中匹配到的条目 → 直接跳过
  发送给 Codex 的 prompt 中附带豁免清单内容

步骤 1：双盲独立分析（⚡ I/O 并行优化）
  1a. 在同一个工具批次中，同时发出：
      - mcp_codex_codex 审查请求（只告诉文件列表，不附带 Antigravity 的结论）
      - 分析所需的文件读取
  1b. 批次完成后，直接开始 Antigravity 独立分析
  ⚠️ 匹配豁免清单的问题不纳入报告

步骤 2：交换报告
  拿到 Codex 的独立审查 → 对比两份报告
  将差异点 + Antigravity 的报告发给 Codex 交叉确认

步骤 3：复审闭环
  收到反馈 → 独立判断（含豁免匹配） → 修复确认为真的问题 → 增量复审
  通过 → 进入测试阶段
```

### 审查清单模板

将以下全部模板附在代码审查 prompt 中：

#### 模板 A：代码规范审查

```
请重点审查：字段命名歧义、JSDoc 注释完整性、遗留/冗余代码、可读性、过度设计、规范遵守
```

#### 模板 B：安全与权限审查

```
请重点审查：scopeFilter 双层过滤、敏感字段配置、模式字段过滤、fillModeFields、公司数据隔离、validateAccess
```

#### 模板 C：性能审查

```
请重点审查（按 2 年数据量评估）：
数据量参考：订单 10万/天、采购 50-100/天、入库 50-100/天、调拨 200-500/天
SQL 性能、索引、N+1、并发安全、分页
```

#### 模板 D：架构审查

```
请重点审查：过度设计（YAGNI）、维护复杂度、跨模块交互、重构建议（项目开发阶段，可大胆提出）
```

#### 模板 E：前端规范审查

```
请重点审查：useModeTable/useModeForm/useSensitivePerm 使用、表格 minWidth（操作栏除外）、
弹窗 vw/vh 尺寸、提交防抖加锁位置、linkedFields 空值守卫、
el-input-number 禁用 :precision、小数 parseFloat 去零
```

---

## 阶段三：测试执行（MCP `danger-full-access`）

### 触发条件

代码审查通过后，**必须**进入此阶段：
- **禁止**跳过测试直接通知用户完成
- **禁止**自行用浏览器验证来代替 Codex 测试
- **禁止**问用户"是否需要**我**进行浏览器测试"——测试是 Codex 的职责，不是 Antigravity 的

> 🚨 **常见犯错**：代码审查完成后，直接问用户"是否需要我进行浏览器测试验证？"
> 这是错误的！正确做法是整理交接信息，问用户"是否现在让 **Codex** 执行浏览器测试？"

### 流程

1. 整理测试交接信息（格式见下方模板）
2. **先询问用户**："代码审查已通过，是否现在让 Codex 执行浏览器测试？"（附交接信息摘要）
3. 用户确认后，通过 MCP 调用 Codex（`sandbox: danger-full-access`）执行测试
4. 收到测试结果 → 独立判断 → 修复确认为真的问题
5. 修复后重复步骤 1-4（复审闭环）

### 测试交接信息模板

```
请使用你的 v2-admin-test-hub 技能对以下变更执行测试。

## 交接信息
- 改动目标：[简要说明本次做了什么]
- 受影响页面：[页面名称或路由]
- 受影响模块：[模块名]
- 改动文件：[文件路径列表]
- 最担心的风险点：[高风险项]
- 相关已有决策：[如有，引用 docs/adr/* 或 docs/决策索引.md]

请按照测试技能执行最小必要测试矩阵。
```

### MCP sandbox 分级说明

| sandbox 模式 | 读文件 | 执行命令 | 操作浏览器 | 用途 |
|---|---|---|---|---|
| `workspace-write` | ✅ | ✅ | ❌ | 方案审查、代码审查 |
| `danger-full-access` | ✅ | ✅ | ✅ | 测试执行（需用户授权） |

> 🚨 **硬性规定**：**严禁使用 `read-only`**。`read-only` 模式下 Codex 无法写入文件和执行命令，会导致审查和测试全部失败。仅允许 `workspace-write` 和 `danger-full-access` 两个选项。

> ✅ 2026-03-08 实测验证：`danger-full-access` 模式下 Codex 通过 Playwright MCP 成功打开 localhost:9000 登录页并获取页面快照。

### ⚠️ Windows 配置与 MCP 调用参数的区别

| 配置位置 | 参数名 | 可选值 | 含义 |
|---|---|---|---|
| `~/.codex/config.toml` `[windows]` | `sandbox` | `elevated` / `unelevated` | **操作系统级**沙盒（Windows 特有） |
| MCP 调用参数 | `sandbox` |  `workspace-write` / `danger-full-access` | **Codex 权限级**沙盒 |

> 🚨 **不要混淆**：config.toml 中的 `[windows] sandbox` 设为 `danger-full-access` 会导致 Codex 启动失败（报 `unknown variant` 错误）。这两个参数名字一样但含义完全不同。

### 调用参数完整性检查

每次调用 `mcp_codex_codex` 必须包含以下 **5 个参数**，缺少任何一个都可能导致调用卡住或权限不足：

| # | 参数 | 示例值 | 说明 |
|---|---|---|---|
| 1 | `approval-policy` | `"never"` | 自动批准所有操作，不弹确认 |
| 2 | `cwd` | `"c:\\Users\\...\\v2-admin"` | 工作目录 |
| 3 | `developer-instructions` | 固化基础指令 | 项目背景和角色说明 |
| 4 | `prompt` | 审查/测试内容 | 具体任务描述 |
| 5 | `sandbox` | `"workspace-write"` 或 `"danger-full-access"` | 权限分级 |

---

## 独立判断流程

**核心原则：不盲从 Codex，每条反馈都要独立判断后再行动。**

```
Codex 提出问题 X
    ↓
我独立判断：
  0. 是否匹配 .agent/review-exceptions.md 中的豁免条目？→ 是则跳过
  1. 这个问题是否真实存在？（检查代码确认）
  2. 是否与 docs/决策索引.md 或 docs/adr/* 中的已有决策冲突？
  3. 是否符合 .agent/rules/houduan.md / qianduan.md 的规范？
    ↓
判断结果分五种：
  🔕 匹配豁免清单 → 跳过，不报告
  ✅ 确认是真问题 → 修复
  ❌ 是误判 → 告诉用户原因，不修改
  ⚠️ 与已有决策冲突 → 说明是已有决策并告诉用户
  ❓ 不确定 → 整理为分歧项，转交用户决策
```

### 豁免清单自动追加

当用户回复确认某个问题“不用修改”/“业务需要”时，Antigravity 必须：
1. 立即将该条目追加到 `.agent/review-exceptions.md` 的表格中
2. 用**代码特征**（而非行号）描述条目，以适应代码变化
3. 通知用户已追加

### 决策上下文传递

1. **主动传递**：在交接信息中加入"相关已有决策"字段
2. **被动核对**：Codex 质疑某个写法时，先查 `docs/决策索引.md`
3. **反馈闭环**：如果 Codex 的质疑揭示了已有决策的问题，记录为"待用户确认的决策修订提案"

---

## 问题分级处理

### 致命/阻塞（必须修复）

- TypeScript 编译错误
- 缺少权限校验或 scopeFilter
- 数据安全漏洞
- 业务逻辑错误
- 缺少 filterByConfig 或 fillModeFields

### 建议/优化（记录但不阻塞）

- 代码风格、变量命名、注释补充、非紧急性能优化
- 记录到 walkthrough 的"优化建议"章节

---

## 问题修复循环

### 退出条件（三选一）

1. **全部通过** → 完成
2. **趋势发散** → 问题不减反增 → 停止，转交用户
3. **收敛超时** → 连续 5 轮仍有致命问题 → 停止，转交用户

---

## Codex 失败兜底

### MCP 超时

- 重试一次 → 仍失败 → 跳过 MCP 审查，标注"Codex 审查未完成（MCP 超时）"

### MCP 不可用

- 提醒用户检查 `codex login status`
- 都不行 → 跳过 Codex 协作，正常完成工作，标注"Codex 不可用"

**原则：Codex 协作是增强，不是阻塞。**

---

## 代理确认规则

当 Codex 在测试或审查过程中提出技能升级提案时：

**一律转交用户确认**，不自动批准任何升级。

流程：
1. 在测试结果摘要中**单独列出**所有升级提案
2. 标注每条提案的类型（页面地图 / 联动地图 / 模块矩阵 / 测试策略 / 权限矩阵等）
3. 转交用户决策

## Codex 技能升级引导

用户确认接受升级提案后，由 Antigravity 引导 Codex 执行自升级：

```
用户确认 → 我通过 codex-reply 发送：
  "用户已确认以下升级提案，请执行技能升级：
   1. [提案内容]
   2. [提案内容]
   接受这次技能升级。"
→ Codex 写回文档 + 升级日志 + 冲突检查
→ 我在 walkthrough 中记录升级结果
```

**关键原则**：
- Codex 的 `v2-admin-test-hub` 技能文件在 `~/.codex/skills/` 下，不在我们工作区内
- 升级后 Codex 会输出升级回执，我将回执记录在 walkthrough 中
- 如果 Codex 升级出错，不影响本次任务完成

---

## 注意事项

- MCP sandbox 分级使用：审查用 `workspace-write`，测试用 `danger-full-access`
- 首次调用必须获取 threadId（通过 CODEX_THREAD_ID 环境变量），后续用 codex-reply 保持多轮
- 最终通知用户时，将 Codex 反馈整合到 walkthrough 中
- Codex 协作是增强手段，不是阻塞条件

## 升级日志

| 日期 | 版本 | 变更（同日多版本为快速迭代期） |
|------|------|------|
| 2026-03-07 | v1.0 | 初版：基础协作流程和调用模板 |
| 2026-03-07 | v2.0 | 交接模板、问题修复循环、代理确认规则、技能自升级机制 |
| 2026-03-07 | v3.0 | 修复循环改为趋势判断、问题分级、Codex 失败兜底、developer-instructions 固化、增量复审、对话启动自检 |
| 2026-03-07 | v3.1 | 独立判断流程（不盲从 Codex）、决策上下文传递 |
| 2026-03-07 | v3.2 | threadId 管理严格规则 |
| 2026-03-07 | v3.3 | 测试前通知用户进度 |
| 2026-03-07 | v3.4 | 铁律清单置顶 + 分类审查清单模板 |
| 2026-03-07 | v3.5 | 修正 threadId 规则、UI/UX 审查交给 Codex |
| 2026-03-07 | v3.6 | threadId 优先提取 + 兜底 |
| 2026-03-07 | v4.0 | 重大重构：测试阶段改为用户手动贴给 Codex CLI，MCP 仅保留审查，记录 MCP 限制原因 |
| 2026-03-07 | v4.1 | **threadId 已解决**：通过让 Codex 输出 `CODEX_THREAD_ID` 环境变量获取 threadId，恢复 `codex-reply` 多轮对话能力 |
| 2026-03-07 | v4.2 | 删除错误自检步骤（memory.md）、threadId fallback 兜底、新增前端审查模板 E、方案审查频率声明、版本日志格式优化 |
| 2026-03-08 | v5.0 | **重大升级**：强制流程门控、方案审查3轮循环+独立判断、sandbox 分级（workspace-write/danger-full-access）、阶段三 MCP 化（需用户授权）、阶段二/三触发条件加固、代理确认全部转交用户、Codex 技能升级引导、交接模板引用 v2-admin-test-hub |
| 2026-03-08 | v5.1 | **审查豁免清单**：新增 `.agent/review-exceptions.md`，铁律第6条强制读取，方案/代码审查加步骤0加载清单，独立判断流程加🔕豁免匹配，用户确认"不用修改"时自动追加条目 |
| 2026-03-08 | v5.2 | **浏览器测试参数修正**：新增 Windows 配置与 MCP 调用参数区别说明（config.toml `[windows] sandbox` ≠ MCP `sandbox`），新增调用参数完整性检查（5 个必传参数），更新实测验证记录（Playwright MCP 成功获取页面快照） |
| 2026-03-10 | v5.3 | **sandbox 硬性禁令**：铁律第5条和 sandbox 分级说明双重加固，严禁使用 `read-only`（会导致 Codex 无法写入和执行命令，审查测试全部失败），仅允许 `workspace-write` 和 `danger-full-access` |
| 2026-03-10 | v5.4 | **双盲分析 I/O 并行**：方案审查和代码审查的步骤1改为批次级并行——Codex 请求与文件读取同批发出，批次完成后 Codex 结果和文件内容同时到手，节省文件 I/O 等待时间 |
