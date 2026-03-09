# Cue Pro 插件用法

---

## 功能一：编辑序列显示（Edit Sequence Display）

### 触发方式

**自动触发（推荐）：**

1. 对工作区内的文件进行编辑
2. 累计保存 **3 次**（默认）后，插件自动启动分析
3. 侧边栏面板自动弹出，展示预测编辑序列

---

### 侧边栏面板（Predictions 标签页）

分析完成后，左侧边栏 **Cue Pro** 视图的 **Predictions** 标签页会显示预测卡片：

```
┌─────────────────────────────────────┐
│  Predictions  │  Code Review        │
├─────────────────────────────────────┤
│  Intent: 更新了接口签名，需同步     │
│  调用方和实现类                     │
│                                     │
│  ① src/service.ts : 42             │
│  ████████░░  flow: 0.85            │
│  - oldMethod(a: string)            │
│  + newMethod(a: string, b: number) │
│  [Accept ✓]  [Skip ✕]             │
│                                     │
│  ② src/client.ts : 17             │
│  ██████░░░░  flow: 0.71            │
│  ...                                │
│                                     │
│  Footer: 0 / 2 accepted            │
└─────────────────────────────────────┘
```

每张预测卡片包含：

| 元素 | 说明 |
| --- | --- |
| 序号 (①②③) | 建议执行的顺序 |
| 文件名 + 行号 | 需要修改的位置 |
| Flow Score 进度条 | 0~1，越高表示与当前修改连贯性越强 |
| Diff 展示 | 红色 `-` 为原代码，绿色 `+` 为建议代码 |
| 状态徽标 | `◈` pending / `✓` accepted / `✕` rejected |

---

**面板操作：**

- **点击卡片** → 跳转到对应代码位置并展开卡片
- **Accept ✓** → 将建议代码写入文件，状态变为 `✓`
- **Skip ✕** → 跳过此建议，状态变为 `✕`
- **清除** → 面板底部 "Clear" 按钮清除当前序列

---

## 功能二：Code Review 显示

### 触发方式

**自动触发**（完成一次编辑序列分析后）：

- 变更行数 ≥ 5 行
- 距离上次 Code Review ≥ 60 秒
- 满足条件时，分析结束约 **1.5 秒**后自动触发

---

### 侧边栏面板（Code Review 标签页）

```
┌─────────────────────────────────────┐
│  Predictions  │  Code Review  ←     │
├─────────────────────────────────────┤
│  Summary: 整体逻辑正确，存在2处     │
│  潜在的空指针风险                   │
│                                     │
│  🔴 error   src/parser.ts : 34-36  │
│  [bug]                              │
│  变量 result 在使用前未检查是否为  │
│  null，可能导致运行时崩溃          │
│  建议：添加 if (!result) return    │
│  ┌─────────────────────────┐        │
│  │ const val = result.data │        │
│  └─────────────────────────┘        │
│  [Go to Line]                       │
│                                     │
│  🟡 warning src/utils.ts : 12      │
│  [performance]                      │
│  循环内重复调用 JSON.parse，        │
│  建议提取到循环外                   │
│  [Go to Line]                       │
│                                     │
│  🔵 info   src/types.ts : 8        │
│  [style]  ...                       │
└─────────────────────────────────────┘
```

---

### 评审条目说明

| 字段 | 可能的值 |
| --- | --- |
| 严重程度 | 🔴 `error` / 🟡 `warning` / 🔵 `info` |
| 类别 | `bug` / `performance` / `style` / `security` / `maintainability` / `correctness` |
| 位置 | 文件名 + 行号范围（1-based） |
| 消息 | 问题描述（中文） |
| 建议 | 修复建议（中文，可选） |
| 代码片段 | 问题对应的实际代码 |

评审条目按严重程度排序：`error` → `warning` → `info`

---

### 操作方式

- **Go to Line** 按钮 → 在编辑器中跳转到问题所在行

---

## 配置参考

在 VS Code 设置（`settings.json`）中可调整以下关键参数：

```jsonc
{
  // 触发阈值
  "cuePro.trigger.minSavesToTrigger": 3,    // 累计保存几次后分析
  "cuePro.trigger.debounceMs": 2000,         // 编辑停止后等待时间(ms)

  // LLM 配置
  "cuePro.glm.apiKey": "your-api-key",
  "cuePro.glm.model": "ep-xxxx",

  // Embedding 配置
  "cuePro.embedding.apiKey": "sk-xxxx",
  "cuePro.embedding.enabled": true,

  // UI
  "cuePro.ui.autoShowPanel": true,           // 分析后自动展开面板
  "cuePro.ui.showInlineDecorations": true    // 显示编辑器行间标记
}
```
