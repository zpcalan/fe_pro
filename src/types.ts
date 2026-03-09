// ============================================================
// types.ts  —  Shared type definitions for Cue Pro
// ============================================================

/** A single document change captured by VS Code's text change event */
export interface EditRecord {
  /** Relative path from workspace root */
  file: string;
  /** Absolute URI string */
  uri: string;
  timestamp: number;
  startLine: number;
  endLine: number;
  /** Code BEFORE the edit (may be empty for pure insertions) */
  originalCode: string;
  /** Code AFTER the edit */
  newCode: string;
  /** Unified diff representation */
  diff: string;
  /** Symbol name at/near the edit point (if resolved via LSP) */
  symbolName?: string;
  languageId: string;
}

/**
 * A before/after snapshot of a file for use as prompt input.
 * beforeCode = full file content when editing session started (or last save).
 * afterCode  = current full file content at analysis time.
 */
export interface EditSnapshot {
  file: string;
  uri: string;
  languageId: string;
  beforeCode: string;
  afterCode: string;
}

/**
 * Code review comment for a specific file change.
 */
export interface ReviewComment {
  file: string;
  severity: 'info' | 'warning' | 'error';
  category: string;
  message: string;
  suggestion?: string;
  /** 1-based start line in the file (from LLM) */
  startLine?: number;
  /** 1-based end line in the file (from LLM) */
  endLine?: number;
  /** Actual code snippet extracted from the snapshot at those lines */
  codeSnippet?: string;
}

/**
 * Full code review result for all changed files.
 */
export interface CodeReviewResult {
  id: string;
  timestamp: number;
  snapshots: EditSnapshot[];
  comments: ReviewComment[];
  summary: string;
}

/**
 * A candidate location found by LSP references or embedding similarity.
 * The "where to change" is determined programmatically, not by the LLM.
 */
export interface CandidateLocation {
  file: string;
  uri: string;
  startLine: number;
  endLine: number;
  /** Actual current code at this location (read from the document) */
  currentCode: string;
  /** How this location was found */
  source: 'lsp' | 'embedding';
  symbolName?: string;
  similarity?: number;
}

/** A code location retrieved via LSP (reference, definition, etc.) */
export interface LspLocation {
  file: string;
  uri: string;
  startLine: number;
  endLine: number;
  /** Surrounding code context (±N lines) */
  codeContext: string;
  /** How this location relates to the trigger symbol */
  relation: 'definition' | 'reference' | 'implementation' | 'call';
  symbolName: string;
}

/** A code chunk indexed in the vector store */
export interface VectorChunk {
  id: string;
  file: string;
  uri: string;
  startLine: number;
  endLine: number;
  content: string;
  vector: number[];
  lastModified: number;
}

/** Result of a semantic similarity search */
export interface SemanticSearchResult {
  chunk: VectorChunk;
  similarity: number;
}

/**
 * Phase 1 LLM output per candidate.
 * The LLM only outputs suggestedCode keyed by candidateIndex.
 * Line numbers come from the original CandidateLocation, NOT from the LLM.
 */
export interface Phase1CandidateOutput {
  /** 1-based index matching "Candidate N" in the prompt */
  candidateIndex: number;
  suggestedCode: string;
  reason: string;
  needsChange: boolean;
}

/** Phase 1 LLM output */
export interface Phase1Result {
  intent: string;
  intentSummary: string;
  candidates: Phase1CandidateOutput[];
}

/**
 * Phase 2 LLM output per candidate: ordering + flow score only.
 * Does NOT repeat code — references candidates by index.
 */
export interface Phase2CandidateOutput {
  candidateIndex: number;
  order: number;
  flowScore: number;
  flowReason: string;
}

/** Phase 2 LLM output */
export interface Phase2Result {
  editSequence: Phase2CandidateOutput[];
}

/** Final edit candidate shown to the user */
export interface EditCandidate {
  id: string;
  file: string;
  /** Relative path for display */
  relativeFile: string;
  uri: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  suggestedCode: string;
  /** Unified diff for display */
  diffDisplay: string;
  reason: string;
  flowScore: number;
  flowReason: string;
  order: number;
  status: 'pending' | 'accepted' | 'rejected' | 'skipped';
}

/** The full result of an analysis run */
export interface EditSequenceResult {
  id: string;
  intent: string;
  intentSummary: string;
  sequence: EditCandidate[];
  triggerFile: string;
  triggerRelativeFile: string;
  triggerLine: number;
  timestamp: number;
  /** Duration of the full analysis pipeline in ms */
  durationMs: number;
}

/** Messages sent from the extension to the WebView */
export type WebviewMessage =
  | { type: 'updateSequence'; data: EditSequenceResult | null }
  | { type: 'updateCandidateStatus'; id: string; status: EditCandidate['status'] }
  | { type: 'setActiveCandidateId'; id: string | null }
  | { type: 'setLoading'; loading: boolean; message?: string }
  | { type: 'setError'; message: string }
  | { type: 'indexingProgress'; indexed: number; total: number }
  | { type: 'updateReview'; data: CodeReviewResult | null }
  | { type: 'setReviewLoading'; loading: boolean; message?: string }
  | { type: 'setReviewError'; message: string };

/** Messages sent from the WebView to the extension */
export type ExtensionMessage =
  | { type: 'navigateTo'; candidateId: string }
  | { type: 'acceptCandidate'; candidateId: string }
  | { type: 'rejectCandidate'; candidateId: string }
  | { type: 'triggerAnalysis' }
  | { type: 'indexWorkspace' }
  | { type: 'clearSequence' }
  | { type: 'triggerReview' }
  | { type: 'navigateToReview'; file: string; startLine: number };

/** GLM / OpenAI-compatible chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** GLM / OpenAI-compatible chat completion response */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** OpenAI-compatible embedding request/response */
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
