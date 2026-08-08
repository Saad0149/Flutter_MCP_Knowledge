/**
 * Shared import-cycle detector. Used by both DependencyAnalyzer and
 * ArchitectureAnalyzer, which each need cycle info for their own facts/
 * scoring — extracted to one implementation so the two never drift again
 * (see DUPLICATE_FINDINGS_AUDIT.md #5: ArchitectureAnalyzer used to carry
 * its own copy-pasted, still-recursive version of this exact function,
 * which meant a stack-overflow-DoS fix applied to one copy silently never
 * reached the other).
 *
 * Explicit-stack (iterative) DFS — deliberately not recursive. A real
 * project can have an import chain thousands of files deep (a >>10k-file
 * monorepo with a long a→b→c→... chain is entirely plausible, not just
 * adversarial), and a naive `dfs(next)` recursive call per edge would grow
 * the JS call stack one frame per chain link, risking `RangeError: Maximum
 * call stack size exceeded` on large-but-legitimate projects. An explicit
 * frame stack on the heap has no such limit.
 */
export function detectCycles(
  edges: readonly { readonly from: string; readonly to: string }[],
): string[] {
  const graph = new Map<string, string[]>();
  for (const e of edges) {
    const list = graph.get(e.from) ?? [];
    list.push(e.to);
    graph.set(e.from, list);
  }

  const cycles: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const pathStack: string[] = [];

  interface Frame {
    readonly node: string;
    readonly children: readonly string[];
    childIdx: number;
  }

  for (const start of graph.keys()) {
    if (visited.has(start) || cycles.length >= 25) {
      continue;
    }

    visiting.add(start);
    pathStack.push(start);
    const frames: Frame[] = [{ node: start, children: graph.get(start) ?? [], childIdx: 0 }];

    while (frames.length > 0 && cycles.length < 25) {
      const frame = frames[frames.length - 1]!;

      if (frame.childIdx >= frame.children.length) {
        frames.pop();
        pathStack.pop();
        visiting.delete(frame.node);
        visited.add(frame.node);
        continue;
      }

      const next = frame.children[frame.childIdx]!;
      frame.childIdx += 1;

      if (visited.has(next)) {
        continue;
      }
      if (visiting.has(next)) {
        const idx = pathStack.indexOf(next);
        if (idx >= 0) {
          cycles.push([...pathStack.slice(idx), next].join(' → '));
        }
        continue;
      }

      visiting.add(next);
      pathStack.push(next);
      frames.push({ node: next, children: graph.get(next) ?? [], childIdx: 0 });
    }
  }

  return cycles;
}
