---
name: ui-ux-pro-max
description: UI/UX 设计智能助手。包含 50+ 样式、97+ 配色方案、57+ 字体配对、99+ UX 指南、25+ 图表类型，支持 9 种技术栈 (React, Next.js, Vue, Svelte, SwiftUI, React Native, Flutter, Tailwind, shadcn/ui)。触发场景：设计、构建、创建、实现、审查、修复、改进、优化、增强、重构 UI/UX 代码。适用项目：网站、落地页、仪表板、管理面板、电商、SaaS、作品集、博客、移动应用。支持元素：按钮、模态框、导航栏、侧边栏、卡片、表格、表单、图表。样式关键词：玻璃态、粘土态、极简、野兽派、拟物、bento 网格、深色模式、响应式。设计主题：配色方案、无障碍访问、动画、布局、排版、字体配对、间距、悬停效果、阴影、渐变。
---

# UI/UX Pro Max - 设计智能助手

全面的 Web 和移动应用设计指南。包含 50+ UI 样式、97 种配色方案、57 种字体配对、99 条 UX 指南、25 种图表类型，支持 9 种技术栈。可搜索数据库，提供基于优先级的推荐。

## 何时使用此 Skill

在以下场景使用此 skill：
- 设计新的 UI 组件或页面
- 选择配色方案和字体排版
- 审查代码中的 UX 问题
- 构建落地页或仪表板
- 实现无障碍访问要求
- 用户请求 UI/UX 设计建议或实现

## 工作流程

### 第 1 步：分析用户需求

从用户请求中提取关键信息：
- **产品类型**：SaaS、电商、作品集、仪表板、落地页等
- **样式关键词**：极简、趣味、专业、优雅、深色模式等
- **行业领域**：医疗、金融科技、游戏、教育等
- **技术栈**：React、Vue、Next.js，或默认使用 `html-tailwind`

### 第 2 步：生成设计系统（必需）

**始终以 `--design-system` 开始**，获取功能完备的设计系统推荐：

```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<产品类型> <行业> <关键词>" --design-system [-p "项目名称"]
```

此命令会：
1. 并行搜索 5 个领域（产品、样式、配色、布局、字体）
2. 应用 `ui-reasoning.csv` 中的推理规则选择最佳匹配
3. 返回完整设计系统：模式、样式、配色、字体、效果
4. 包含应避免的反模式

**示例：**
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "美容 SPA 养生服务" --design-system -p "静心水疗"
```

### 第 2b 步：持久化设计系统（主文件 + 覆盖模式）

要**跨会话保存设计系统以实现分层检索**，添加 `--persist` 参数：

```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<查询>" --design-system --persist -p "项目名称"
```

这会创建：
- `design-system/MASTER.md` — 全局设计规则的唯一真实来源
- `design-system/pages/` — 页面特定覆盖规则的文件夹

**带页面特定覆盖：**
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<查询>" --design-system --persist -p "项目名称" --page "dashboard"
```

还会创建：
- `design-system/pages/dashboard.md` — 页面特定的主文件偏差

**分层检索工作原理：**
1. 构建特定页面时（如 "Checkout"），首先检查 `design-system/pages/checkout.md`
2. 如果页面文件存在，其规则**覆盖**主文件
3. 如果不存在，则独家使用 `design-system/MASTER.md`

**上下文感知检索提示：**
```
我正在构建 [页面名称] 页面。请读取 design-system/MASTER.md。
同时检查 design-system/pages/[page-name].md 是否存在。
如果页面文件存在，优先使用其规则。
如果不存在，则仅使用主文件规则。
现在，生成代码...
```

### 第 3 步：补充详细搜索（按需）

获取设计系统后，使用领域搜索获取额外细节：

```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<关键词>" --domain <领域> [-n <最大结果数>]
```

**何时使用详细搜索：**

| 需求 | 领域 | 示例 |
|------|------|------|
| 更多样式选项 | `style` | `--domain style "玻璃态 深色"` |
| 图表建议 | `chart` | `--domain chart "实时仪表板"` |
| UX 最佳实践 | `ux` | `--domain ux "动画 无障碍"` |
| 替代字体 | `typography` | `--domain typography "优雅 奢华"` |
| 落地页结构 | `landing` | `--domain landing "英雄区 社会证明"` |

### 第 4 步：技术栈指南（默认：html-tailwind）

获取特定实现的最佳实践。如果用户未指定技术栈，**默认使用 `html-tailwind`**。

```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<关键词>" --stack html-tailwind
```

可用技术栈：`html-tailwind`、`react`、`nextjs`、`vue`、`svelte`、`swiftui`、`react-native`、`flutter`、`shadcn`、`jetpack-compose`

## 搜索参考

### 可用领域
- `product` - 产品类型推荐（SaaS、电商、作品集）
- `style` - UI 样式（玻璃态、极简、野兽派）
- `typography` - 字体配对及 Google Fonts 导入
- `color` - 按产品类型的配色方案
- `landing` - 页面结构和 CTA 策略
- `chart` - 图表类型和库推荐
- `ux` - 最佳实践和反模式
- `prompt` - AI 提示和 CSS 关键词

