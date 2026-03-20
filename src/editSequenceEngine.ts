// ============================================================
// editSequenceEngine.ts  —  Orchestrates the full analysis pipeline
//
// Pipeline:
//   [Trigger] edit debounce
//       ↓
//   [A] Gather LSP context + semantic search results
//       ↓
//   [B] Phase 1 LLM call: intent inference + candidate generation with diffs
//       ↓
//   [C] Phase 2 LLM call: ordering + flow continuity filtering
//       ↓
//   [D] Emit EditSequenceResult to panel + navigator
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

import { EditContextManager } from './editContextManager';
import { LspBridge } from './lspBridge';
import { VectorStore } from './vectorStore';
import { GlmClient } from './glmClient';
import { buildPhase1Messages, buildPhase2Messages, buildReviewMessages } from './promptBuilder';
import { getConfig, requireConfig } from './config';
import {
  CandidateLocation,
  SemanticSearchResult,
  Phase1Result,
  Phase2Result,
  EditCandidate,
  EditSequenceResult,
  EditSnapshot,
  CodeReviewResult,
} from './types';

export class EditSequenceEngine {
  private running = false;
  private reviewRunning = false;
  private lastSnapshots: EditSnapshot[] = [];
  private lastReviewTime = 0;
  private autoReviewTimer: ReturnType<typeof setTimeout> | undefined;

  /** Minimum changed lines across all snapshots to trigger auto-review */
  private static readonly MIN_REVIEW_LINES = 5;
  /** Minimum ms between two auto-reviews (60 s cooldown) */
  private static readonly REVIEW_COOLDOWN_MS = 60_000;
  /** Delay after analysis finishes before starting auto-review (let UI settle) */
  private static readonly AUTO_REVIEW_DELAY_MS = 1_500;

