import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/config/schema.js';
import { DartAnalyzerClient } from '../../../src/parser/dart-analyzer-client.js';
import { createTempDir, removeTempDir } from '../../helpers/git-fixtures.js';
import { SilentLogger } from '../../helpers/silent-logger.js';

/**
 * Regression coverage for the Bucket-A parsed-level visitor upgrade
 * (parser/bin/extract_symbols.dart's `_SymbolVisitor`): real branch
 * counting, real block-nesting depth, real build() body spans, and real
 * named-argument ListView detection, replacing the old whole-file regex
 * heuristics these findings used to be computed from (see
 * CONFIDENCE_AUDIT.md, "Bucket A" items 4 and 6).
 *
 * This spawns the *real* Dart analyzer helper — unlike the rest of this
 * test suite, which fakes the `dart` binary — because the bug being fixed
 * lives entirely in the Dart-side AST visitor; a hand-built fake JSON
 * payload would only prove the TypeScript glue trusts whatever it's given,
 * not that the visitor itself computes the right numbers. Skips itself
 * (rather than failing) when a real, working Dart analyzer isn't available
 * in this environment, since the rest of the suite deliberately doesn't
 * require one.
 */
function fakeConfig(): AppConfig {
  return {
    repositoriesRoot: './repos',
    indexPath: './data/knowledge.sqlite',
    indexOnUpdate: true,
  };
}

let dartAvailable = false;

