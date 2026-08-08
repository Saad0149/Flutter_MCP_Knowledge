import { z } from 'zod';
import type { AnalysisFinding, EvidenceItem } from '../analysis/index.js';

export type FindingVerbosity = 'brief' | 'normal' | 'full';

/** Shared optional response-shaping params for explain_finding / explore_finding. */
export const FindingResponseShapeSchema = {
  verbosity: z
    .enum(['brief', 'normal', 'full'])
    .optional()
    .describe(
      '"brief" = summary + fix + top evidence only (fast triage). "normal" (default) = ' +
        'today\'s full content, deduplicated. "full" = normal plus related findings and ' +
        'official references force-enabled (deep investigation of one finding).',
    ),
  maxEvidence: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Caps the evidence array length (default 5). Omitted items are counted, not dropped silently.'),
  includeRelated: z
    .boolean()
    .optional()
    .describe('Include related/adjacent findings. Defaults to false for verbosity=brief, true otherwise.'),
  fields: z
    .array(z.string().max(100))
    .max(50)
    .optional()
    .describe('Optional allowlist of top-level response fields to include; overrides verbosity when set.'),
  includeOfficialRefs: z
    .boolean()
    .optional()
    .describe(
      'Default true. When false, omit the official-reference block entirely instead of returning an empty placeholder.',
    ),
} as const;

export interface FindingResponseShapeInput {
  readonly verbosity?: FindingVerbosity;
  readonly maxEvidence?: number;
  readonly includeRelated?: boolean;
  readonly fields?: readonly string[];
  readonly includeOfficialRefs?: boolean;
}

const DEFAULT_MAX_EVIDENCE = 5;

/**
 * Resolves the shared shaping knobs against a verbosity preset.
 * "brief" defaults includeRelated to false (matches its "summary + fix +
 * top evidence only" definition); "normal"/"full" default it to true so the
 * no-params call keeps returning what callers already got before this change.
 * An explicit includeRelated/includeOfficialRefs always wins over the preset.
 */
export function resolveShapeOptions(input: FindingResponseShapeInput): {
  readonly verbosity: FindingVerbosity;
  readonly maxEvidence: number;
  readonly includeRelated: boolean;
  readonly includeOfficialRefs: boolean;
  readonly fields: readonly string[] | undefined;
} {
  const verbosity = input.verbosity ?? 'normal';
  return {
    verbosity,
    maxEvidence: input.maxEvidence ?? DEFAULT_MAX_EVIDENCE,
    includeRelated: input.includeRelated ?? verbosity !== 'brief',
    includeOfficialRefs: input.includeOfficialRefs ?? true,
    fields: input.fields,
  };
}

/** Caps an evidence array, reporting how many were omitted rather than silently truncating. */
export function capEvidence(
  items: readonly EvidenceItem[],
  max: number,
): { readonly evidence: readonly EvidenceItem[]; readonly evidenceOmittedCount?: number } {
  if (items.length <= max) {
    return { evidence: items };
  }
  return { evidence: items.slice(0, max), evidenceOmittedCount: items.length - max };
}

const CYCLE_SEPARATOR = /→|->/;

/**
 * For findings that carry raw import-cycle paths (e.g. CircularDependencies),
 * produces a short summary ("9 cycles; hub = app_snack_bar.dart") instead of
 * repeating the full raw cycle-path list, which explore_finding owns in full.
 * "Hub" = the file appearing in the most cycles (the module tangling the most cycles).
 */
export function summarizeCyclePaths(finding: AnalysisFinding): string | undefined {
  if (finding.code !== 'CircularDependencies') {
    return undefined;
  }

  const cyclePaths = finding.evidence.filter((line) => CYCLE_SEPARATOR.test(line));
  if (cyclePaths.length === 0) {
    return undefined;
  }

  const frequency = new Map<string, number>();
  for (const path of cyclePaths) {
    // Cycle notation repeats the start node at the end to show the closed
    // loop (e.g. "a -> b -> a") — dedupe per-cycle so that repeat doesn't
    // inflate a node's count beyond "one cycle it participates in".
    const nodes = new Set(path.split(CYCLE_SEPARATOR).map((n) => n.trim()));
    for (const node of nodes) {
      frequency.set(node, (frequency.get(node) ?? 0) + 1);
    }
  }

  let hub: string | undefined;
  let hubCount = 0;
  for (const [node, count] of frequency) {
    if (count > hubCount) {
      hub = node;
      hubCount = count;
    }
  }

  const cycleCount = finding.title.match(/^(\d+)/)?.[1] ?? String(cyclePaths.length);
  return hub
    ? `${cycleCount} cycle(s); hub = ${hub}`
    : `${cycleCount} cycle(s) detected`;
}

/** Removes null/undefined/empty-array/blank-string fields — never touches 0/false. */
export function omitEmpty<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

/** Applies the `fields` allowlist, always keeping session/identity metadata keys. */
export function selectFields<T extends object>(
  obj: T,
  fields: readonly string[] | undefined,
  alwaysKeep: readonly string[],
): Partial<T> {
  if (!fields || fields.length === 0) {
    return obj;
  }
  const keep = new Set([...alwaysKeep, ...fields]);
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (keep.has(key)) {
      out[key as keyof T] = value as T[keyof T];
    }
  }
  return out;
}
