// ============================================================
// decorationManager.ts  —  Editor decorations for predicted edits
// Shows colored gutters and inline hints for predicted edit locations
// ============================================================

import * as vscode from 'vscode';
import { EditCandidate, EditSequenceResult } from './types';

// Gutter decoration: colored dot in the gutter
const PENDING_GUTTER = vscode.window.createTextEditorDecorationType({
  gutterIconSize: 'contain',
  overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  before: {
    contentText: '◈',
    color: new vscode.ThemeColor('editorWarning.foreground'),
    margin: '0 4px 0 0',
    fontWeight: 'bold',
  },
});

const ACTIVE_GUTTER = vscode.window.createTextEditorDecorationType({
  gutterIconSize: 'contain',
  overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  before: {
    contentText: '▶',
    color: new vscode.ThemeColor('editorInfo.foreground'),
    margin: '0 4px 0 0',
    fontWeight: 'bold',
  },
  isWholeLine: true,
});

const ACCEPTED_GUTTER = vscode.window.createTextEditorDecorationType({
  before: {
    contentText: '✓',
    color: new vscode.ThemeColor('editorGhostText.foreground'),
    margin: '0 4px 0 0',
  },
});

export class DecorationManager {
  private decoratedEditors: Map<string, vscode.TextEditor> = new Map();
  private activeId: string | null = null;
  private currentResult: EditSequenceResult | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
    );
  }

  updateSequence(result: EditSequenceResult | null): void {
    this.currentResult = result;
    this.refresh();
  }

  setActiveCandidate(id: string | null): void {
    this.activeId = id;
    this.refresh();
  }

  markAccepted(id: string): void {
    if (!this.currentResult) return;
    const candidate = this.currentResult.sequence.find(c => c.id === id);
    if (candidate) candidate.status = 'accepted';
    this.refresh();
  }

  markRejected(id: string): void {
    if (!this.currentResult) return;
    const candidate = this.currentResult.sequence.find(c => c.id === id);
    if (candidate) candidate.status = 'rejected';
    this.refresh();
  }

  private refresh(): void {
    this.clearAll();
    if (!this.currentResult) return;

    const cfg = vscode.workspace.getConfiguration('cuePro');
    if (!cfg.get<boolean>('ui.showInlineDecorations', true)) return;

    // Group candidates by file
    const byFile = new Map<string, EditCandidate[]>();
    for (const c of this.currentResult.sequence) {
      const list = byFile.get(c.uri) ?? [];
      list.push(c);
      byFile.set(c.uri, list);
    }

    // Apply decorations to all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      const uriStr = editor.document.uri.toString();
      const candidates = byFile.get(uriStr);
      if (!candidates) continue;

      this.decoratedEditors.set(uriStr, editor);

      const pendingRanges: vscode.DecorationOptions[] = [];
      const activeRanges: vscode.DecorationOptions[] = [];
      const acceptedRanges: vscode.DecorationOptions[] = [];

      for (const c of candidates) {
        const startLine = Math.min(c.startLine, editor.document.lineCount - 1);
        const range = new vscode.Range(startLine, 0, startLine, 0);
        const hoverMsg = new vscode.MarkdownString(
          `**Cue Pro** [#${c.order}]: ${c.reason}\n\n` +
          `Flow score: ${(c.flowScore * 100).toFixed(0)}%\n\n` +
          `\`Ctrl+Shift+Enter\` to accept · \`Escape\` to reject`
        );
        hoverMsg.isTrusted = true;

        if (c.id === this.activeId) {
          activeRanges.push({ range, hoverMessage: hoverMsg });
        } else if (c.status === 'accepted') {
          acceptedRanges.push({ range });
        } else if (c.status === 'pending') {
          pendingRanges.push({ range, hoverMessage: hoverMsg });
        }
      }

      editor.setDecorations(PENDING_GUTTER, pendingRanges);
      editor.setDecorations(ACTIVE_GUTTER, activeRanges);
      editor.setDecorations(ACCEPTED_GUTTER, acceptedRanges);
    }
  }

  private clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(PENDING_GUTTER, []);
      editor.setDecorations(ACTIVE_GUTTER, []);
      editor.setDecorations(ACCEPTED_GUTTER, []);
    }
    this.decoratedEditors.clear();
  }

  dispose(): void {
    this.clearAll();
    PENDING_GUTTER.dispose();
    ACTIVE_GUTTER.dispose();
    ACCEPTED_GUTTER.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
