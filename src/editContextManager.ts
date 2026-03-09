// ============================================================
// editContextManager.ts  —  Tracks file before/after snapshots
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import { EditSnapshot } from './types';
import { getConfig } from './config';

/**
 * Captures the "before" state of each file when it is first opened or
 * first edited in the current session. The "after" state is always read
 * live from the document at analysis time.
 *
 * Fires onSaveThresholdReached when N saves have accumulated.
 */
export class EditContextManager {
  /** uri string → full file content at the start of the editing session */
  private readonly beforeContent = new Map<string, string>();

  /** URIs of files edited since the last analysis trigger */
  private readonly pendingEditUris = new Set<string>();

  /** Count of saves since last trigger */
  private saveCountSinceLastTrigger = 0;

  private lastEditedUri: vscode.Uri | undefined;

  private readonly onSaveThresholdReachedEmitter = new vscode.EventEmitter<void>();
  readonly onSaveThresholdReached = this.onSaveThresholdReachedEmitter.event;

  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Seed "before" content for all already-open documents
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') {
        this.beforeContent.set(doc.uri.toString(), doc.getText());
      }
    }

    this.disposables.push(
      // Capture "before" when a new file is opened
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.uri.scheme === 'file' && !this.beforeContent.has(doc.uri.toString())) {
          this.beforeContent.set(doc.uri.toString(), doc.getText());
        }
      }),

      // Track edits (but don't trigger analysis yet)
      vscode.workspace.onDidChangeTextDocument(event => {
        const doc = event.document;
        if (doc.uri.scheme !== 'file') return;
        if (event.contentChanges.length === 0) return;

        const cfg = getConfig();
        const hasSignificantChange = event.contentChanges.some(c => {
          const lines = Math.max(
            1,
            c.text.split('\n').length,
            c.range.end.line - c.range.start.line + 1
          );
          return lines >= cfg.minEditLines && (c.text.trim().length > 0 || c.rangeLength > 0);
        });
        if (!hasSignificantChange) return;

        // If this file has never been seen, record its current text as "before".
        if (!this.beforeContent.has(doc.uri.toString())) {
          this.beforeContent.set(doc.uri.toString(), doc.getText());
        }

        this.lastEditedUri = doc.uri;
        this.pendingEditUris.add(doc.uri.toString());
      }),

      // Trigger on save
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.scheme !== 'file') return;

        const cfg = getConfig();
        this.saveCountSinceLastTrigger++;

        console.log(`[CuePro] Save ${this.saveCountSinceLastTrigger}/${cfg.minSavesToTrigger} (${doc.uri.fsPath})`);

        if (this.saveCountSinceLastTrigger >= cfg.minSavesToTrigger) {
          this.saveCountSinceLastTrigger = 0;
          this.onSaveThresholdReachedEmitter.fire();
        }
      })
    );
  }

  /**
   * Returns snapshots for ALL files edited since the last clearPendingEdits() call.
   * Files with no actual change (before === after) are excluded.
   */
  getPendingSnapshots(
    workspaceFolder: vscode.WorkspaceFolder | undefined
  ): EditSnapshot[] {
    const snapshots: EditSnapshot[] = [];
    for (const uriStr of this.pendingEditUris) {
      const uri = vscode.Uri.parse(uriStr);
      const snapshot = this.getSnapshot(uri, workspaceFolder);
      if (snapshot && snapshot.beforeCode !== snapshot.afterCode) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  /** Clear the pending-edits set and reset "before" snapshots after a trigger fires */
  clearPendingEdits(): void {
    // Reset "before" snapshots for all pending files so next session starts fresh
    for (const uriStr of this.pendingEditUris) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
      if (doc) {
        this.beforeContent.set(uriStr, doc.getText());
      }
    }
    this.pendingEditUris.clear();
  }

  /**
   * Returns a before/after snapshot for the given URI.
   * beforeCode = content at start of session (or last save).
   * afterCode  = current document content.
   */
  getSnapshot(
    uri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder | undefined
  ): EditSnapshot | undefined {
    const doc = vscode.workspace.textDocuments.find(
      d => d.uri.toString() === uri.toString()
    );
    if (!doc) return undefined;

    const afterCode = doc.getText();
    const beforeCode = this.beforeContent.get(uri.toString()) ?? afterCode;
    const relativeFile = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
      : uri.fsPath;

    return {
      file: relativeFile,
      uri: uri.toString(),
      languageId: doc.languageId,
      beforeCode,
      afterCode,
    };
  }

  getLastEditedUri(): vscode.Uri | undefined {
    return this.lastEditedUri;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.onSaveThresholdReachedEmitter.dispose();
  }
}
