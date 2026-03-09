// ============================================================
// panel/editSequencePanel.ts  —  Sidebar WebView panel
// Shows the predicted edit sequence and code review tabs
// ============================================================

import * as vscode from 'vscode';
import { EditSequenceResult, WebviewMessage, ExtensionMessage, CodeReviewResult } from '../types';

export class EditSequencePanel implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'cuePro.sequencePanel';

  private view?: vscode.WebviewView;
  private currentResult: EditSequenceResult | null = null;
  private currentReview: CodeReviewResult | null = null;

  // Callbacks set by the extension
  onNavigateTo?: (candidateId: string) => void;
  onAcceptCandidate?: (candidateId: string) => void;
  onRejectCandidate?: (candidateId: string) => void;
  onTriggerAnalysis?: () => void;
  onIndexWorkspace?: () => void;
  onClearSequence?: () => void;
  onTriggerReview?: () => void;
  onNavigateToReview?: (file: string, startLine: number) => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'panel', 'webview')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: ExtensionMessage) => {
      switch (msg.type) {
        case 'navigateTo':
          this.onNavigateTo?.(msg.candidateId);
          break;
        case 'acceptCandidate':
          this.onAcceptCandidate?.(msg.candidateId);
          break;
        case 'rejectCandidate':
          this.onRejectCandidate?.(msg.candidateId);
          break;
        case 'triggerAnalysis':
          this.onTriggerAnalysis?.();
          break;
        case 'indexWorkspace':
          this.onIndexWorkspace?.();
          break;
        case 'clearSequence':
          this.onClearSequence?.();
          break;
        case 'triggerReview':
          this.onTriggerReview?.();
          break;
        case 'navigateToReview':
          this.onNavigateToReview?.(msg.file, msg.startLine);
          break;
      }
    });

    // Send current state if we have one
    if (this.currentResult) {
      this.postMessage({ type: 'updateSequence', data: this.currentResult });
    }
    if (this.currentReview) {
      this.postMessage({ type: 'updateReview', data: this.currentReview });
    }
  }

  updateSequence(result: EditSequenceResult | null): void {
    this.currentResult = result;
    this.postMessage({ type: 'updateSequence', data: result });
  }

  updateCandidateStatus(id: string, status: 'pending' | 'accepted' | 'rejected' | 'skipped'): void {
    this.postMessage({ type: 'updateCandidateStatus', id, status });
  }

  setActiveCandidateId(id: string | null): void {
    this.postMessage({ type: 'setActiveCandidateId', id });
  }

  setLoading(loading: boolean, message?: string): void {
    this.postMessage({ type: 'setLoading', loading, message });
  }

  setError(message: string): void {
    this.postMessage({ type: 'setError', message });
  }

  setIndexingProgress(indexed: number, total: number): void {
    this.postMessage({ type: 'indexingProgress', indexed, total });
  }

  updateReview(result: CodeReviewResult | null): void {
    this.currentReview = result;
    this.postMessage({ type: 'updateReview', data: result });
  }

  setReviewLoading(loading: boolean, message?: string): void {
    this.postMessage({ type: 'setReviewLoading', loading, message });
  }

  setReviewError(message: string): void {
    this.postMessage({ type: 'setReviewError', message });
  }

  private postMessage(msg: WebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Cue Pro</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* ── Header ── */
  .header {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    background: var(--vscode-sideBarSectionHeader-background);
    flex-shrink: 0;
  }
  .header-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-sideBarSectionHeader-foreground);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .header-actions {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .btn {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 3px;
    border: 1px solid var(--vscode-button-border, transparent);
    cursor: pointer;
    font-family: inherit;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-icon {
    background: transparent;
    color: var(--vscode-icon-foreground);
    border: none;
    padding: 3px 4px;
    font-size: 14px;
  }
  .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); border-radius: 3px; }

  /* ── Tabs ── */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
  }
  .tab {
    padding: 6px 14px;
    font-size: 11px;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border-bottom: 2px solid transparent;
    font-family: inherit;
    transition: color 0.1s;
  }
  .tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
    font-weight: 600;
  }
  .tab-badge {
    display: inline-block;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 5px;
    font-size: 9px;
    margin-left: 4px;
    vertical-align: middle;
    line-height: 14px;
  }

  /* ── Tab content ── */
  .tab-content { display: none; flex: 1; overflow: auto; }
  .tab-content.active { display: flex; flex-direction: column; }

  /* ── Status bar ── */
  .status-bar {
    padding: 6px 12px;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .status-loading { color: var(--vscode-notificationsInfoIcon-foreground); }
  .status-error { color: var(--vscode-notificationsErrorIcon-foreground); }
  .spinner {
    display: inline-block;
    width: 10px; height: 10px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Empty state ── */
  .empty-state {
    padding: 24px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }
  .empty-state .icon { font-size: 32px; margin-bottom: 8px; }
  .empty-state p { font-size: 12px; line-height: 1.5; margin-bottom: 12px; }

  /* ── Intent banner ── */
  .intent-banner {
    margin: 8px 10px;
    padding: 8px 10px;
    border-radius: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    border-left: 3px solid var(--vscode-focusBorder);
    flex-shrink: 0;
  }
  .intent-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
    margin-bottom: 3px;
  }
  .intent-text { font-weight: 500; }
  .intent-meta { font-size: 10px; opacity: 0.7; margin-top: 4px; }

  /* ── DAG / Sequence list ── */
  .sequence-list { padding: 4px 0 16px; }
  .sequence-connector {
    margin-left: 22px;
    width: 2px;
    height: 12px;
    background: var(--vscode-editorWidget-border);
  }

  /* ── Node card ── */
  .node-card {
    margin: 0 8px;
    border-radius: 5px;
    border: 1px solid var(--vscode-editorWidget-border);
    background: var(--vscode-editor-background);
    transition: border-color 0.15s;
    overflow: hidden;
  }
  .node-card.active {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
  }
  .node-card.accepted { opacity: 0.5; }
  .node-card.rejected { opacity: 0.3; }

  .node-header {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    gap: 6px;
    cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .node-header:hover { background: var(--vscode-list-hoverBackground); }
  .node-order {
    width: 18px; height: 18px;
    border-radius: 50%;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 10px;
    font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .node-card.active .node-order {
    background: var(--vscode-focusBorder);
    color: white;
  }
  .node-file {
    flex: 1;
    min-width: 0;
    font-size: 11px;
  }
  .node-filename {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-line { font-size: 10px; color: var(--vscode-descriptionForeground); }

  .node-status { font-size: 12px; flex-shrink: 0; }
  .status-pending { color: var(--vscode-editorWarning-foreground); }
  .status-accepted { color: var(--vscode-testing-iconPassed); }
  .status-rejected { color: var(--vscode-testing-iconFailed); }

  .flow-score-bar {
    height: 2px;
    background: var(--vscode-progressBar-background);
    opacity: 0.5;
  }

  .node-body { padding: 6px 8px 8px; display: none; }
  .node-card.expanded .node-body { display: block; }
  .node-card.expanded .node-header { border-bottom-color: var(--vscode-editorWidget-border); }

  .node-reason {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    line-height: 1.4;
  }

  /* Diff display */
  .diff-block {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 8px;
    border: 1px solid var(--vscode-editorWidget-border);
  }
  .diff-line { padding: 1px 6px; white-space: pre-wrap; word-break: break-all; }
  .diff-line.added { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.1)); color: var(--vscode-gitDecoration-addedResourceForeground); }
  .diff-line.removed { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1)); color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .diff-line.header { color: var(--vscode-descriptionForeground); background: var(--vscode-sideBarSectionHeader-background); }

  .node-actions { display: flex; gap: 6px; }
  .btn-accept {
    background: var(--vscode-testing-iconPassed);
    color: white;
    border: none;
    padding: 3px 10px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-accept:hover { opacity: 0.85; }
  .btn-reject {
    background: transparent;
    color: var(--vscode-testing-iconFailed);
    border: 1px solid var(--vscode-testing-iconFailed);
    padding: 3px 10px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-reject:hover { background: var(--vscode-testing-iconFailed); color: white; }

  /* ── Footer stats ── */
  .footer {
    padding: 8px 12px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
    display: flex;
    justify-content: space-between;
    flex-shrink: 0;
  }

  /* ── Indexing progress ── */
  .indexing-bar {
    margin: 4px 12px;
    height: 3px;
    background: var(--vscode-editorWidget-border);
    border-radius: 2px;
    overflow: hidden;
    display: none;
    flex-shrink: 0;
  }
  .indexing-bar.visible { display: block; }
  .indexing-fill {
    height: 100%;
    background: var(--vscode-progressBar-background);
    transition: width 0.3s;
    width: 0%;
  }

  /* ── Review tab ── */
  .review-toolbar {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    flex-shrink: 0;
  }
  .review-list { padding: 8px 0 16px; flex: 1; overflow: auto; }

  .review-comment {
    margin: 0 8px 6px;
    border-radius: 4px;
    border: 1px solid var(--vscode-editorWidget-border);
    background: var(--vscode-editor-background);
    overflow: hidden;
  }
  .review-comment-header {
    display: flex;
    align-items: center;
    padding: 5px 8px;
    gap: 6px;
    cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .review-comment-header:hover { background: var(--vscode-list-hoverBackground); }
  .review-comment.expanded .review-comment-header { border-bottom-color: var(--vscode-editorWidget-border); }

  .severity-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .severity-error .severity-dot { background: var(--vscode-notificationsErrorIcon-foreground, #f44); }
  .severity-warning .severity-dot { background: var(--vscode-notificationsWarningIcon-foreground, #fa0); }
  .severity-info .severity-dot { background: var(--vscode-notificationsInfoIcon-foreground, #4af); }

  .review-comment-meta {
    flex: 1;
    min-width: 0;
    font-size: 11px;
  }
  .review-comment-file {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .review-comment-location {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }
  .review-comment-category {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    text-transform: capitalize;
  }

  .review-comment-body { padding: 6px 8px 8px; }
  .review-comment-message {
    font-size: 11px;
    line-height: 1.5;
    margin-bottom: 6px;
  }
  .review-comment-suggestion {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px;
    border-left: 2px solid var(--vscode-focusBorder);
    margin-top: 4px;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .review-comment-suggestion::before {
    content: "💡 ";
    font-size: 10px;
  }

  /* Code snippet inside review comment */
  .review-snippet {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 3px;
    padding: 4px 6px;
    white-space: pre;
    overflow-x: auto;
    margin-bottom: 6px;
    max-height: 120px;
    overflow-y: auto;
    line-height: 1.4;
  }

  .review-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .btn-goto {
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-textLink-foreground);
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 10px;
    cursor: pointer;
    font-family: inherit;
  }
  .btn-goto:hover { background: var(--vscode-textLink-foreground); color: white; }

  .review-summary {
    margin: 8px 8px 0;
    padding: 8px 10px;
    border-radius: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    border-left: 3px solid var(--vscode-focusBorder);
    line-height: 1.5;
    flex-shrink: 0;
  }
  .review-summary-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
    margin-bottom: 3px;
  }

  .severity-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 8px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .severity-error .severity-badge { background: var(--vscode-notificationsErrorIcon-foreground, #f44); color: white; }
  .severity-warning .severity-badge { background: var(--vscode-notificationsWarningIcon-foreground, #fa0); color: white; }
  .severity-info .severity-badge { background: var(--vscode-notificationsInfoIcon-foreground, #4af); color: white; }
</style>
</head>
<body>

<div class="header">
  <div class="header-title">◈ Cue Pro</div>
  <div class="header-actions">
    <button class="btn btn-primary" onclick="triggerAnalysis()">Analyze</button>
    <button class="btn btn-secondary" onclick="indexWorkspace()">Index</button>
    <button class="btn btn-icon" title="Clear sequence" onclick="clearSequence()">✕</button>
  </div>
</div>

<div id="indexing-bar" class="indexing-bar">
  <div id="indexing-fill" class="indexing-fill"></div>
</div>

<!-- ── Tab bar ─────────────────────────────── -->
<div class="tab-bar">
  <button class="tab active" id="tab-predictions" onclick="switchTab('predictions')">
    Predictions<span id="pred-badge" class="tab-badge" style="display:none"></span>
  </button>
  <button class="tab" id="tab-review" onclick="switchTab('review')">
    Code Review<span id="review-badge" class="tab-badge" style="display:none"></span>
  </button>
</div>

<!-- ── Predictions tab ─────────────────────── -->
<div class="tab-content active" id="content-predictions">
  <div id="status-bar" class="status-bar" style="display:none">
    <span id="status-icon" class="spinner"></span>
    <span id="status-text"></span>
  </div>
  <div id="empty-state" class="empty-state">
    <div class="icon">◈</div>
    <p>No edit sequence yet.<br>Start editing and Cue Pro will predict related changes across your repository.</p>
    <button class="btn btn-primary" onclick="triggerAnalysis()">Analyze Now</button>
  </div>
  <div id="sequence-view" style="display:none; flex-direction: column; flex: 1;">
    <div id="intent-banner" class="intent-banner">
      <div class="intent-label">Intent</div>
      <div id="intent-text" class="intent-text"></div>
      <div id="intent-meta" class="intent-meta"></div>
    </div>
    <div id="sequence-list" class="sequence-list"></div>
    <div id="footer" class="footer">
      <span id="footer-stats"></span>
      <span id="footer-time"></span>
    </div>
  </div>
</div>

<!-- ── Code Review tab ────────────────────── -->
<div class="tab-content" id="content-review">
  <div id="review-status-bar" class="status-bar" style="display:none">
    <span id="review-status-icon" class="spinner"></span>
    <span id="review-status-text"></span>
  </div>
  <div id="review-empty" class="empty-state">
    <div class="icon">🔍</div>
    <p>Review will appear automatically after each analysis run.<br>Changes must have ≥ 5 lines modified with a 60 s cooldown between reviews.</p>
    <button class="btn btn-secondary" onclick="triggerReview()">Review Now</button>
  </div>
  <div id="review-view" style="display:none; flex-direction: column; flex: 1;">
    <div class="review-toolbar">
      <button class="btn btn-primary" onclick="triggerReview()">↻ Re-review</button>
    </div>
    <div id="review-summary" class="review-summary" style="display:none">
      <div class="review-summary-label">Summary</div>
      <div id="review-summary-text"></div>
    </div>
    <div id="review-list" class="review-list"></div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// ── State ────────────────────────────────────────────────────
let currentResult = null;
let currentReview = null;
let activeId = null;
let expandedIds = new Set();
let expandedReviewIds = new Set();
let currentTab = 'predictions';

// ── Tab switching ─────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('content-' + tab).classList.add('active');
}

// ── Message handling ─────────────────────────────────────────
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'updateSequence':
      currentResult = msg.data;
      activeId = null;
      if (currentResult && currentResult.sequence.length > 0) {
        expandedIds = new Set([currentResult.sequence[0].id]);
      }
      renderPredictions();
      updatePredBadge();
      break;
    case 'updateCandidateStatus':
      if (currentResult) {
        const c = currentResult.sequence.find(c => c.id === msg.id);
        if (c) { c.status = msg.status; renderSequence(); }
      }
      break;
    case 'setActiveCandidateId':
      activeId = msg.id;
      if (msg.id) expandedIds.add(msg.id);
      renderSequence();
      break;
    case 'setLoading':
      setStatus(msg.loading, msg.message || '');
      break;
    case 'setError':
      showError(msg.message);
      break;
    case 'indexingProgress':
      updateIndexingBar(msg.indexed, msg.total);
      break;
    case 'updateReview':
      currentReview = msg.data;
      renderReview();
      updateReviewBadge();
      break;
    case 'setReviewLoading':
      setReviewStatus(msg.loading, msg.message || '');
      break;
    case 'setReviewError':
      showReviewError(msg.message);
      break;
  }
});

// ── Badge helpers ─────────────────────────────────────────────
function updatePredBadge() {
  const badge = document.getElementById('pred-badge');
  if (currentResult && currentResult.sequence.length > 0) {
    badge.textContent = currentResult.sequence.length;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}
function updateReviewBadge() {
  const badge = document.getElementById('review-badge');
  if (currentReview && currentReview.comments.length > 0) {
    const errors = currentReview.comments.filter(c => c.severity === 'error').length;
    const warnings = currentReview.comments.filter(c => c.severity === 'warning').length;
    badge.textContent = errors > 0 ? errors + ' err' : warnings > 0 ? warnings + ' warn' : currentReview.comments.length;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ── Predictions rendering ─────────────────────────────────────
function renderPredictions() {
  hideStatus();
  clearError();
  const emptyState = document.getElementById('empty-state');
  const seqView = document.getElementById('sequence-view');

  if (!currentResult || currentResult.sequence.length === 0) {
    emptyState.style.display = '';
    seqView.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  seqView.style.display = 'flex';

  document.getElementById('intent-text').textContent = currentResult.intent;
  const pending = currentResult.sequence.filter(c => c.status === 'pending').length;
  const total = currentResult.sequence.length;
  document.getElementById('intent-meta').textContent =
    \`\${pending} pending · \${total} total · \${currentResult.durationMs}ms\`;

  renderSequence();

  const accepted = currentResult.sequence.filter(c => c.status === 'accepted').length;
  document.getElementById('footer-stats').textContent = \`\${accepted}/\${total} accepted\`;
  document.getElementById('footer-time').textContent = new Date(currentResult.timestamp).toLocaleTimeString();
}

function renderSequence() {
  if (!currentResult) return;
  const list = document.getElementById('sequence-list');
  list.innerHTML = '';
  currentResult.sequence.forEach((c, idx) => {
    if (idx > 0) {
      const connector = document.createElement('div');
      connector.className = 'sequence-connector';
      list.appendChild(connector);
    }
    list.appendChild(buildNodeCard(c));
  });
  const pending = currentResult.sequence.filter(c => c.status === 'pending').length;
  const accepted = currentResult.sequence.filter(c => c.status === 'accepted').length;
  const total = currentResult.sequence.length;
  document.getElementById('footer-stats').textContent =
    \`\${accepted}/\${total} accepted · \${pending} pending\`;
}

function buildNodeCard(c) {
  const isActive = c.id === activeId;
  const isExpanded = expandedIds.has(c.id);
  const card = document.createElement('div');
  card.className = \`node-card \${c.status} \${isActive ? 'active' : ''} \${isExpanded ? 'expanded' : ''}\`;
  card.id = \`node-\${c.id}\`;

  const filename = c.relativeFile.split(/[\\\\/]/).pop() || c.relativeFile;
  const dir = c.relativeFile.includes('/') || c.relativeFile.includes('\\\\')
    ? c.relativeFile.substring(0, Math.max(c.relativeFile.lastIndexOf('/'), c.relativeFile.lastIndexOf('\\\\')) + 1)
    : '';

  const statusIcon = {
    pending: '<span class="status-pending">◈</span>',
    accepted: '<span class="status-accepted">✓</span>',
    rejected: '<span class="status-rejected">✕</span>',
    skipped: '<span>—</span>',
  }[c.status] || '';

  const scoreWidth = Math.round(c.flowScore * 100);

  card.innerHTML = \`
    <div class="node-header" onclick="toggleCard('\${c.id}', event)">
      <div class="node-order">\${c.order}</div>
      <div class="node-file">
        <div class="node-filename" title="\${c.relativeFile}">\${escHtml(filename)}</div>
        <div class="node-line">\${escHtml(dir)}line \${c.startLine + 1}</div>
      </div>
      <div class="node-status">\${statusIcon}</div>
    </div>
    <div class="flow-score-bar"><div style="height:100%;width:\${scoreWidth}%;background:var(--vscode-progressBar-background)"></div></div>
    <div class="node-body">
      <div class="node-reason">\${escHtml(c.reason)}</div>
      \${buildDiffHtml(c)}
      \${c.status === 'pending' ? \`
      <div class="node-actions">
        <button class="btn-accept" onclick="acceptCandidate('\${c.id}')">✓ Apply</button>
        <button class="btn-reject" onclick="rejectCandidate('\${c.id}')">✕ Skip</button>
        <button class="btn btn-secondary" style="font-size:10px;padding:2px 8px" onclick="navigateTo('\${c.id}')">Go to →</button>
      </div>\` : ''}
    </div>
  \`;
  return card;
}

function buildDiffHtml(c) {
  if (!c.originalCode && !c.suggestedCode) return '';
  const origLines = (c.originalCode || '').split('\\n');
  const newLines = (c.suggestedCode || '').split('\\n');
  let html = '<div class="diff-block">';
  origLines.forEach(l => { html += \`<div class="diff-line removed">-\${escHtml(l)}</div>\`; });
  newLines.forEach(l => { html += \`<div class="diff-line added">+\${escHtml(l)}</div>\`; });
  html += '</div>';
  return html;
}

function toggleCard(id, event) {
  if (event.target.tagName === 'BUTTON') return;
  if (expandedIds.has(id)) {
    expandedIds.delete(id);
  } else {
    expandedIds.add(id);
    vscode.postMessage({ type: 'navigateTo', candidateId: id });
  }
  renderSequence();
}

// ── Review rendering ─────────────────────────────────────────
function renderReview() {
  const emptyEl = document.getElementById('review-empty');
  const viewEl = document.getElementById('review-view');
  const listEl = document.getElementById('review-list');
  const summaryEl = document.getElementById('review-summary');
  const summaryText = document.getElementById('review-summary-text');

  if (!currentReview) {
    emptyEl.style.display = '';
    viewEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  viewEl.style.display = 'flex';

  // Summary
  if (currentReview.summary) {
    summaryEl.style.display = '';
    summaryText.textContent = currentReview.summary;
  } else {
    summaryEl.style.display = 'none';
  }

  // Comments grouped by severity order: error > warning > info
  const sorted = [...currentReview.comments].sort((a, b) => {
    const order = { error: 0, warning: 1, info: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });

  listEl.innerHTML = '';

  if (sorted.length === 0) {
    listEl.innerHTML = '<div class="empty-state"><div class="icon">✅</div><p>No issues found. Your changes look good!</p></div>';
    return;
  }

  sorted.forEach((comment, idx) => {
    listEl.appendChild(buildReviewCard(comment, idx));
  });
}

function buildReviewCard(comment, idx) {
  const id = 'rv-' + idx;
  const severityClass = 'severity-' + comment.severity;

  const card = document.createElement('div');
  card.className = \`review-comment \${severityClass} \${expandedReviewIds.has(id) ? 'expanded' : ''}\`;
  card.id = id;

  const filename = (comment.file || '').split(/[\\\\/]/).pop() || comment.file || 'unknown';
  const hasLocation = comment.startLine != null;
  const locationText = hasLocation
    ? \`line \${comment.startLine}\${comment.endLine && comment.endLine !== comment.startLine ? '–' + comment.endLine : ''}\`
    : '';

  const snippetHtml = comment.codeSnippet
    ? \`<div class="review-snippet">\${escHtml(comment.codeSnippet)}</div>\`
    : '';

  card.innerHTML = \`
    <div class="review-comment-header">
      <span class="severity-dot"></span>
      <div class="review-comment-meta">
        <div class="review-comment-file" title="\${escHtml(comment.file)}">\${escHtml(filename)}</div>
        <div class="review-comment-location">\${locationText ? locationText + ' · ' : ''}<span class="review-comment-category">\${escHtml(comment.category || '')}</span></div>
      </div>
      <span class="severity-badge">\${escHtml(comment.severity)}</span>
    </div>
    <div class="review-comment-body">
      <div class="review-comment-message">\${escHtml(comment.message)}</div>
      \${snippetHtml}
      \${comment.suggestion ? \`<div class="review-comment-suggestion">\${escHtml(comment.suggestion)}</div>\` : ''}
      \${hasLocation ? '<div class="review-actions"><button class="btn-goto js-goto">↗ Go to line ' + comment.startLine + '</button></div>' : ''}
    </div>
  \`;

  // Toggle expand/collapse on header click
  card.querySelector('.review-comment-header').addEventListener('click', () => toggleReviewCard(id));

  // Attach goto handler via closure — avoids path backslash escaping issues in onclick strings
  if (hasLocation) {
    const btn = card.querySelector('.js-goto');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'navigateToReview', file: comment.file, startLine: comment.startLine });
      });
    }
  }

  // Auto-expand errors
  if (comment.severity === 'error') {
    expandedReviewIds.add(id);
    card.classList.add('expanded');
  }

  return card;
}

function toggleReviewCard(id) {
  if (expandedReviewIds.has(id)) {
    expandedReviewIds.delete(id);
  } else {
    expandedReviewIds.add(id);
  }
  const card = document.getElementById(id);
  if (card) card.classList.toggle('expanded', expandedReviewIds.has(id));
}

// ── Actions ──────────────────────────────────────────────────
function navigateTo(id) { vscode.postMessage({ type: 'navigateTo', candidateId: id }); }
function navigateToReview(file, startLine) { vscode.postMessage({ type: 'navigateToReview', file, startLine }); }
function acceptCandidate(id) { vscode.postMessage({ type: 'acceptCandidate', candidateId: id }); }
function rejectCandidate(id) { vscode.postMessage({ type: 'rejectCandidate', candidateId: id }); }
function triggerAnalysis() { vscode.postMessage({ type: 'triggerAnalysis' }); }
function indexWorkspace() { vscode.postMessage({ type: 'indexWorkspace' }); }
function clearSequence() { currentResult = null; renderPredictions(); vscode.postMessage({ type: 'clearSequence' }); }
function triggerReview() {
  switchTab('review');
  setReviewStatus(true, 'Reviewing your edits…');
  vscode.postMessage({ type: 'triggerReview' });
}

// ── Status helpers ───────────────────────────────────────────
function setStatus(loading, message) {
  const bar = document.getElementById('status-bar');
  if (loading) {
    bar.style.display = 'flex';
    bar.className = 'status-bar status-loading';
    document.getElementById('status-icon').className = 'spinner';
    document.getElementById('status-text').textContent = message;
  } else {
    bar.style.display = 'none';
  }
}
function hideStatus() { document.getElementById('status-bar').style.display = 'none'; }
function showError(message) {
  const bar = document.getElementById('status-bar');
  bar.style.display = 'flex';
  bar.className = 'status-bar status-error';
  document.getElementById('status-icon').textContent = '⚠';
  document.getElementById('status-icon').className = '';
  document.getElementById('status-text').textContent = message;
}
function clearError() {
  const bar = document.getElementById('status-bar');
  if (bar.className.includes('status-error')) bar.style.display = 'none';
}

function setReviewStatus(loading, message) {
  const bar = document.getElementById('review-status-bar');
  if (loading) {
    bar.style.display = 'flex';
    bar.className = 'status-bar status-loading';
    document.getElementById('review-status-icon').className = 'spinner';
    document.getElementById('review-status-text').textContent = message;
  } else {
    bar.style.display = 'none';
  }
}
function showReviewError(message) {
  const bar = document.getElementById('review-status-bar');
  bar.style.display = 'flex';
  bar.className = 'status-bar status-error';
  document.getElementById('review-status-icon').textContent = '⚠';
  document.getElementById('review-status-icon').className = '';
  document.getElementById('review-status-text').textContent = message;
}

function updateIndexingBar(indexed, total) {
  const bar = document.getElementById('indexing-bar');
  const fill = document.getElementById('indexing-fill');
  if (indexed >= total) { bar.classList.remove('visible'); return; }
  bar.classList.add('visible');
  fill.style.width = \`\${Math.round((indexed / total) * 100)}%\`;
}

// ── Utils ────────────────────────────────────────────────────
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
  }
}
