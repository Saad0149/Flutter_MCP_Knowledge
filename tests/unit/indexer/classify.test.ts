import { describe, expect, it } from 'vitest';
import {
  classifyDocKind,
  classifyFileKind,
  isWidgetTestPath,
} from '../../../src/indexer/classify.js';
import { SUPPORTED_REPOSITORIES } from '../../../src/repository/definitions.js';

describe('Phase 4 classification', () => {
  it('includes engine and site-www in supported repos', () => {
    const names = SUPPORTED_REPOSITORIES.map((r) => r.name);
    expect(names).toContain('flutter/engine');
    expect(names).toContain('dart-lang/site-www');
  });

  it('classifies changelog and migration paths', () => {
    expect(classifyDocKind('CHANGELOG.md')).toBe('changelog');
    expect(classifyDocKind('packages/foo/CHANGELOG')).toBe('changelog');
    expect(classifyDocKind('docs/migration/null-safety.md')).toBe('migration');
    expect(classifyDocKind('src/content/release/breaking-changes/foo.md')).toBe('migration');
    expect(classifyDocKind('src/content/cookbook/lists/keys.md')).toBe('cookbook');
    expect(classifyDocKind('src/content/guides/navigation.md')).toBe('guide');
  });

  it('treats changelog files as documentation file kind', () => {
    expect(classifyFileKind('CHANGELOG')).toBe('md');
    expect(classifyFileKind('lib/a.dart')).toBe('dart');
  });

  it('detects widget test paths', () => {
    expect(isWidgetTestPath('packages/flutter/test/widgets/container_test.dart')).toBe(true);
    expect(isWidgetTestPath('packages/flutter/test/material/button_test.dart')).toBe(true);
    expect(isWidgetTestPath('packages/flutter/lib/src/widgets/container.dart')).toBe(false);
  });
});