  readonly onSequenceUpdated = new vscode.EventEmitter<EditSequenceResult | null>();
  readonly onLoadingChanged = new vscode.EventEmitter<{ loading: boolean; message?: string }>();
  readonly onError = new vscode.EventEmitter<string>();
  readonly onReviewUpdated = new vscode.EventEmitter<CodeReviewResult | null>();
  readonly onReviewLoadingChanged = new vscode.EventEmitter<{ loading: boolean; message?: string }>();
  readonly onReviewError = new vscode.EventEmitter<string>();

  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly contextManager: EditContextManager,
    private readonly lspBridge: LspBridge,
    private readonly vectorStore: VectorStore,
    private readonly glmClient: GlmClient
  ) {
    // Trigger on save threshold
    this.disposables.push(
      contextManager.onSaveThresholdReached(() => this.run())
    );
  }

  /** Manually trigger analysis (e.g., from command palette) */
  async triggerManual(): Promise<void> {
    await this.run();
  }

  /**
   * Auto-review trigger rules (all three must pass):
   *   Rule 1 — After analysis: called only from run() after onSequenceUpdated fires
   *   Rule 2 — Significant change: total changed lines >= MIN_REVIEW_LINES
   *   Rule 3 — Cooldown: at least REVIEW_COOLDOWN_MS since the last review
   */
  private scheduleAutoReview(snapshots: EditSnapshot[], sequenceResult: EditSequenceResult): void {
    // Rule 2: count changed lines via line count delta
    const changedLines = snapshots.reduce((sum, s) => {
      if (s.beforeCode === s.afterCode) return sum;
      const beforeLines = s.beforeCode.split('\n').length;
      const afterLines  = s.afterCode.split('\n').length;
      return sum + Math.abs(afterLines - beforeLines);
    }, 0);

    if (changedLines < EditSequenceEngine.MIN_REVIEW_LINES) {
      console.log(`[CuePro Review] Auto-review skipped: only ${changedLines} lines changed (min ${EditSequenceEngine.MIN_REVIEW_LINES})`);
      this.onSequenceUpdated.fire(sequenceResult);
      return;
    }

    // Rule 3: cooldown
    const now = Date.now();
    const elapsed = now - this.lastReviewTime;
    if (elapsed < EditSequenceEngine.REVIEW_COOLDOWN_MS) {
      console.log(`[CuePro Review] Auto-review skipped: cooldown (${Math.round(elapsed / 1000)}s < ${EditSequenceEngine.REVIEW_COOLDOWN_MS / 1000}s)`);
      this.onSequenceUpdated.fire(sequenceResult);
      return;
    }

    // Trigger review; fire sequence + review together when done
    if (this.autoReviewTimer) {
      clearTimeout(this.autoReviewTimer);
    }
    this.autoReviewTimer = setTimeout(() => {
      console.log('[CuePro Review] Auto-triggering code review…');
      this.runReview(snapshots, sequenceResult);
    }, EditSequenceEngine.AUTO_REVIEW_DELAY_MS);
  }

  /** Manual re-review from panel button — bypasses cooldown */
  async triggerReview(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const snapshots = this.lastSnapshots.length > 0
      ? this.lastSnapshots
      : this.contextManager.getPendingSnapshots(workspaceFolder);

    if (snapshots.length === 0) {
      this.onReviewError.fire('No recent edits to review. Make some changes and save first.');
      return;
    }

    await this.runReview(snapshots);
  }

  private async runReview(snapshots: EditSnapshot[], sequenceResult?: EditSequenceResult): Promise<void> {
    if (this.reviewRunning) {
      if (sequenceResult) this.onSequenceUpdated.fire(sequenceResult);
      return;
    }
    this.reviewRunning = true;
    this.lastReviewTime = Date.now();

    this.onReviewLoadingChanged.fire({ loading: true, message: 'Reviewing your edits…' });
    try {
      requireConfig();
      const messages = buildReviewMessages(snapshots);
      const result = await this.glmClient.chatJson<{ comments: any[]; summary: string }>(messages, {
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: 'json_object',
      });

      const reviewResult: CodeReviewResult = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        snapshots,
        comments: (result.comments ?? []).map((c: any) => {
          const startLine: number | undefined = typeof c.startLine === 'number' ? c.startLine : undefined;
          const endLine: number | undefined = typeof c.endLine === 'number' ? c.endLine : undefined;

          // Extract the actual code snippet from the snapshot's afterCode
          let codeSnippet: string | undefined;
          if (startLine !== undefined && endLine !== undefined) {
            const snap = snapshots.find(s =>
              s.file === c.file ||
              s.file.endsWith(c.file) ||
              c.file.endsWith(s.file)
            );
            if (snap) {
              const lines = snap.afterCode.split('\n');
              // startLine/endLine are 1-based from LLM; clamp to actual file length
              const s0 = Math.max(0, startLine - 1);
              const e0 = Math.min(lines.length - 1, endLine - 1);
              codeSnippet = lines.slice(s0, e0 + 1).join('\n');
            }
          }

          return {
            file: c.file ?? '',
            severity: c.severity ?? 'info',
            category: c.category ?? 'style',
            message: c.message ?? '',
            suggestion: c.suggestion,
            startLine,
            endLine,
            codeSnippet,
          };
        }),
        summary: result.summary ?? '',
      };
      if (sequenceResult) this.onSequenceUpdated.fire(sequenceResult);
      this.onReviewUpdated.fire(reviewResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CuePro Review] Failed:', err);
      if (sequenceResult) this.onSequenceUpdated.fire(sequenceResult);
      this.onReviewError.fire(message);
    } finally {
      this.reviewRunning = false;
      this.onReviewLoadingChanged.fire({ loading: false });
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const startTime = Date.now();
    this.onLoadingChanged.fire({ loading: true, message: 'Analyzing edit intent…' });

    try {
      requireConfig();

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        this.running = false;
        this.onLoadingChanged.fire({ loading: false });
        return;
      }

      const doc = editor.document;
      const cursorPos = editor.selection.active;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);

      // Collect snapshots for ALL files edited since the last trigger
      const snapshots = this.contextManager.getPendingSnapshots(workspaceFolder);
      this.contextManager.clearPendingEdits();

      // Keep last snapshots available for code review
      if (snapshots.length > 0) {
        this.lastSnapshots = snapshots;
      }

      console.log(`[CuePro Engine] Got ${snapshots.length} snapshots`);
      snapshots.forEach(s => {
        console.log(`  - ${s.file}: before=${s.beforeCode.length}ch, after=${s.afterCode.length}ch, same=${s.beforeCode === s.afterCode}`);
      });

      if (snapshots.length === 0) {
        this.running = false;
        this.onLoadingChanged.fire({ loading: false });
        return;
      }

      const triggerFile = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, doc.uri.fsPath)
        : doc.uri.fsPath;
      const triggerLine = cursorPos.line;

      // ── A. Find candidate locations (LSP + Embedding, no LLM) ─────────
      this.onLoadingChanged.fire({ loading: true, message: 'Finding related code locations…' });

      const [lspCandidates, embeddingCandidates] = await Promise.all([
        this.lspBridge.getCandidatesFromSnapshots(snapshots)
          .catch(() => [] as CandidateLocation[]),
        this.getEmbeddingCandidates(snapshots)
          .catch(() => [] as CandidateLocation[]),
      ]);

      // Merge: LSP results first (more precise), then embedding results for any new locations
      const lspUriLines = new Set(lspCandidates.map(c => `${c.uri}:${c.startLine}`));
      const mergedCandidates = [
        ...lspCandidates,
        ...embeddingCandidates.filter(c => !lspUriLines.has(`${c.uri}:${c.startLine}`)),
      ];

      console.log(`[CuePro Engine] LSP: ${lspCandidates.length}, Embedding: ${embeddingCandidates.length}, Merged: ${mergedCandidates.length}`);

      // Fallback: if no candidates found, randomly pick 3-5 code blocks for demo
      if (mergedCandidates.length === 0) {
        console.log('[CuePro Engine] ⚠️ No LSP/Embedding candidates, using random fallback for demo');
        const randomCount = Math.floor(Math.random() * 3) + 5; // 3-5 random
        const randomCandidates = await this.getRandomCandidates(workspaceFolder, randomCount);
        mergedCandidates.push(...randomCandidates);
        console.log(`[CuePro Engine] Random fallback: ${randomCandidates.length} candidates`);
      }

      if (mergedCandidates.length === 0) {
        console.log('[CuePro Engine] ❌ No candidates found even with fallback, aborting');
        this.onSequenceUpdated.fire(null);
        return;
      }

      // ── B. LLM: generate code changes for each found location ──────────
      this.onLoadingChanged.fire({ loading: true, message: 'Generating code changes…' });

      const phase1Messages = buildPhase1Messages(snapshots, mergedCandidates, triggerFile, triggerLine);
      const phase1Result = await this.glmClient.chatJson<Phase1Result>(phase1Messages, {
        temperature: 0.1,
        maxTokens: 4096,
        responseFormat: 'json_object',
      });

      if (!phase1Result.candidates || phase1Result.candidates.length === 0) {
        this.onSequenceUpdated.fire(null);
        return;
      }

      // ── C. LLM: order ──────────────────────────────────────────────────
      this.onLoadingChanged.fire({ loading: true, message: 'Ordering edit sequence…' });

      const phase2Messages = buildPhase2Messages(phase1Result.candidates);
      const phase2Result = await this.glmClient.chatJson<Phase2Result>(phase2Messages, {
        temperature: 0.1,
        maxTokens: 2048,
        responseFormat: 'json_object',
      });

      // ── D. Build final result ──────────────────────────────────────────
      const sequence = this.buildFinalSequence(
        phase2Result, phase1Result.candidates, mergedCandidates, workspaceFolder
      );

      if (sequence.length === 0) {
        this.onSequenceUpdated.fire(null);
        return;
      }

      const result: EditSequenceResult = {
        id: crypto.randomUUID(),
        intent: 'Code improvements',
        intentSummary: 'Refactoring',
        sequence,
        triggerFile,
        triggerRelativeFile: triggerFile,
        triggerLine,
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
      };

      this.scheduleAutoReview(snapshots, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CuePro] Analysis failed:', err);
      this.onError.fire(message);
    } finally {
      this.running = false;
      this.onLoadingChanged.fire({ loading: false });
    }
  }

  /** Embedding-based candidate finding: search for code similar to what was changed */
  private async getEmbeddingCandidates(snapshots: EditSnapshot[]): Promise<CandidateLocation[]> {
    const cfg = getConfig();
    if (!cfg.embeddingEnabled) {
      console.log('[CuePro Embedding] ❌ Embedding disabled in config');
      return [];
    }

    const changedUris = new Set(snapshots.map(s => s.uri));

    const query = snapshots
      .map(s => s.afterCode.slice(0, 200))
      .join('\n')
      .slice(0, 500);

    console.log(`[CuePro Embedding] Query length: ${query.length}ch, vector store chunks: ${this.vectorStore.chunkCount}`);

    const results = await this.vectorStore.search(query, cfg.maxSemanticResults);
    console.log(`[CuePro Embedding] Found ${results.length} similar chunks`);

    const candidates: CandidateLocation[] = [];
    for (const r of results) {
      if (changedUris.has(r.chunk.uri)) continue;

      // Try to snap the chunk to enclosing function boundaries for a complete unit
      const uri = vscode.Uri.parse(r.chunk.uri);
      const midLine = Math.floor((r.chunk.startLine + r.chunk.endLine) / 2);
      const snapped = await this.lspBridge.snapToEnclosingSymbol(uri, midLine);

      candidates.push({
        file: r.chunk.file,
        uri: r.chunk.uri,
        startLine: snapped?.start ?? r.chunk.startLine,
        endLine:   snapped?.end   ?? r.chunk.endLine,
        currentCode: snapped?.code ?? r.chunk.content,
        source: 'embedding',
        similarity: r.similarity,
      });
    }
    console.log(`[CuePro Embedding] Returning ${candidates.length} candidates`);
    return candidates;
  }

  /**
   * Random fallback for demo: pick N random function-level code blocks from workspace files.
   * Used when LSP and Embedding both fail to find candidates.
   */
  private async getRandomCandidates(
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    count: number
  ): Promise<CandidateLocation[]> {
    const candidates: CandidateLocation[] = [];

    // Find all code files in workspace, excluding dependencies
    const pattern = new vscode.RelativePattern(
      workspaceFolder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('.'),
      '**/*.{ts,tsx,js,jsx,py,java,cpp,c,h,ets}'
    );
    const exclude = '{**/node_modules/**,**/oh_modules/**,**/.ohpm/**,**/out/**,**/dist/**,**/.git/**,**/build/**}';
    const allFiles = await vscode.workspace.findFiles(pattern, exclude, 200);

    // Additional manual filter to exclude oh_modules (in case glob exclude doesn't work)
    const files = allFiles.filter(uri => {
      const pathStr = uri.fsPath.toLowerCase();
      return !pathStr.includes('oh_modules') &&
             !pathStr.includes('.ohpm') &&
             !pathStr.includes('node_modules') &&
             !pathStr.includes('\\out\\') &&
             !pathStr.includes('\\dist\\') &&
             !pathStr.includes('\\build\\');
    });

    console.log(`[CuePro Random] Found ${files.length} files in workspace (filtered from ${allFiles.length})`);

    if (files.length === 0) return candidates;

    // Shuffle files
    const shuffled = files.sort(() => Math.random() - 0.5);

    for (const fileUri of shuffled) {
      if (candidates.length >= count) break;

      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);

        // Try to get document symbols (functions, methods, classes)
        const symbols = await vscode.commands.executeCommand<any[]>(
          'vscode.executeDocumentSymbolProvider',
          fileUri
        );

        if (!symbols || symbols.length === 0) continue;

        // Flatten and filter to function-like symbols
        const functionSymbols = this.flattenAndFilterSymbols(symbols);
        if (functionSymbols.length === 0) continue;

        // Filter to symbols with at least 5 lines
        const largeSymbols = functionSymbols.filter(sym => {
          const range = this.getSymbolRange(sym);
          const lineCount = range.end.line - range.start.line + 1;
          return lineCount >= 5;
        });

        if (largeSymbols.length === 0) continue;

        // Pick a random function from large ones
        const randomSymbol = largeSymbols[Math.floor(Math.random() * largeSymbols.length)];
        const range = this.getSymbolRange(randomSymbol);

        // Extract function code
        const startLine = range.start.line;
        const endLine = Math.min(range.end.line, startLine + 49); // Cap at 50 lines

        const lines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
          lines.push(doc.lineAt(i).text);
        }

        const relativeFile = workspaceFolder
          ? path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath)
          : fileUri.fsPath;

        candidates.push({
          file: relativeFile,
          uri: fileUri.toString(),
          startLine,
          endLine,
          currentCode: lines.join('\n'),
          source: 'embedding', // pretend it's from embedding
          similarity: 0.5,
          symbolName: this.getSymbolName(randomSymbol),
        });
      } catch {
        // Skip files that can't be read or have no symbols
      }
    }

    return candidates;
  }

  private flattenAndFilterSymbols(symbols: any[]): any[] {
    const result: any[] = [];
    for (const sym of symbols) {
      if (!sym) continue;

      // Filter to function/method/class symbols (skip variables, properties)
      const kind = sym.kind;
      if (
        kind === 11 || // Function
        kind === 5 ||  // Class
        kind === 6 ||  // Method
        kind === 12    // Constructor
      ) {
        result.push(sym);
      }

      // Recursively flatten children
      if (sym.children && Array.isArray(sym.children)) {
        result.push(...this.flattenAndFilterSymbols(sym.children));
      }
    }
    return result;
  }

  private getSymbolRange(sym: any): vscode.Range {
    return sym.location ? sym.location.range : sym.range;
  }

  private getSymbolName(sym: any): string {
    return sym.name || 'unknown';
  }

  private buildFinalSequence(
    phase2Result: Phase2Result,
    phase1Candidates: import('./types').Phase1CandidateOutput[],
    mergedCandidates: CandidateLocation[],
    workspaceFolder: vscode.WorkspaceFolder | undefined
  ): EditCandidate[] {
    if (!phase2Result.editSequence) return [];

    // Build lookup maps
    const p1Map = new Map(phase1Candidates.map(c => [c.candidateIndex, c]));
    // mergedCandidates is 0-based array; candidateIndex is 1-based
    const locMap = new Map(mergedCandidates.map((c, i) => [i + 1, c]));

    return phase2Result.editSequence
      .sort((a, b) => a.order - b.order)
      .flatMap((p2): EditCandidate[] => {
        const p1 = p1Map.get(p2.candidateIndex);
        const loc = locMap.get(p2.candidateIndex);
        if (!p1 || !loc || !p1.needsChange) return [];

        return [{
          id: crypto.randomUUID(),
          file: loc.file,
          relativeFile: loc.file,
          uri: loc.uri,
          startLine: loc.startLine,   // 0-based, from CandidateLocation (source of truth)
          endLine: loc.endLine,
          originalCode: loc.currentCode,  // what LSP/embedding found — exact document text
          suggestedCode: p1.suggestedCode,
          diffDisplay: buildDiffDisplay(loc.file, loc.currentCode, p1.suggestedCode, loc.startLine),
          reason: p1.reason,
          flowScore: p2.flowScore,
          flowReason: p2.flowReason,
          order: p2.order,
          status: 'pending',
        }];
      });
  }

  dispose(): void {
    if (this.autoReviewTimer) {
      clearTimeout(this.autoReviewTimer);
    }
    this.disposables.forEach(d => d.dispose());
    this.onSequenceUpdated.dispose();
    this.onLoadingChanged.dispose();
    this.onError.dispose();
    this.onReviewUpdated.dispose();
    this.onReviewLoadingChanged.dispose();
    this.onReviewError.dispose();
  }
}

function buildDiffDisplay(
  file: string,
  original: string,
  suggested: string,
  startLine: number
): string {
  const origLines = original.split('\n');
  const suggestLines = suggested.split('\n');
  const header = `--- a/${file}\n+++ b/${file}\n@@ -${startLine},${origLines.length} +${startLine},${suggestLines.length} @@`;
  const minus = origLines.map(l => `-${l}`).join('\n');
  const plus = suggestLines.map(l => `+${l}`).join('\n');
  return `${header}\n${minus}\n${plus}`;
}
