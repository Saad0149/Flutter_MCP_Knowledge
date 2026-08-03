import type { DocKind, FileKind } from '../store/types.js';

/**
 * Path-based classification for Phase 4 knowledge kinds.
 */

export function normalizeRepoPath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

export function classifyFileKind(relativePath: string): FileKind {
  const lower = normalizeRepoPath(relativePath).toLowerCase();
  if (lower.endsWith('.dart')) {
    return 'dart';
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
    return 'md';
  }
  const base = lower.split('/').pop() ?? lower;
  if (base === 'changelog' || base.startsWith('changelog.')) {
    return 'md';
  }
  return 'other';
}

export function classifyDocKind(relativePath: string): DocKind {
  const path = normalizeRepoPath(relativePath).toLowerCase();
  const base = path.split('/').pop() ?? path;

  if (base === 'changelog' || base.startsWith('changelog.') || path.includes('/changelog')) {
    return 'changelog';
  }
  if (
    path.includes('/migration') ||
    path.includes('migrat') ||
    path.includes('/breaking-changes') ||
    path.includes('breaking_changes')
  ) {
    return 'migration';
  }
  if (path.includes('/cookbook/') || path.includes('/cookbook.') || path.includes('cookbook/')) {
    return 'cookbook';
  }
  if (
    path.includes('/guides/') ||
    path.includes('/guide/') ||
    path.includes('/docs/') ||
    path.includes('/content/')
  ) {
    return 'guide';
  }
  return 'general';
}

/**
 * Widget tests often live under test/widgets or are named *_test.dart near widgets.
 */
export function isWidgetTestPath(relativePath: string): boolean {
  const path = normalizeRepoPath(relativePath).toLowerCase();
  if (!path.endsWith('.dart')) {
    return false;
  }
  if (path.includes('/test/widgets/') || path.includes('/test\\widgets\\')) {
    return true;
  }
  if (path.includes('/widget_test') || path.includes('widget_tester')) {
    return true;
  }
  // e.g. packages/flutter/test/material/button_test.dart — treat *_test.dart under /test/ as widget-ish
  // Prefer explicit widgets/ material/ cupertino/ rendering test dirs
  if (
    path.includes('/test/') &&
    path.endsWith('_test.dart') &&
    (path.includes('/widgets/') ||
      path.includes('/material/') ||
      path.includes('/cupertino/') ||
      path.includes('/rendering/'))
  ) {
    return true;
  }
  return false;
}

export function isDocumentationPath(relativePath: string): boolean {
  const kind = classifyFileKind(relativePath);
  return kind === 'md';
}
