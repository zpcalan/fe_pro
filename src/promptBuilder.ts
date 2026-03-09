// ============================================================
// promptBuilder.ts  —  LLM prompt construction for Cue Pro
// Two-phase strategy:
//   Phase 1: intent inference + candidate edit generation (with diffs)
//   Phase 2: ordering + flow continuity filtering
// ============================================================

import { EditSnapshot, CandidateLocation, Phase1CandidateOutput, ChatMessage } from './types';

// ── Code Review ──────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = `你是一位资深代码审查专家。你将看到近期代码变更及其行号。

请审查每个文件的 AFTER（当前）版本，给出具体、可操作的中文反馈。

关键要求：每条评论必须引用 AFTER 版本中精确的行号范围。

每条问题请包含：
- file: 标题中显示的文件名
- startLine: 问题代码的起始行号（使用显示的行号，从 1 开始）
- endLine: 问题代码的结束行号（从 1 开始）
- severity: "info" | "warning" | "error"
- category: "bug"、"performance"、"style"、"security"、"maintainability"、"correctness" 之一
- message: 对问题的清晰简洁的中文描述
- suggestion: （可选）中文修复建议

输出格式（严格 JSON，无 markdown）：
{
  "comments": [
    {
      "file": "src/example.ts",
      "startLine": 42,
      "endLine": 48,
      "severity": "warning",
      "category": "maintainability",
      "message": "该函数过长，承担了多个职责，不易维护。",
      "suggestion": "建议拆分为多个小函数，每个函数只负责单一职责。"
    }
  ],
  "summary": "总体评价：用 1-2 句中文概括本次变更的质量和意图。"
}

若代码变更没有问题，返回空的 comments 数组并给出正面的中文总结。`;

export function buildReviewMessages(snapshots: EditSnapshot[]): ChatMessage[] {
  const sections: string[] = [];

  const diffs = snapshots.map(s => {
    const beforeLines = s.beforeCode.split('\n');
    const afterLines = s.afterCode.split('\n');
    const changed = findChangedRegion(beforeLines, afterLines);
    const context = 15;
    const startCtx = Math.max(0, changed.start - context);
    const endCtxBefore = Math.min(beforeLines.length - 1, changed.end + context);
    const endCtxAfter = Math.min(afterLines.length - 1, changed.end + context);

    // Show before with line numbers (1-based)
    const beforeSnip = beforeLines
      .slice(startCtx, endCtxBefore + 1)
      .map((l, i) => `${String(startCtx + i + 1).padStart(4)} | ${l}`)
      .join('\n');

    // Show after with line numbers (1-based) — these are what the LLM must reference
    const afterSnip = afterLines
      .slice(startCtx, endCtxAfter + 1)
      .map((l, i) => `${String(startCtx + i + 1).padStart(4)} | ${l}`)
      .join('\n');

    return `### File: ${s.file}
**Before (lines ${startCtx + 1}–${endCtxBefore + 1}):**
\`\`\`
${beforeSnip}
\`\`\`
**After (lines ${startCtx + 1}–${endCtxAfter + 1}) — reference these line numbers in your comments:**
\`\`\`
${afterSnip}
\`\`\``;
  }).join('\n\n');

  sections.push(`## Changed Files\n${diffs}`);
  sections.push(`## Task\nReview the AFTER version of each file. For every issue, specify the exact startLine and endLine from the After listing. Return JSON only.`);

  return [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

// ── Phase 1 ─────────────────────────────────────────────────────────────────

const PHASE1_SYSTEM = `你是一位资深代码重构专家。

你将看到代码库中的若干代码块，请对每个代码块给出改进或重构建议。

关键规则：
- 对所有代码块都生成改进建议（needsChange 一律设为 true）
- "reason" 字段用中文描述你对该代码块做了什么改进
- 不要提及"开发者的改动"或"保持一致性"，聚焦于代码块本身
- 改进方向：更好的命名、错误处理、类型安全、可读性等
- "suggestedCode" 输出完整的替换代码块，不含行号或任何前缀
- "suggestedCode" 必须是纯代码，禁止在代码中添加任何中文字符（包括中文注释、中文变量名、中文字符串字面量），保持与原始代码相同的语言风格

输出格式（严格 JSON，无 markdown）：
{
  "candidates": [
    {
      "candidateIndex": 1,
      "needsChange": true,
      "suggestedCode": "完整的改进后代码（无中文）",
      "reason": "增加了错误处理并改善了变量命名"
    }
  ]
}`;

export function buildPhase1Messages(
  snapshots: EditSnapshot[],
  candidates: CandidateLocation[],
  triggerFile: string,
  triggerLine: number
): ChatMessage[] {
  const sections: string[] = [];

  // Section: Candidate code blocks to improve
  const candidatesList = candidates.map((c, i) => {
    return `### Candidate ${i + 1}: ${c.file} lines ${c.startLine + 1}-${c.endLine + 1}
\`\`\`
${c.currentCode}
\`\`\``;
  }).join('\n\n');

  sections.push(`## Code Blocks to Improve
${candidatesList}`);

  sections.push(`## Task
For each code block above, suggest a realistic improvement or refactoring. \
Focus on what YOU can improve in each specific block (naming, error handling, types, readability, etc.).`);

  return [
    { role: 'system', content: PHASE1_SYSTEM },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

// ── Phase 2 ─────────────────────────────────────────────────────────────────

const PHASE2_SYSTEM = `你是一位资深软件工程助手，负责对代码改动建议进行排序。

你将收到一批代码改进建议（每条用 candidateIndex 标识）。

你唯一的任务：
- 按逻辑顺序对所有候选项排序

关键规则：
- 必须在 editSequence 数组中返回所有候选项（不得过滤任何一条）
- 为每条分配 order 编号（1 = 最先改，2 = 其次，以此类推）
- flowScore 统一设为 1.0
- flowReason 用中文简要说明排序理由

输出格式（严格 JSON，无 markdown）：
{
  "editSequence": [
    {
      "candidateIndex": 1,
      "order": 1,
      "flowScore": 1.0,
      "flowReason": "基础接口变更应最先完成，其他模块依赖于此"
    }
  ]
}

返回所有候选项并分配好顺序。`;

export function buildPhase2Messages(
  phase1Candidates: Phase1CandidateOutput[]
): ChatMessage[] {
  const candidatesList = phase1Candidates
    .filter(c => c.needsChange)
    .map(c => `  - Candidate ${c.candidateIndex}: ${c.reason}`)
    .join('\n');

  const userContent = `## Proposed Changes (to order)
${candidatesList || '  (none)'}

## Task
Order ALL the above candidates. Return every candidate with an assigned order number.`;

  return [
    { role: 'system', content: PHASE2_SYSTEM },
    { role: 'user', content: userContent },
  ];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Truncate to at most maxLines lines, appending a note if truncated */
function truncateLines(lines: string[], maxLines: number): string {
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length - maxLines} more lines)`;
}

/** Find the first and last line that differ between two texts */
function findChangedRegion(beforeLines: string[], afterLines: string[]): { start: number; end: number } {
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start++;
  }

  // If no changes found, return middle of file
  if (start >= beforeLines.length && start >= afterLines.length) {
    return { start: 0, end: Math.max(beforeLines.length, afterLines.length) - 1 };
  }

  let endB = beforeLines.length - 1;
  let endA = afterLines.length - 1;
  while (endB > start && endA > start && beforeLines[endB] === afterLines[endA]) {
    endB--;
    endA--;
  }

  return { start, end: Math.max(endA, endB) };
}
