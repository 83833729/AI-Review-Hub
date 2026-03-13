# UI/UX Pro Max Skill 快速参考

## 基本用法

### 自动激活
直接向 Antigravity 描述你的 UI/UX 需求即可：
```
为我的 SaaS 产品设计一个落地页
创建一个深色主题的仪表板
帮我选择医疗应用的配色方案
```

### 搜索命令

**生成完整设计系统**（推荐）：
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<产品> <行业> <风格>" --design-system -p "项目名"
```

**领域搜索**：
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<关键词>" --domain <领域>
```

可用领域：
- `style` - UI 样式（玻璃态、极简、野兽派等）
- `color` - 配色方案
- `typography` - 字体配对
- `chart` - 图表类型
- `landing` - 落地页结构
- `ux` - UX 最佳实践
- `product` - 产品类型推荐

**技术栈指南**：
```bash
python .agent/skills/ui-ux-pro-max/scripts/search.py "<关键词>" --stack <技术栈>
```

可用技术栈：
`html-tailwind`, `react`, `nextjs`, `vue`, `svelte`, `swiftui`, `react-native`, `flutter`, `shadcn`

## 示例

### 示例 1：SaaS 产品设计系统
```bash
python scripts/search.py "saas 专业 现代" --design-system -p "我的 SaaS"
```

### 示例 2：搜索玻璃态样式
```bash
python scripts/search.py "玻璃态 深色" --domain style
```

### 示例 3：React 性能优化
```bash
python scripts/search.py "性能 优化" --stack react
```

### 示例 4：选择优雅字体
```bash
python scripts/search.py "优雅 奢华" --domain typography
```

## 持久化设计系统

创建主设计系统文件：
```bash
python scripts/search.py "金融科技" --design-system --persist -p "项目名"
```

为特定页面创建覆盖规则：
```bash
python scripts/search.py "仪表板 深色" --design-system --persist --page "dashboard"
```

## 输出格式

- ASCII 格式（默认）：适合终端显示
- Markdown 格式：使用 `-f markdown` 参数

## 数据库内容

- **50+ UI 样式**：玻璃态、粘土态、极简、野兽派等
- **97 种配色方案**：按产品类型和行业分类
- **57 种字体配对**：包含 Google Fonts 导入链接
- **25 种图表类型**：包含库推荐和最佳实践
- **99 条 UX 指南**：无障碍访问、性能、交互等
- **100 条推理规则**：智能设计系统生成
- **9 种技术栈指南**：特定实现的最佳实践

## 注意事项

1. 始终从 `--design-system` 开始获取完整推荐
2. 使用具体关键词可获得更好结果
3. 可以多次搜索不同关键词以获取更多见解
4. 默认技术栈是 `html-tailwind`
