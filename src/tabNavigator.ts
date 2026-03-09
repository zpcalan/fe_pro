// ============================================================
// tabNavigator.ts  —  Navigate between predicted edit locations
// Manages the queue of pending edits and handles accept/reject
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import { EditCandidate, EditSequenceResult } from './types';
import { DecorationManager } from './decorationManager';

export class TabNavigator {
  private sequence: EditSequenceResult | null = null;
  private currentIndex = 0;

  readonly onCandidateStatusChanged = new vscode.EventEmitter<{
    id: string;
    status: EditCandidate['status'];
  }>();

  constructor(private readonly decorationManager: DecorationManager) {}

  setSequence(result: EditSequenceResult | null): void {
    this.sequence = result;
    this.currentIndex = 0;
    if (result && result.sequence.length > 0) {
      this.decorationManager.setActiveCandidate(result.sequence[0].id);
    } else {
      this.decorationManager.setActiveCandidate(null);
    }
    vscode.commands.executeCommand(
      'setContext',
      'cuePro.hasSequence',
      result !== null && result.sequence.length > 0
    );
    vscode.commands.executeCommand(
      'setContext',
      'cuePro.hasActiveEdit',
      false
    );
  }

  get currentCandidate(): EditCandidate | undefined {
    if (!this.sequence) return undefined;
    const pending = this.sequence.sequence.filter(c => c.status === 'pending');
    return pending[this.currentIndex];
  }

  get pendingCount(): number {
    return this.sequence?.sequence.filter(c => c.status === 'pending').length ?? 0;
  }

  /** Jump to the next pending edit in the sequence */
  async jumpToNext(): Promise<void> {
    if (!this.sequence) return;
    const pending = this.sequence.sequence.filter(c => c.status === 'pending');
    if (pending.length === 0) return;

    this.currentIndex = (this.currentIndex) % pending.length;
    const candidate = pending[this.currentIndex];
    await this.navigateTo(candidate);
    this.currentIndex = (this.currentIndex + 1) % pending.length;
  }

  /** Jump to the previous pending edit */
  async jumpToPrev(): Promise<void> {
    if (!this.sequence) return;
    const pending = this.sequence.sequence.filter(c => c.status === 'pending');
    if (pending.length === 0) return;

    this.currentIndex = (this.currentIndex - 2 + pending.length) % pending.length;
    const candidate = pending[this.currentIndex];
    await this.navigateTo(candidate);
    this.currentIndex = (this.currentIndex + 1) % pending.length;
  }

  /** Navigate to a specific candidate by ID */
  async navigateToCandidateById(id: string): Promise<void> {
    const candidate = this.sequence?.sequence.find(c => c.id === id);
    if (!candidate) return;
    await this.navigateTo(candidate);
  }

  /** Apply the current candidate's suggested code and mark as accepted */
  async acceptCurrentCandidate(): Promise<void> {
    const candidate = this.currentCandidate;
    if (!candidate) return;
    await this.applyCandidate(candidate);
  }

  /** Reject (skip) the current candidate */
  rejectCurrentCandidate(): void {
    const candidate = this.currentCandidate;
    if (!candidate) return;
    candidate.status = 'rejected';
    this.decorationManager.markRejected(candidate.id);
    this.onCandidateStatusChanged.fire({ id: candidate.id, status: 'rejected' });
    vscode.commands.executeCommand('setContext', 'cuePro.hasActiveEdit', false);
    this.decorationManager.setActiveCandidate(null);
  }

  /** Apply a candidate edit to the document */
  async applyCandidate(candidate: EditCandidate): Promise<void> {
    let fileUri: vscode.Uri;
    try {
      fileUri = vscode.Uri.parse(candidate.uri);
    } catch {
      vscode.window.showErrorMessage(`[Cue Pro] Cannot resolve file: ${candidate.file}`);
      return;
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      vscode.window.showErrorMessage(`[Cue Pro] Cannot open file: ${candidate.file}`);
      return;
    }

    const editor = await vscode.window.showTextDocument(doc);
    const docText = doc.getText();

    // Primary: find originalCode by exact text search — position-independent
    const originalIdx = docText.indexOf(candidate.originalCode);
    let range: vscode.Range;

    if (originalIdx !== -1) {
      const startPos = doc.positionAt(originalIdx);
      const endPos   = doc.positionAt(originalIdx + candidate.originalCode.length);
      range = new vscode.Range(startPos, endPos);
    } else {
      // Fallback: use stored line range (best-effort)
      const startLine = Math.min(candidate.startLine, doc.lineCount - 1);
      const endLine   = Math.min(candidate.endLine,   doc.lineCount - 1);
      range = new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, doc.lineAt(endLine).text.length)
      );
      vscode.window.showWarningMessage(
        `[Cue Pro] Could not locate original code exactly — applying to line range ${startLine + 1}-${endLine + 1}`
      );
    }

    const success = await editor.edit(editBuilder => {
      editBuilder.replace(range, candidate.suggestedCode);
    });

    if (success) {
      candidate.status = 'accepted';
      this.decorationManager.markAccepted(candidate.id);
      this.onCandidateStatusChanged.fire({ id: candidate.id, status: 'accepted' });
      vscode.window.showInformationMessage(
        `[Cue Pro] ✓ Applied: ${path.basename(candidate.file)}:${candidate.startLine + 1}`
      );
    } else {
      vscode.window.showWarningMessage('[Cue Pro] Could not apply edit — file may have changed');
    }

    vscode.commands.executeCommand('setContext', 'cuePro.hasActiveEdit', false);
    this.decorationManager.setActiveCandidate(null);
  }

  private async navigateTo(candidate: EditCandidate): Promise<void> {
    let fileUri: vscode.Uri;
    try {
      fileUri = vscode.Uri.parse(candidate.uri);
    } catch {
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: false,
        preview: false,
      });

      const line = Math.min(candidate.startLine, doc.lineCount - 1);
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, new vscode.Position(Math.min(line + 5, doc.lineCount - 1), 0)),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );

      this.decorationManager.setActiveCandidate(candidate.id);
      vscode.commands.executeCommand('setContext', 'cuePro.hasActiveEdit', true);
    } catch (err) {
      console.error('[CuePro] Navigate failed:', err);
    }
  }

  dispose(): void {
    this.onCandidateStatusChanged.dispose();
  }
}
