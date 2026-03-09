// ============================================================
// lspBridge.ts  —  VS Code LSP integration for symbol analysis
// Supports TypeScript/JavaScript (built-in) and C++ (via clangd)
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import { LspLocation, EditSnapshot, CandidateLocation } from './types';
import { getConfig } from './config';

export class LspBridge {
  /**
   * Given before/after snapshots, find all external locations (outside the changed files)
   * that reference the symbols modified in those snapshots.
   * This is the programmatic "where to change" step — no LLM involved.
   */
  async getCandidatesFromSnapshots(snapshots: EditSnapshot[]): Promise<CandidateLocation[]> {
    const cfg = getConfig();
    const changedUris = new Set(snapshots.map(s => s.uri));
    const allCandidates: CandidateLocation[] = [];

    console.log(`[CuePro LSP] Processing ${snapshots.length} snapshots`);

    for (const snapshot of snapshots) {
      const uri = vscode.Uri.parse(snapshot.uri);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === snapshot.uri);
      if (!doc) {
        console.log(`[CuePro LSP] ❌ Document not found for ${snapshot.file}`);
        continue;
      }

      // Find which lines changed between before and after
      const changedRange = findChangedLineRange(snapshot.beforeCode, snapshot.afterCode);
      if (!changedRange) {
        console.log(`[CuePro LSP] ❌ No changes detected in ${snapshot.file}`);
        continue;
      }
      console.log(`[CuePro LSP] ✓ Changed lines ${changedRange.start}-${changedRange.end} in ${snapshot.file}`);

      // Get document symbols and filter to those overlapping the changed region
      const rawSymbols = await this.safeExecute<unknown[]>(
        'vscode.executeDocumentSymbolProvider', [uri]
      );
      if (!rawSymbols || rawSymbols.length === 0) {
        console.log(`[CuePro LSP] ❌ No symbols found in ${snapshot.file}`);
        continue;
      }

      const changedSymbols = flattenSymbols(rawSymbols).filter(sym => {
        const r = getSymbolRange(sym);
        return r.start.line <= changedRange.end && r.end.line >= changedRange.start;
      });
      console.log(`[CuePro LSP] Found ${changedSymbols.length} changed symbols in ${snapshot.file}`);

      for (const sym of changedSymbols.slice(0, 5)) {
        const pos = getSymbolRange(sym).start;
        const refs = await this.safeExecute<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          [uri, pos, { includeDeclaration: false }]
        );

        const refCount = refs?.length ?? 0;
        console.log(`[CuePro LSP] Symbol '${getSymbolName(sym)}' has ${refCount} references`);

        for (const ref of (refs ?? []).slice(0, cfg.maxLspReferences)) {
          // Skip the files the developer already changed
          if (changedUris.has(ref.uri.toString())) continue;
          const candidate = await this.locationToCandidateLocation(
            ref, getSymbolName(sym), 'lsp'
          );
          if (candidate) allCandidates.push(candidate);
        }
      }
    }

    console.log(`[CuePro LSP] Total candidates found: ${allCandidates.length}`);
    return dedupCandidates(allCandidates).slice(0, cfg.maxLspReferences);
  }

  private async locationToCandidateLocation(
    location: vscode.Location,
    symbolName: string,
    source: CandidateLocation['source']
  ): Promise<CandidateLocation | null> {
    if (location.uri.scheme !== 'file') return null;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(location.uri);
    const relativeFile = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, location.uri.fsPath)
      : location.uri.fsPath;

    const refLine = location.range.start.line;

    // Find the enclosing function/method/block so we capture a complete unit
    const enclosing = await this.getEnclosingSymbolRange(location.uri, refLine);

    const startLine = enclosing?.start ?? Math.max(0, refLine - 10);
    const endLine   = enclosing?.end   ?? (refLine + 10);
    const currentCode = await this.getCodeRange(location.uri, startLine, endLine);
    if (currentCode === null) return null;

    return {
      file: relativeFile,
      uri: location.uri.toString(),
      startLine,
      endLine,
      currentCode,
      source,
      symbolName,
    };
  }

  /**
   * Public wrapper: snap an arbitrary line range to the enclosing symbol boundary.
   * Used by embedding candidates to upgrade chunk boundaries to function boundaries.
   */
  async snapToEnclosingSymbol(
    uri: vscode.Uri,
    refLine: number
  ): Promise<{ start: number; end: number; code: string } | undefined> {
    const range = await this.getEnclosingSymbolRange(uri, refLine);
    if (!range) return undefined;
    const code = await this.getCodeRange(uri, range.start, range.end);
    return code ? { ...range, code } : undefined;
  }

  /**
   * Returns the line range of the innermost symbol (function/method/arrow fn/block)
   * that contains `refLine`. Falls back to undefined if no symbol found.
   * Capped at 60 lines to avoid embedding entire large classes.
   */
  private async getEnclosingSymbolRange(
    uri: vscode.Uri,
    refLine: number
  ): Promise<{ start: number; end: number } | undefined> {
    const rawSymbols = await this.safeExecute<unknown[]>(
      'vscode.executeDocumentSymbolProvider', [uri]
    );
    if (!rawSymbols || rawSymbols.length === 0) return undefined;

    const allSymbols = flattenSymbols(rawSymbols);

    // Find the innermost symbol whose range contains refLine
    let bestStart = -1;
    let bestEnd = -1;
    let bestSize = Infinity;

    for (const sym of allSymbols) {
      const r = getSymbolRange(sym);
      if (r.start.line <= refLine && r.end.line >= refLine) {
        const size = r.end.line - r.start.line;
        if (size < bestSize) {
          bestSize = size;
          bestStart = r.start.line;
          bestEnd = r.end.line;
        }
      }
    }

    if (bestStart === -1) return undefined;

    // Cap at 60 lines to stay within a reasonable context window
    const cappedEnd = Math.min(bestEnd, bestStart + 59);
    return { start: bestStart, end: cappedEnd };
  }

  /** Read exact lines [startLine, endLine] as plain code (no line-number prefix) */
  private async getCodeRange(
    uri: vscode.Uri,
    startLine: number,
    endLine: number
  ): Promise<string | null> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const from = Math.max(0, startLine);
      const to   = Math.min(doc.lineCount - 1, endLine);
      const lines: string[] = [];
      for (let i = from; i <= to; i++) {
        lines.push(doc.lineAt(i).text);
      }
      return lines.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * Given a document and a position, find all symbols at or near that position
   * and return their references + definitions across the workspace.
   */
  async getRelevantLocations(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): Promise<LspLocation[]> {
    const cfg = getConfig();
    const results: LspLocation[] = [];

    // 1. Try to get the symbol under cursor
    const wordRange = doc.getWordRangeAtPosition(position, /[\w$]+/);
    if (!wordRange) return results;
    const symbolName = doc.getText(wordRange);
    if (!symbolName || symbolName.length < 2) return results;

    // 2. Get definition(s)
    const definitions = await this.safeExecute<vscode.Location[]>(
      'vscode.executeDefinitionProvider',
      [doc.uri, position]
    );
    for (const def of definitions ?? []) {
      const loc = await this.locationToLspLocation(def, symbolName, 'definition', cfg.codeContextLines);
      if (loc) results.push(loc);
    }

    // 3. Get all references
    const references = await this.safeExecute<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      [doc.uri, position, { includeDeclaration: false }]
    );

    const limitedRefs = (references ?? []).slice(0, cfg.maxLspReferences);
    for (const ref of limitedRefs) {
      const loc = await this.locationToLspLocation(ref, symbolName, 'reference', cfg.codeContextLines);
      if (loc) results.push(loc);
    }

    // 4. For TypeScript/JavaScript: try implementation provider
    if (['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(doc.languageId)) {
      const impls = await this.safeExecute<vscode.Location[]>(
        'vscode.executeImplementationProvider',
        [doc.uri, position]
      );
      for (const impl of impls ?? []) {
        const loc = await this.locationToLspLocation(impl, symbolName, 'implementation', cfg.codeContextLines);
        if (loc) results.push(loc);
      }
    }

    // Deduplicate by file+line
    return this.dedup(results).slice(0, cfg.maxLspReferences);
  }

  /**
   * Searches for all workspace symbols matching a name (cross-file).
   * Useful when LSP reference lookup doesn't cover all usages.
   */
  async searchWorkspaceSymbols(query: string): Promise<LspLocation[]> {
    const cfg = getConfig();
    const symbols = await this.safeExecute<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      [query]
    );
    if (!symbols) return [];

    const results: LspLocation[] = [];
    for (const sym of symbols.slice(0, cfg.maxLspReferences)) {
      const loc = await this.locationToLspLocation(sym.location, sym.name, 'reference', cfg.codeContextLines);
      if (loc) results.push(loc);
    }
    return results;
  }

  /**
   * Extracts all top-level symbols from a document (for rich context).
   */
  async getDocumentSymbols(uri: vscode.Uri): Promise<string[]> {
    const symbols = await this.safeExecute<vscode.SymbolInformation[]>(
      'vscode.executeDocumentSymbolProvider',
      [uri]
    );
    if (!symbols) return [];
    return symbols.map(s => s.name);
  }

  private async locationToLspLocation(
    location: vscode.Location,
    symbolName: string,
    relation: LspLocation['relation'],
    contextLines: number
  ): Promise<LspLocation | null> {
    if (location.uri.scheme !== 'file') return null;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(location.uri);
    const relativeFile = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, location.uri.fsPath)
      : location.uri.fsPath;

    const startLine = location.range.start.line;
    const endLine = location.range.end.line;

    const codeContext = await this.getCodeContext(location.uri, startLine, endLine, contextLines);
    if (codeContext === null) return null;

    return {
      file: relativeFile,
      uri: location.uri.toString(),
      startLine,
      endLine,
      codeContext,
      relation,
      symbolName,
    };
  }

  private async getCodeContext(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    contextLines: number
  ): Promise<string | null> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const from = Math.max(0, startLine - contextLines);
      const to = Math.min(doc.lineCount - 1, endLine + contextLines);
      const lines: string[] = [];
      for (let i = from; i <= to; i++) {
        const prefix = i === startLine ? '>' : ' ';
        lines.push(`${prefix} ${i + 1}: ${doc.lineAt(i).text}`);
      }
      return lines.join('\n');
    } catch {
      return null;
    }
  }

  private dedup(locations: LspLocation[]): LspLocation[] {
    const seen = new Set<string>();
    return locations.filter(loc => {
      const key = `${loc.file}:${loc.startLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async safeExecute<T>(command: string, args: unknown[]): Promise<T | undefined> {
    try {
      console.log(`[CuePro LSP] Executing: ${command}`);

      // Retry up to 3 times with delay for LSP to initialize
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await vscode.commands.executeCommand<T>(command, ...args);

        if (result !== undefined && result !== null) {
          console.log(`[CuePro LSP] Result: ${Array.isArray(result) ? `${result.length} items` : 'object'}`);
          return result;
        }

        if (attempt < 2) {
          console.log(`[CuePro LSP] Result undefined, retrying in 500ms... (attempt ${attempt + 1}/3)`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.warn(`[CuePro LSP] ⚠️ Command '${command}' returned undefined after 3 attempts`);
      return undefined;
    } catch (err) {
      console.error(`[CuePro LSP] ❌ Command '${command}' failed:`, err);
      return undefined;
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/** Find the first/last line that differ between two texts */
function findChangedLineRange(
  before: string,
  after: string
): { start: number; end: number } | undefined {
  const bLines = before.split('\n');
  const aLines = after.split('\n');

  let start = 0;
  while (start < bLines.length && start < aLines.length && bLines[start] === aLines[start]) {
    start++;
  }
  if (start >= bLines.length && start >= aLines.length) return undefined;

  let endB = bLines.length - 1;
  let endA = aLines.length - 1;
  while (endB > start && endA > start && bLines[endB] === aLines[endA]) {
    endB--;
    endA--;
  }
  return { start, end: endA };
}

type AnySymbol = vscode.SymbolInformation | vscode.DocumentSymbol;

function getSymbolRange(sym: AnySymbol): vscode.Range {
  return 'location' in sym ? sym.location.range : sym.range;
}

function getSymbolName(sym: AnySymbol): string {
  return sym.name;
}

/** Recursively flatten DocumentSymbol tree + SymbolInformation array */
function flattenSymbols(symbols: unknown[]): AnySymbol[] {
  const result: AnySymbol[] = [];
  for (const sym of symbols) {
    if (!sym || typeof sym !== 'object') continue;
    result.push(sym as AnySymbol);
    const children = (sym as { children?: unknown[] }).children;
    if (Array.isArray(children)) {
      result.push(...flattenSymbols(children));
    }
  }
  return result;
}

function dedupCandidates(candidates: CandidateLocation[]): CandidateLocation[] {
  const seen = new Set<string>();
  return candidates.filter(c => {
    const key = `${c.uri}:${c.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
