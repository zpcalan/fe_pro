// ============================================================
// config.ts  —  Configuration accessor for Cue Pro settings
// ============================================================

import * as vscode from 'vscode';

const SECTION = 'cuePro';

export interface CueProConfig {
  // GLM
  glmApiUrl: string;
  glmApiKey: string;
  glmModel: string;

  // Embedding
  embeddingApiUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingEnabled: boolean;

  // Trigger
  debounceMs: number;
  minEditLines: number;
  minSavesToTrigger: number;

  // Context retrieval
  maxEditHistory: number;
  maxLspReferences: number;
  maxSemanticResults: number;
  codeContextLines: number;

  // Indexing
  indexingExtensions: string[];
  indexingExcludePatterns: string[];

  // UI
  showInlineDecorations: boolean;
  autoShowPanel: boolean;
}

export function getConfig(): CueProConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    glmApiUrl: cfg.get<string>('glm.apiUrl', 'https://open.bigmodel.cn/api/paas/v4'),
    glmApiKey: cfg.get<string>('glm.apiKey', ''),
    glmModel: cfg.get<string>('glm.model', 'glm-4-plus'),

    embeddingApiUrl: cfg.get<string>('embedding.apiUrl', 'http://localhost:8080'),
    embeddingApiKey: cfg.get<string>('embedding.apiKey', ''),
    embeddingModel: cfg.get<string>('embedding.model', 'text-embedding-ada-002'),
    embeddingEnabled: cfg.get<boolean>('embedding.enabled', true),

    debounceMs: cfg.get<number>('trigger.debounceMs', 2000),
    minEditLines: cfg.get<number>('trigger.minEditLines', 1),
    minSavesToTrigger: cfg.get<number>('trigger.minSavesToTrigger', 3),

    maxEditHistory: cfg.get<number>('context.maxEditHistory', 20),
    maxLspReferences: cfg.get<number>('context.maxLspReferences', 15),
    maxSemanticResults: cfg.get<number>('context.maxSemanticResults', 5),
    codeContextLines: cfg.get<number>('context.codeContextLines', 20),

    indexingExtensions: cfg.get<string[]>('indexing.extensions', [
      '.ets', '.ts', '.tsx', '.js', '.jsx', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.c',
    ]),
    indexingExcludePatterns: cfg.get<string[]>('indexing.excludePatterns', [
      '**/node_modules/**', '**/oh_modules/**', '**/.ohpm/**',
      '**/out/**', '**/dist/**', '**/.git/**', '**/build/**',
    ]),

    showInlineDecorations: cfg.get<boolean>('ui.showInlineDecorations', true),
    autoShowPanel: cfg.get<boolean>('ui.autoShowPanel', true),
  };
}

/** Returns a validated config, throwing if required fields are missing */
export function requireConfig(): CueProConfig {
  const cfg = getConfig();
  if (!cfg.glmApiKey) {
    throw new Error(
      'Cue Pro: GLM API key is not configured. ' +
      'Please set "cuePro.glm.apiKey" in your VS Code settings.'
    );
  }
  return cfg;
}