describe('extract_symbols.dart _SymbolVisitor — real AST metrics (parsed-level)', () => {
  let tempDir: string | undefined;
  let client: DartAnalyzerClient;

  beforeAll(async () => {
    client = new DartAnalyzerClient(fakeConfig(), new SilentLogger());
    const probe = await client.verifyHelperEndToEnd();
    dartAvailable = probe.ok;
    if (!dartAvailable) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping extract_symbols.dart metrics regression tests — real Dart analyzer unavailable: ${probe.error}`,
      );
    }
  });

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function analyzeFixture(relativePath: string, content: string) {
    tempDir = await createTempDir('extract-symbols-metrics-');
    const filePath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    const result = await client.analyzeFiles(tempDir, [relativePath]);
    expect(result.available, result.warning).toBe(true);
    const file = result.files.find((f) => f.path === relativePath);
    expect(file, 'fixture file must be present in the result').toBeDefined();
    return file!;
  }

  it('does not miscount nullable-type `?` suffixes as branches (the old regex bug)', async () => {
    if (!dartAvailable) return;
    // Old heuristic (`estimateCyclomaticComplexity`'s /\b(...|?)\b/ regex)
    // would have counted every bare `?` as a branch, including nullable
    // type suffixes — 5 nullable fields with zero real control flow used
    // to report branchCount-equivalent >= 5. The real AST sees zero
    // decision points here: NamedType's `?` isn't a ConditionalExpression.
    const file = await analyzeFixture(
      'lib/nullable_heavy.dart',
      `class Profile {
  String? name;
  int? age;
  bool? active;
  double? score;
  List<String>? tags;

  String describe() => 'profile';
}
`,
    );
    expect(file.metrics?.branchCount).toBe(0);
  });

  it('counts real decision points (if/for/while/catch/&&/ternary) precisely, unlike the old double-counting regex', async () => {
    if (!dartAvailable) return;
    const file = await analyzeFixture(
      'lib/branchy.dart',
      `class Calc {
  int run(int x) {
    if (x > 0 && x < 10) {
      return x;
    } else if (x == 0) {
      return 0;
    }
    for (var i = 0; i < x; i++) {
      while (i > 5) {
        break;
      }
    }
    try {
      return x ~/ 0;
    } catch (e) {
      return -1;
    }
  }
}
`,
    );
    // if(&&)=2, else-if=1, for=1, while=1, catch=1 => 6. The old regex would
    // also have separately counted every bare `else` keyword as its own
    // hit (on top of `if`), inflating this further.
    expect(file.metrics?.branchCount).toBe(6);
  });

  it('measures real control-flow nesting depth, not brace-depth conflated with map/list literals', async () => {
    if (!dartAvailable) return;
    // A deeply nested *data literal* with zero control flow — the old
    // estimateNestingDepth (raw `{`/`}` counting across the whole file)
    // would have reported this as depth 4+. The real AST sees no if/for/
    // while/switch/try nodes at all here, so depth must be 0.
    const file = await analyzeFixture(
      'lib/nested_literal.dart',
      `const config = {
  'a': {
    'b': {
      'c': {
        'd': 1,
      },
    },
  },
};
`,
    );
    expect(file.metrics?.maxNestingDepth).toBe(0);
  });

  it('measures real control-flow nesting depth for genuinely nested if/for, treating else-if chains as same-level', async () => {
    if (!dartAvailable) return;
    const file = await analyzeFixture(
      'lib/nested_flow.dart',
      `class Deep {
  void run(int x) {
    if (x > 0) {
      if (x > 10) {
        if (x > 100) {
          print('big');
        }
      } else if (x > 5) {
        print('medium');
      } else if (x > 2) {
        print('small');
      }
    }
  }
}
`,
    );
    // if(x>0) -> depth1; if(x>10) -> depth2; if(x>100) -> depth3.
    // The else-if chain siblings sit at depth2 (same level as if(x>10)),
    // not accumulating extra depth per `else if`.
    expect(file.metrics?.maxNestingDepth).toBe(3);
  });

  it('computes the real build() method body span from AST offsets, not brace-matching over text', async () => {
    if (!dartAvailable) return;
    const file = await analyzeFixture(
      'lib/build_span.dart',
      `class MyWidget extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    // a comment containing a fake brace } to fool naive brace-matching
    final label = 'text with a } brace inside a string literal';
    return Text(label);
  }
}
`,
    );
    expect(file.metrics?.buildMethods).toHaveLength(1);
    const build = file.metrics!.buildMethods[0]!;
    expect(build.startLine).toBe(3);
    expect(build.endLine).toBe(7);
    expect(build.approxLines).toBe(5);
  });

  it('detects eager ListView(children:) via real named-argument AST matching, for both bare and explicit const/new calls', async () => {
    if (!dartAvailable) return;
    const file = await analyzeFixture(
      'lib/listview_misuse.dart',
      `class A extends StatelessWidget {
  Widget build(BuildContext context) {
    return ListView(children: [Text('a'), Text('b')]);
  }
}

class B extends StatelessWidget {
  Widget build(BuildContext context) {
    return const ListView(children: [Text('c')]);
  }
}
`,
    );
    expect(file.metrics?.listViewEagerCalls).toHaveLength(2);
    expect(file.metrics?.listViewEagerCalls.map((c) => c.line)).toEqual([3, 9]);
  });

  it('does NOT flag ListView.builder / ListView.separated as eager (the lazy, recommended constructors)', async () => {
    if (!dartAvailable) return;
    const file = await analyzeFixture(
      'lib/listview_builder_ok.dart',
      `class A extends StatelessWidget {
  Widget build(BuildContext context) {
    return ListView.builder(itemBuilder: (c, i) => Text('a'), itemCount: 3);
  }
}

class B extends StatelessWidget {
  Widget build(BuildContext context) {
    return ListView.separated(
      itemBuilder: (c, i) => Text('a'),
      separatorBuilder: (c, i) => const Divider(),
      itemCount: 3,
    );
  }
}
`,
    );
    expect(file.metrics?.listViewEagerCalls).toHaveLength(0);
  });

  it('does not flag a ListView(...) call that omits children (e.g. an empty/other-arg constructor)', async () => {
    if (!dartAvailable) return;
    const file = await analyzeFixture(
      'lib/listview_no_children.dart',
      `class A extends StatelessWidget {
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(8));
  }
}
`,
    );
    expect(file.metrics?.listViewEagerCalls).toHaveLength(0);
  });
});
