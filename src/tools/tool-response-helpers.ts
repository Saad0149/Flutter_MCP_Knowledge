import { z } from 'zod';
// Import from the concrete types module (not the analysis/index.js barrel) to
// avoid a circular import: the barrel re-exports summary-views.ts, which
// itself imports sampleFilesFor from this file.
import type { AnalysisFinding } from '../analysis/types.js';
import type { StoredAnalysisSession } from '../analysis/session/analysis-session-store.js';

export interface BlockedResult {
  readonly status: 'blocked';
  readonly reason: string;
  readonly message: string;
  readonly sessionId: string;
  readonly projectPath: string;
  /** The exact next tool call (or corrective action) that would resolve this block. */
  readonly suggestedAction: string;
}

/**
 * Fail-fast guard for the analyze_ family and review_project: rather than
 * running a full analyzer pass over a project with no Dart source (or
 * returning an apologetic empty-ish "0 findings" result), short-circuit
 * immediately with a structured, machine-parseable reason.
 */
export function checkAnalyzableSession(session: StoredAnalysisSession): BlockedResult | null {
  if (session.report.metrics.dartFileCount === 0) {
    return {
      status: 'blocked',
      reason: 'no_dart_files',
      message: `No Dart files were found under ${session.projectPath} — nothing to analyze. Confirm this is a Flutter/Dart project root.`,
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      suggestedAction:
        'Re-run this tool with projectPath pointing at the Flutter/Dart project root (the directory containing pubspec.yaml and lib/), or call check_environment to confirm the server sees the expected project.',
    };
  }
  return null;
}

/** Shared input schema fragment for the pathGlob/feature scoping params. */
export const ScopeFilterSchema = {
  pathGlob: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Optional glob to scope results to matching file paths (e.g. "lib/features/admin/**"). ' +
        'Filters the cached analysis response — does not trigger a rescan.',
    ),
  feature: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Optional feature/folder-name substring to scope results (e.g. "admin" matches paths ' +
        'containing "/admin/"). Simpler alternative to pathGlob.',
    ),
} as const;

export interface ScopeFilterInput {
  readonly pathGlob?: string;
  readonly feature?: string;
}

/**
 * Minimal, dependency-free glob to RegExp translator: supports double-star,
 * single-star, and `?`.
 *
 * SECURITY: consecutive double-star segments are collapsed before
 * translation (repeating the double-star segment behaves identically to
 * using it once). Without this, each extra double-star segment compiles to
 * another adjacent `.*` in the regex, and testing a chain of adjacent `.*`
 * groups against a long non-matching string is catastrophic backtracking —
 * verified empirically: an uncollapsed 10-segment chain hung for 20+ seconds
 * on a ~80-char input. Collapsing first makes the pathological input
 * impossible to construct, rather than trying to bound the resulting
 * regex's runtime after the fact.
 */
function globToRegExp(glob: string): RegExp {
  const collapsed = glob.replace(/(\*\*\/?)+(?=\*\*)/g, '');
  let out = '';
  for (let i = 0; i < collapsed.length; i += 1) {
    const c = collapsed[i];
    if (c === '*') {
      if (collapsed[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c!)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function findingPaths(f: AnalysisFinding): readonly string[] {
  const paths = new Set<string>();
  if (f.file) paths.add(f.file);
  for (const item of f.evidenceItems ?? []) {
    if (item.file) paths.add(item.file);
  }
  return [...paths];
}

/**
 * Response-side scoping: filters an already-computed findings array by
 * pathGlob/feature rather than rescanning. A finding is kept if ANY of its
 * known file paths (finding.file or evidenceItems[].file) match.
 */
export function filterFindingsByScope(
  findings: readonly AnalysisFinding[],
  scope: ScopeFilterInput,
): readonly AnalysisFinding[] {
  if (!scope.pathGlob && !scope.feature) {
    return findings;
  }

  const globRe = scope.pathGlob ? globToRegExp(scope.pathGlob) : null;
  const featureNeedle = scope.feature ? `/${scope.feature.replace(/^\/+|\/+$/g, '')}/` : null;

  return findings.filter((f) => {
    const paths = findingPaths(f);
    if (paths.length === 0) {
      return false;
    }
    return paths.some((p) => {
      const normalized = p.replaceAll('\\', '/');
      const matchesGlob = globRe ? globRe.test(normalized) : true;
      const matchesFeature = featureNeedle
        ? `/${normalized}/`.includes(featureNeedle) || normalized.startsWith(scope.feature + '/')
        : true;
      return matchesGlob && matchesFeature;
    });
  });
}

/** Up to `max` unique file paths drawn from a finding's real evidence (never fabricated). */
export function sampleFilesFor(finding: AnalysisFinding | undefined, max = 3): readonly string[] {
  if (!finding) return [];
  return findingPaths(finding).slice(0, max);
}

/**
 * Whether a finding has any evidence attached at all (raw strings or
 * structured items) — distinct from `sampleFilesFor` returning zero paths,
 * which can legitimately happen when evidence exists but isn't file-shaped.
 * Lets callers tell "no files to show" apart from "nothing to show at all".
 */
export function hasEvidenceFor(finding: AnalysisFinding | undefined): boolean {
  if (!finding) return false;
  return finding.evidence.length > 0 || (finding.evidenceItems?.length ?? 0) > 0;
}

export interface SizeMetadata {
  readonly bytes: number;
  readonly approxTokens: number;
}

export type Sized<T> = T & SizeMetadata;
export type SizedBlockedResult = Sized<BlockedResult>;

/**
 * Rough, cheap-to-compute size metadata so a calling agent can see the cost
 * of what it just received. Token estimate uses the common ~4 bytes/token
 * heuristic — approximate by design, not a real tokenizer.
 */
export function withSizeMetadata<T extends object>(data: T): Sized<T> {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  return { ...data, bytes, approxTokens: Math.ceil(bytes / 4) };
}
