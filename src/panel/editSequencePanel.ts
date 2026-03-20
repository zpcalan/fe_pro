// ============================================================
// panel/editSequencePanel.ts  —  Sidebar WebView panel
// Shows a unified, priority-sorted list of predicted edits + code review issues
// Sorting scheme A: error → high-flow(≥0.8) → warning → mid-flow(0.5~0.8) → info → low-flow → completed
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

  /* ── Status bar ── */
  .status-bar {
    padding: 5px 12px;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .status-bar + .status-bar {
    padding-top: 0;
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
    margin: 8px 10px 4px;
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

  /* ── Unified list ── */
  .unified-list { padding: 4px 0 16px; flex: 1; overflow: auto; }

  /* ── Slot separator (Completed divider) ── */
  .slot-separator {
    margin: 12px 10px 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .slot-separator::before, .slot-separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--vscode-editorWidget-border);
    opacity: 0.5;
  }

  /* ── Prediction node card ── */
  .node-card {
    margin: 0 8px 2px;
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
  .node-filename {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-info {
    flex: 1;
    min-width: 0;
  }
  .node-desc {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
  }
  .review-comment-info {
    flex: 1;
    min-width: 0;
  }
  .review-comment-desc {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
  }

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

  /* ── Review comment card ── */
  .review-comment {
    margin: 0 8px 2px;
    border-radius: 4px;
    border: 1px solid var(--vscode-editorWidget-border);
    background: var(--vscode-editor-background);
    overflow: hidden;
  }
  .review-comment-header {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    gap: 6px;
    cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .review-comment-header:hover { background: var(--vscode-list-hoverBackground); }
  .review-comment.expanded .review-comment-header { border-bottom-color: var(--vscode-editorWidget-border); }

  .review-chevron {
    font-size: 14px;
    color: var(--vscode-descriptionForeground);
    transition: transform 0.15s;
    flex-shrink: 0;
    line-height: 1;
  }
  .review-comment.expanded .review-chevron { transform: rotate(90deg); }

  .severity-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .severity-error .severity-dot { background: var(--vscode-notificationsErrorIcon-foreground, #f44); }
  .severity-warning .severity-dot { background: var(--vscode-notificationsWarningIcon-foreground, #fa0); }
  .severity-info .severity-dot { background: var(--vscode-notificationsInfoIcon-foreground, #4af); }

  .review-comment-file {
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .review-comment-body { padding: 6px 8px 8px; display: none; }
  .review-comment.expanded .review-comment-body { display: block; }
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
  .review-comment-suggestion::before { content: "💡 "; font-size: 10px; }

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

  .review-actions { display: flex; gap: 6px; align-items: center; }
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
</style>
</head>
<body>

<div class="header">
  <div class="header-title">◈ Cue Pro</div>
  <div class="header-actions">
    <button class="btn btn-icon" title="Clear all" onclick="clearAll()">✕</button>
  </div>
</div>

<div id="indexing-label" style="display:none;padding:4px 12px 2px;font-size:11px;color:var(--vscode-descriptionForeground)">
  <span class="spinner" style="width:8px;height:8px;border-width:1.5px;margin-right:5px;vertical-align:middle"></span>正在构建代码向量数据库…
</div>
<div id="indexing-bar" class="indexing-bar">
  <div id="indexing-fill" class="indexing-fill"></div>
</div>

<div id="status-bar" class="status-bar" style="display:none">
  <span id="status-icon" class="spinner"></span>
  <span id="status-text"></span>
</div>
<div id="review-status-bar" class="status-bar" style="display:none">
  <span id="review-status-icon" class="spinner"></span>
  <span id="review-status-text"></span>
</div>

<div id="intent-banner" class="intent-banner" style="display:none">
  <div class="intent-label">Intent</div>
  <div id="intent-text" class="intent-text"></div>
  <div id="intent-meta" class="intent-meta"></div>
</div>

<div id="empty-state" class="empty-state">
  <div class="icon">◈</div>
  <p>Start editing. Cue Pro will predict related changes and review your code automatically.</p>
</div>

<div id="unified-list" class="unified-list" style="display:none"></div>

<div id="footer" class="footer" style="display:none">
  <span id="footer-stats"></span>
  <span id="footer-time"></span>
</div>

<script>
const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────
let currentResult = null;
let currentReview = null;
let activeId = null;
let expandedIds = new Set();
let expandedReviewIds = new Set();

// ── Message handling ───────────────────────────────────────────
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'updateSequence':
      currentResult = msg.data;
      activeId = null;
      expandedIds = new Set();
      renderUnified();
      break;
    case 'updateCandidateStatus':
      if (currentResult) {
        const c = currentResult.sequence.find(c => c.id === msg.id);
        if (c) { c.status = msg.status; renderUnified(); }
      }
      break;
    case 'setActiveCandidateId':
      activeId = msg.id;
      if (msg.id) expandedIds.add(msg.id);
      renderUnified();
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
      renderUnified();
      break;
    case 'setReviewLoading':
      setReviewStatus(msg.loading, msg.message || '');
      break;
    case 'setReviewError':
      showReviewError(msg.message);
      break;
  }
});

// ── Unified priority score ──────────────────────────────────────
// review severity → score: error=0.95, warning=0.65, info=0.35
// prediction → flowScore (0~1), completed → -1
function getItemScore(item) {
  if (item.itemType === 'review') {
    if (item.severity === 'error')   return 0.95;
    if (item.severity === 'warning') return 0.65;
    return 0.35;
  }
  if (item.status !== 'pending') return -1;
  return item.flowScore ?? 0;
}

function buildUnifiedItems() {
  const items = [];
  if (currentReview) {
    currentReview.comments.forEach((c, idx) => {
      items.push({ itemType: 'review', _reviewIdx: idx, ...c });
    });
  }
  if (currentResult) {
    currentResult.sequence.forEach(c => {
      items.push({ itemType: 'prediction', ...c });
    });
  }
  items.sort((a, b) => getItemScore(b) - getItemScore(a));
  return items;
}

// ── Main render ────────────────────────────────────────────────
function renderUnified() {
  updateIntentBanner();
  const items = buildUnifiedItems();

  const emptyState = document.getElementById('empty-state');
  const list = document.getElementById('unified-list');
  const footer = document.getElementById('footer');

  if (items.length === 0) {
    emptyState.style.display = '';
    list.style.display = 'none';
    footer.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  list.style.display = '';
  list.innerHTML = '';

  let completedSepShown = false;
  items.forEach(item => {
    const isCompleted = item.itemType === 'prediction' && item.status !== 'pending';
    if (isCompleted && !completedSepShown) {
      completedSepShown = true;
      const sep = document.createElement('div');
      sep.className = 'slot-separator';
      sep.textContent = 'Completed';
      list.appendChild(sep);
    }
    if (item.itemType === 'prediction') {
      list.appendChild(buildNodeCard(item));
    } else {
      list.appendChild(buildReviewCard(item, item._reviewIdx));
    }
  });

  // Footer stats
  const parts = [];
  if (currentResult) {
    const accepted = currentResult.sequence.filter(c => c.status === 'accepted').length;
    const pending  = currentResult.sequence.filter(c => c.status === 'pending').length;
    const total    = currentResult.sequence.length;
    parts.push(\`\${accepted}/\${total} edits accepted · \${pending} pending\`);
  }
  if (currentReview) {
    const errors   = currentReview.comments.filter(c => c.severity === 'error').length;
    const warnings = currentReview.comments.filter(c => c.severity === 'warning').length;
    if (errors > 0)   parts.push(\`\${errors} error\${errors > 1 ? 's' : ''}\`);
    if (warnings > 0) parts.push(\`\${warnings} warning\${warnings > 1 ? 's' : ''}\`);
  }
  document.getElementById('footer-stats').textContent = parts.join(' · ');
  const ts = (currentResult?.timestamp ?? currentReview?.timestamp) ?? 0;
  document.getElementById('footer-time').textContent = ts ? new Date(ts).toLocaleTimeString() : '';
  footer.style.display = '';
}

function updateIntentBanner() {
  const banner = document.getElementById('intent-banner');
  if (!currentResult || currentResult.sequence.length === 0) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = '';
  document.getElementById('intent-text').textContent = currentResult.intent;
  const pending = currentResult.sequence.filter(c => c.status === 'pending').length;
  const total   = currentResult.sequence.length;
  document.getElementById('intent-meta').textContent =
    \`\${pending} pending · \${total} total · \${currentResult.durationMs}ms\`;
}

// ── Prediction node card ───────────────────────────────────────
function buildNodeCard(c) {
  const isActive   = c.id === activeId;
  const isExpanded = expandedIds.has(c.id);
  const card = document.createElement('div');
  card.className = \`node-card \${c.status} \${isActive ? 'active' : ''} \${isExpanded ? 'expanded' : ''}\`;
  card.id = \`node-\${c.id}\`;

  const filename = c.relativeFile.split(/[\\\\/]/).pop() || c.relativeFile;
  const dir = c.relativeFile.includes('/') || c.relativeFile.includes('\\\\')
    ? c.relativeFile.substring(0, Math.max(c.relativeFile.lastIndexOf('/'), c.relativeFile.lastIndexOf('\\\\')) + 1)
    : '';

  const statusIcon = {
    pending:  '<span class="status-pending">◈</span>',
    accepted: '<span class="status-accepted">✓</span>',
    rejected: '<span class="status-rejected">✕</span>',
    skipped:  '<span>—</span>',
  }[c.status] || '';

  const scoreWidth = Math.round(c.flowScore * 100);

  card.innerHTML = \`
    <div class="node-header" onclick="toggleCard('\${c.id}', event)">
      <div class="node-order">\${c.order}</div>
      <div class="node-info">
        <div class="node-filename" title="\${c.relativeFile}">\${escHtml(filename)}:\${c.startLine + 1}</div>
        <div class="node-desc">\${escHtml(truncDesc(c.reason, 32))}</div>
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
  const newLines  = (c.suggestedCode || '').split('\\n');
  let html = '<div class="diff-block">';
  origLines.forEach(l => { html += \`<div class="diff-line removed">-\${escHtml(l)}</div>\`; });
  newLines.forEach(l  => { html += \`<div class="diff-line added">+\${escHtml(l)}</div>\`; });
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
  const card = document.getElementById(\`node-\${id}\`);
  if (card) card.classList.toggle('expanded', expandedIds.has(id));
}

// ── Review comment card ────────────────────────────────────────
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
      <div class="review-comment-info">
        <div class="review-comment-file" title="\${escHtml(comment.file)}">\${escHtml(filename)}\${hasLocation ? ':' + comment.startLine : ''}</div>
        <div class="review-comment-desc">\${escHtml(truncDesc(comment.message, 32))}</div>
      </div>
      <span class="severity-badge">\${escHtml(comment.severity)}</span>
      <span class="review-chevron">›</span>
    </div>
    <div class="review-comment-body">
      <div class="review-comment-message">\${escHtml(comment.message)}</div>
      \${snippetHtml}
      \${comment.suggestion ? \`<div class="review-comment-suggestion">\${escHtml(comment.suggestion)}</div>\` : ''}
      \${hasLocation ? '<div class="review-actions"><button class="btn-goto js-goto">↗ Go to line ' + comment.startLine + '</button></div>' : ''}
    </div>
  \`;

  card.querySelector('.review-comment-header').addEventListener('click', () => toggleReviewCard(id));

  if (hasLocation) {
    const btn = card.querySelector('.js-goto');
    if (btn) {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'navigateToReview', file: comment.file, startLine: comment.startLine });
      });
    }
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

// ── Actions ───────────────────────────────────────────────────
function navigateTo(id)        { vscode.postMessage({ type: 'navigateTo', candidateId: id }); }
function acceptCandidate(id)   { vscode.postMessage({ type: 'acceptCandidate', candidateId: id }); }
function rejectCandidate(id)   { vscode.postMessage({ type: 'rejectCandidate', candidateId: id }); }
function triggerAnalysis()     { vscode.postMessage({ type: 'triggerAnalysis' }); }
function indexWorkspace()      { vscode.postMessage({ type: 'indexWorkspace' }); }
function triggerReview()       { setReviewStatus(true, 'Reviewing your edits…'); vscode.postMessage({ type: 'triggerReview' }); }
function clearAll() {
  currentResult = null;
  currentReview = null;
  expandedIds = new Set();
  expandedReviewIds = new Set();
  renderUnified();
  vscode.postMessage({ type: 'clearSequence' });
}

// ── Status helpers ────────────────────────────────────────────
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
function showError(message) {
  const bar = document.getElementById('status-bar');
  bar.style.display = 'flex';
  bar.className = 'status-bar status-error';
  document.getElementById('status-icon').textContent = '⚠';
  document.getElementById('status-icon').className = '';
  document.getElementById('status-text').textContent = message;
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
  const bar   = document.getElementById('indexing-bar');
  const fill  = document.getElementById('indexing-fill');
  const label = document.getElementById('indexing-label');
  if (indexed >= total) {
    bar.classList.remove('visible');
    label.style.display = 'none';
    return;
  }
  label.style.display = '';
  bar.classList.add('visible');
  fill.style.width = \`\${Math.round((indexed / total) * 100)}%\`;
}

// ── Utils ─────────────────────────────────────────────────────
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncDesc(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}
</script>
</body>
</html>`;
  }
}