### 可用技术栈
`html-tailwind`（默认）、`react`、`nextjs`、`vue`、`svelte`、`swiftui`、`react-native`、`flutter`、`shadcn`、`jetpack-compose`

## 规则分类（按优先级）

| 优先级 | 分类 | 影响 | 领域 |
|--------|------|------|------|
| 1 | 无障碍访问 | 严重 | `ux` |
| 2 | 触摸和交互 | 严重 | `ux` |
| 3 | 性能 | 高 | `ux` |
| 4 | 布局和响应式 | 高 | `ux` |
| 5 | 字体和配色 | 中 | `typography`, `color` |
| 6 | 动画 | 中 | `ux` |
| 7 | 样式选择 | 中 | `style`, `product` |
| 8 | 图表和数据 | 低 | `chart` |

## 专业 UI 通用规则

这些是经常被忽略但会让 UI 显得不专业的问题：

### 图标和视觉元素
- ❌ **禁止使用 emoji 作为图标**（如 ❤️ 🎨 ⚙️）
- ✅ **使用 SVG 图标**（Heroicons、Lucide、Feather）

### 交互和光标
- ❌ **可点击元素缺少 `cursor: pointer`**
- ✅ **所有交互元素添加 `cursor-pointer`**（按钮、链接、可点击卡片）

### 明暗模式对比
- ❌ **浅色模式文本对比度 < 4.5:1**（WCAG AA 标准）
- ✅ **确保文本/背景对比度 ≥ 4.5:1**

### 布局和间距
- ❌ **固定宽度容器不响应**
- ✅ **使用 `max-w-*` + `mx-auto` 或 flexbox/grid**

## 交付前检查清单

在交付 UI 代码前，验证以下项目：

### 视觉质量
- [ ] 无 emoji 图标（使用 SVG：Heroicons/Lucide）
- [ ] 所有可点击元素有 `cursor-pointer`
- [ ] 悬停状态有平滑过渡（150-300ms）

### 交互
- [ ] 明确的焦点状态用于键盘导航
- [ ] 触摸目标 ≥ 44×44px（移动端）

### 明暗模式
- [ ] 浅色模式：文本对比度 4.5:1 最小值
- [ ] 深色模式（如果适用）：文本对比度 4.5:1 最小值

### 布局
- [ ] 响应式断点：375px、768px、1024px、1440px
- [ ] 移动优先 CSS（如使用 Tailwind）

### 无障碍访问
- [ ] 尊重 `prefers-reduced-motion`
- [ ] 语义化 HTML（`<header>`、`<nav>`、`<main>`、`<footer>`）
- [ ] 图像的 `alt` 文本

## 输出格式

`--design-system` 标志支持两种输出格式：

```bash
# ASCII 框（默认） - 最适合终端显示
python .agent/skills/ui-ux-pro-max/scripts/search.py "金融科技 加密" --design-system

# Markdown - 最适合文档
python .agent/skills/ui-ux-pro-max/scripts/search.py "金融科技 加密" --design-system -f markdown
```

## 获得更好结果的技巧

1. **使用具体关键词** - "医疗 SaaS 仪表板" > "应用"
2. **多次搜索** - 不同关键词会揭示不同见解
3. **组合领域** - 样式 + 字体 + 配色 = 完整设计系统
4. **始终检查 UX** - 搜索 "动画"、"z-index"、"无障碍" 以发现常见问题
5. **使用技术栈标志** - 获取特定实现的最佳实践
6. **迭代优化** - 如果首次搜索不匹配，尝试不同关键词

## 工作流程示例

假设用户请求："为我的 SaaS 产品构建落地页"

### 第 1 步：分析需求
- 产品类型：SaaS
- 样式：专业、现代
- 技术栈：默认为 html-tailwind

### 第 2 步：生成设计系统（必需）
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "saas 专业 现代" --design-system -p "我的 SaaS"
```

### 第 3 步：补充详细搜索（按需）
```bash
# 获取图表建议（如有仪表板）
python .agent/skills/ui-ux-pro-max/scripts/search.py "数据可视化" --domain chart

# 获取 UX 最佳实践
python .agent/skills/ui-ux-pro-max/scripts/search.py "动画 性能" --domain ux
```

### 第 4 步：技术栈指南
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "表单验证" --stack html-tailwind
```

## 注意事项

1. **始终从设计系统开始**：`--design-system` 提供最全面的推荐
2. **默认技术栈**：如未指定，使用 `html-tailwind`
3. **迭代搜索**：不同关键词会产生不同结果
4. **遵循检查清单**：确保专业的 UI 质量
5. **使用持久化**：对于大型项目，使用 `--persist` 保存设计系统

> 📌 **项目特定规范**: 开发 Antigravity Admin 项目时，请同时参考 [admin](../admin/SKILL.md) 技能中的前端编码规范和组件陷阱。

## 依赖项

- Python 3.x（无需外部依赖）

## 相关文件

- `scripts/search.py` - 搜索引擎入口
- `scripts/core.py` - BM25 + 正则表达式混合搜索引擎
- `data/` - CSV 数据库（样式、配色、字体等）
- `data/stacks/` - 技术栈特定指南
