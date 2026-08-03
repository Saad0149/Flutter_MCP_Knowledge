import type { RepositoryDefinition } from './types.js';

/**
 * Official Flutter/Dart knowledge sources (local clones via git only).
 * Phase 4 expands beyond framework/docs/samples to engine + Dart site.
 */
export const SUPPORTED_REPOSITORIES: readonly RepositoryDefinition[] = [
  {
    name: 'flutter/flutter',
    localName: 'flutter',
    cloneUrl: 'https://github.com/flutter/flutter.git',
    defaultBranch: 'master',
  },
  {
    name: 'flutter/packages',
    localName: 'packages',
    cloneUrl: 'https://github.com/flutter/packages.git',
    defaultBranch: 'main',
  },
  {
    name: 'flutter/engine',
    localName: 'engine',
    cloneUrl: 'https://github.com/flutter/engine.git',
    defaultBranch: 'main',
  },
  {
    name: 'dart-lang/sdk',
    localName: 'sdk',
    cloneUrl: 'https://github.com/dart-lang/sdk.git',
    defaultBranch: 'main',
  },
  {
    name: 'dart-lang/site-www',
    localName: 'site-www',
    cloneUrl: 'https://github.com/dart-lang/site-www.git',
    defaultBranch: 'main',
  },
  {
    name: 'flutter/samples',
    localName: 'samples',
    cloneUrl: 'https://github.com/flutter/samples.git',
    defaultBranch: 'main',
  },
  {
    name: 'flutter/website',
    localName: 'website',
    cloneUrl: 'https://github.com/flutter/website.git',
    defaultBranch: 'main',
  },
] as const;
