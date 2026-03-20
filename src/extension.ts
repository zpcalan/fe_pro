// ============================================================
// extension.ts  —  Cue Pro VSCode Extension Entry Point
// Wires all components together and registers commands/providers
// ============================================================

import * as vscode from 'vscode';
import { EditContextManager } from './editContextManager';
import { LspBridge } from './lspBridge';
import { EmbeddingClient } from './embeddingClient';
import { VectorStore } from './vectorStore';
import { GlmClient } from './glmClient';
import { EditSequenceEngine } from './editSequenceEngine';
import { TabNavigator } from './tabNavigator';
import { DecorationManager } from './decorationManager';
import { EditSequencePanel } from './panel/editSequencePanel';

export function activate(context: vscode.ExtensionContext): void {
  console.log('[CuePro] Activating Cue Pro extension…');

  // ── Set ETS files to use TypeScript language mode ──────────────
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.fileName.endsWith('.ets')) {
        vscode.languages.setTextDocumentLanguage(doc, 'typescript');
      }
    })
  );
  // Apply to already open documents
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.fileName.endsWith('.ets')) {
      vscode.languages.setTextDocumentLanguage(doc, 'typescript');
    }
  });

  // ── Instantiate core services ──────────────────────────────
  const contextManager = new EditContextManager();
  const lspBridge = new LspBridge();
  const embeddingClient = new EmbeddingClient();
  const vectorStore = new VectorStore(embeddingClient);
  const glmClient = new GlmClient();
  const decorationManager = new DecorationManager();
  const engine = new EditSequenceEngine(contextManager, lspBridge, vectorStore, glmClient);
  const navigator = new TabNavigator(decorationManager);
  const panel = new EditSequencePanel(context.extensionUri);

  // ── Status bar item ────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'cuePro.showPanel';
  statusBarItem.text = '$(sparkle) Cue Pro';
  statusBarItem.tooltip = 'Cue Pro: Click to show edit sequence panel';
  statusBarItem.show();

  // ── Register WebView provider ──────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EditSequencePanel.VIEW_ID, panel)
  );

  // ── Wire engine events → panel + navigator ─────────────────
  context.subscriptions.push(
    engine.onSequenceUpdated.event(result => {
      navigator.setSequence(result);
      decorationManager.updateSequence(result);
      panel.updateSequence(result);

      if (result) {
        const cfg = vscode.workspace.getConfiguration('cuePro');
        if (cfg.get<boolean>('ui.autoShowPanel', true)) {
          vscode.commands.executeCommand('cuePro.sequencePanel.focus');
        }
        statusBarItem.text = `$(sparkle) Cue Pro (${result.sequence.length})`;
        statusBarItem.tooltip = `Cue Pro: ${result.intentSummary} — ${result.sequence.length} predicted edits`;
      } else {
        statusBarItem.text = '$(sparkle) Cue Pro';
        statusBarItem.tooltip = 'Cue Pro: No active sequence';
      }
    }),

    engine.onLoadingChanged.event(({ loading, message }) => {
      panel.setLoading(loading, message);
      if (loading) {
        statusBarItem.text = '$(sync~spin) Cue Pro';
        statusBarItem.tooltip = message ?? 'Analyzing…';
      } else {
        statusBarItem.text = '$(sparkle) Cue Pro';
      }
    }),

    engine.onError.event(message => {
      panel.setError(message);
      vscode.window.showErrorMessage(`[Cue Pro] ${message}`);
      statusBarItem.text = '$(sparkle) Cue Pro';
    }),

    engine.onReviewUpdated.event(result => {
      panel.updateReview(result);
    }),

    engine.onReviewLoadingChanged.event(({ loading, message }) => {
      panel.setReviewLoading(loading, message);
    }),

    engine.onReviewError.event(message => {
      panel.setReviewError(message);
    })
  );

  // ── Wire navigator events → panel ─────────────────────────
  context.subscriptions.push(
    navigator.onCandidateStatusChanged.event(({ id, status }) => {
      panel.updateCandidateStatus(id, status);
    })
  );

  // ── Wire vector store progress → panel ────────────────────
  context.subscriptions.push(
    vectorStore.onProgress(({ indexed, total }) => {
      panel.setIndexingProgress(indexed, total);
      if (indexed >= total) {
        vscode.window.setStatusBarMessage(
          `$(check) Cue Pro: Indexed ${total} files`,
          3000
        );
      }
    })
  );

  // ── Wire panel → extension (user actions from WebView) ─────
  panel.onNavigateTo = (id) => navigator.navigateToCandidateById(id);
  panel.onNavigateToReview = async (file: string, startLine: number) => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    try {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
      // startLine is 1-based from LLM; VSCode Range is 0-based
      const line = Math.max(0, startLine - 1);
      const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(line, 0, line, 0);
    } catch {
      vscode.window.showWarningMessage(`[Cue Pro] Could not open file: ${file}`);
    }
  };
  panel.onAcceptCandidate = (id) => {
    const candidate = navigator['sequence']?.sequence.find((c: { id: string }) => c.id === id);
    if (candidate) navigator.applyCandidate(candidate);
  };
  panel.onRejectCandidate = (id) => {
    const seq = navigator['sequence'];
    if (seq) {
      const c = seq.sequence.find((c: { id: string }) => c.id === id);
      if (c) {
        c.status = 'rejected';
        decorationManager.markRejected(id);
        panel.updateCandidateStatus(id, 'rejected');
      }
    }
  };
  panel.onTriggerAnalysis = () => engine.triggerManual();
  panel.onIndexWorkspace = () => vectorStore.indexWorkspace();
  panel.onTriggerReview = () => engine.triggerReview();
  panel.onClearSequence = () => {
    navigator.setSequence(null);
    decorationManager.updateSequence(null);
    panel.updateReview(null);
    statusBarItem.text = '$(sparkle) Cue Pro';
  };

  // ── Register commands ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('cuePro.triggerAnalysis', () => {
      engine.triggerManual().catch(err => {
        vscode.window.showErrorMessage(`[Cue Pro] Analysis failed: ${err.message}`);
      });
    }),

    vscode.commands.registerCommand('cuePro.jumpToNextEdit', () => {
      navigator.jumpToNext().catch(err => {
        vscode.window.showErrorMessage(`[Cue Pro] Navigation failed: ${err.message}`);
      });
    }),

    vscode.commands.registerCommand('cuePro.jumpToPrevEdit', () => {
      navigator.jumpToPrev().catch(err => {
        vscode.window.showErrorMessage(`[Cue Pro] Navigation failed: ${err.message}`);
      });
    }),

    vscode.commands.registerCommand('cuePro.acceptCurrentEdit', () => {
      navigator.acceptCurrentCandidate().catch(err => {
        vscode.window.showErrorMessage(`[Cue Pro] Accept failed: ${err.message}`);
      });
    }),

    vscode.commands.registerCommand('cuePro.rejectCurrentEdit', () => {
      navigator.rejectCurrentCandidate();
    }),

    vscode.commands.registerCommand('cuePro.clearSequence', () => {
      navigator.setSequence(null);
      decorationManager.updateSequence(null);
      panel.updateSequence(null);
      statusBarItem.text = '$(sparkle) Cue Pro';
    }),

    vscode.commands.registerCommand('cuePro.indexWorkspace', async () => {
      if (vectorStore.isIndexing) {
        vscode.window.showInformationMessage('[Cue Pro] Indexing already in progress…');
        return;
      }
      vscode.window.showInformationMessage('[Cue Pro] Starting workspace indexing…');
      await vectorStore.indexWorkspace();
    }),

    vscode.commands.registerCommand('cuePro.showPanel', () => {
      vscode.commands.executeCommand('cuePro.sequencePanel.focus');
    })
  );

  // ── Auto-index workspace on startup (delayed to let VS Code settle) ──
  setTimeout(() => {
    if (!vectorStore.isIndexing && vectorStore.chunkCount === 0) {
      console.log('[CuePro] Auto-indexing workspace on startup…');
      vectorStore.indexWorkspace().catch(err => {
        console.error('[CuePro] Auto-index failed:', err);
      });
    }
  }, 2000);

  // ── Initial setup: set VS Code contexts ───────────────────
  vscode.commands.executeCommand('setContext', 'cuePro.hasSequence', false);
  vscode.commands.executeCommand('setContext', 'cuePro.hasActiveEdit', false);

  // ── Register disposables ───────────────────────────────────
  context.subscriptions.push(
    contextManager,
    vectorStore,
    engine,
    decorationManager,
    statusBarItem,
    { dispose: () => navigator.dispose() }
  );

  console.log('[CuePro] Cue Pro extension activated successfully');
  vscode.window.showInformationMessage(
    '$(sparkle) Cue Pro activated. Start editing to predict related changes across your repository.'
  );
}

export function deactivate(): void {
  console.log('[CuePro] Cue Pro extension deactivated');
}
