import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DependencyContainer } from 'tsyringe';
import { z } from 'zod';
import { TYPES } from '../types/tokens.js';
import type { ExplainWidgetHandler } from './explain-widget.js';
import { ExplainWidgetInputSchema } from './explain-widget.js';
import type { FindBestPracticeHandler } from './find-best-practice.js';
import { FindBestPracticeInputSchema } from './find-best-practice.js';
import type { FindExamplesHandler } from './find-examples.js';
import { FindExamplesInputSchema } from './find-examples.js';
import type { FindTestsHandler } from './find-tests.js';
import { FindTestsInputSchema } from './find-tests.js';
import type { FindWidgetHandler } from './find-widget.js';
import { FindWidgetInputSchema } from './find-widget.js';
import type { ReindexHandler } from './reindex.js';
import { ReindexInputSchema } from './reindex.js';
import type { RepositoryStatusHandler } from './repository-status.js';
import { RepositoryStatusInputSchema } from './repository-status.js';
import type { ReviewProjectHandler } from './review-project.js';
import { ReviewProjectInputSchema } from './review-project.js';
import type { SearchDocsHandler } from './search-docs.js';
import { SearchDocsInputSchema } from './search-docs.js';
import type { SearchSourceHandler } from './search-source.js';
import { SearchSourceInputSchema } from './search-source.js';
import { toMcpContent } from './tool-result.js';
import type { TraceWidgetHandler } from './trace-widget.js';
import { TraceWidgetInputSchema } from './trace-widget.js';
import type { UpdateRepositoriesHandler } from './update-repositories.js';
import type { FindIntendedBehaviorHandler } from './find-intended-behavior.js';
import { FindIntendedBehaviorInputSchema } from './find-intended-behavior.js';
import type { AnalyzeCodeQualityHandler } from './analyze-code-quality.js';
import {
  AnalyzeCodeQualityInputObjectSchema,
  AnalyzeCodeQualityInputSchema,
} from './analyze-code-quality.js';
import type { AnalyzeStateManagementHandler } from './analyze-state-management.js';
import {
  AnalyzeStateManagementInputObjectSchema,
  AnalyzeStateManagementInputSchema,
} from './analyze-state-management.js';
import type { AnalyzeArchitectureHandler } from './analyze-architecture.js';
import {
  AnalyzeArchitectureInputObjectSchema,
  AnalyzeArchitectureInputSchema,
} from './analyze-architecture.js';
import type { ExplainFindingHandler } from './explain-finding.js';
import {
  ExplainFindingInputObjectSchema,
  ExplainFindingInputSchema,
} from './explain-finding.js';
import type { ExploreFindingHandler } from './explore-finding.js';
import {
  ExploreFindingInputObjectSchema,
  ExploreFindingInputSchema,
} from './explore-finding.js';
import type { AnalyzeComplexityHandler } from './analyze-complexity.js';
import {
  AnalyzeComplexityInputObjectSchema,
  AnalyzeComplexityInputSchema,
} from './analyze-complexity.js';
import type { AnalyzeDocumentationHandler } from './analyze-documentation.js';
import {
  AnalyzeDocumentationInputObjectSchema,
  AnalyzeDocumentationInputSchema,
} from './analyze-documentation.js';
import type { AnalyzeTestingHandler } from './analyze-testing.js';
import {
  AnalyzeTestingInputObjectSchema,
  AnalyzeTestingInputSchema,
} from './analyze-testing.js';
import type { AnalyzeDependenciesHandler } from './analyze-dependencies.js';
import {
  AnalyzeDependenciesInputObjectSchema,
  AnalyzeDependenciesInputSchema,
} from './analyze-dependencies.js';
import type { AnalyzePerformanceHandler } from './analyze-performance.js';
import {
  AnalyzePerformanceInputObjectSchema,
  AnalyzePerformanceInputSchema,
} from './analyze-performance.js';
import type { AnalyzeAccessibilityHandler } from './analyze-accessibility.js';
import {
  AnalyzeAccessibilityInputObjectSchema,
  AnalyzeAccessibilityInputSchema,
} from './analyze-accessibility.js';

/**
 * Registers Phase 1–4 MCP tools plus analysis engines on the server.
 */
export function registerTools(server: McpServer, container: DependencyContainer): void {
  const updateRepositories = container.resolve<UpdateRepositoriesHandler>(
    TYPES.UpdateRepositoriesHandler,
  );
  const repositoryStatus = container.resolve<RepositoryStatusHandler>(
    TYPES.RepositoryStatusHandler,
  );
  const searchSource = container.resolve<SearchSourceHandler>(TYPES.SearchSourceHandler);
  const findWidget = container.resolve<FindWidgetHandler>(TYPES.FindWidgetHandler);
  const reindex = container.resolve<ReindexHandler>(TYPES.ReindexHandler);
  const explainWidget = container.resolve<ExplainWidgetHandler>(TYPES.ExplainWidgetHandler);
  const searchDocs = container.resolve<SearchDocsHandler>(TYPES.SearchDocsHandler);
  const findExamples = container.resolve<FindExamplesHandler>(TYPES.FindExamplesHandler);
  const findTests = container.resolve<FindTestsHandler>(TYPES.FindTestsHandler);
  const traceWidget = container.resolve<TraceWidgetHandler>(TYPES.TraceWidgetHandler);
  const findBestPractice = container.resolve<FindBestPracticeHandler>(
    TYPES.FindBestPracticeHandler,
  );
  const reviewProject = container.resolve<ReviewProjectHandler>(TYPES.ReviewProjectHandler);
  const findIntendedBehavior = container.resolve<FindIntendedBehaviorHandler>(
    TYPES.FindIntendedBehaviorHandler,
  );
  const analyzeCodeQuality = container.resolve<AnalyzeCodeQualityHandler>(
    TYPES.AnalyzeCodeQualityHandler,
  );
  const analyzeStateManagement = container.resolve<AnalyzeStateManagementHandler>(
    TYPES.AnalyzeStateManagementHandler,
  );
  const analyzeArchitecture = container.resolve<AnalyzeArchitectureHandler>(
    TYPES.AnalyzeArchitectureHandler,
  );
  const explainFinding = container.resolve<ExplainFindingHandler>(TYPES.ExplainFindingHandler);
  const exploreFinding = container.resolve<ExploreFindingHandler>(TYPES.ExploreFindingHandler);
  const analyzeComplexity = container.resolve<AnalyzeComplexityHandler>(
    TYPES.AnalyzeComplexityHandler,
  );
  const analyzeDocumentation = container.resolve<AnalyzeDocumentationHandler>(
    TYPES.AnalyzeDocumentationHandler,
  );
  const analyzeTesting = container.resolve<AnalyzeTestingHandler>(TYPES.AnalyzeTestingHandler);
  const analyzeDependencies = container.resolve<AnalyzeDependenciesHandler>(
    TYPES.AnalyzeDependenciesHandler,
  );
  const analyzePerformance = container.resolve<AnalyzePerformanceHandler>(
    TYPES.AnalyzePerformanceHandler,
  );
  const analyzeAccessibility = container.resolve<AnalyzeAccessibilityHandler>(
    TYPES.AnalyzeAccessibilityHandler,
  );

  server.tool(
    'update_repositories',
    'Clone missing official Flutter/Dart repositories, pull latest changes, and optionally reindex.',
    {},
    async () => toMcpContent(await updateRepositories.execute()),
  );

  server.tool(
    'repository_status',
    'Report existence, branch, commit, last pull time, and path for supported repositories.',
    { repository: RepositoryStatusInputSchema.shape.repository },
    async (args) => toMcpContent(await repositoryStatus.execute(args)),
  );

  server.tool(
    'search_source',
    'Search filenames and file contents across local official Flutter/Dart repositories (index-aware).',
    {
      query: SearchSourceInputSchema.shape.query,
      repository: SearchSourceInputSchema.shape.repository,
      limit: SearchSourceInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await searchSource.execute(args)),
  );

  server.tool(
    'find_widget',
    'Locate a Flutter widget by name using the SQLite index when available, else filesystem search.',
    {
      name: FindWidgetInputSchema.shape.name,
      repository: FindWidgetInputSchema.shape.repository,
      limit: FindWidgetInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await findWidget.execute(args)),
  );

  server.tool(
    'reindex',
    'Build or refresh the local SQLite knowledge index for one or all repositories.',
    {
      repository: ReindexInputSchema.shape.repository,
      force: ReindexInputSchema.shape.force,
    },
    async (args) => toMcpContent(await reindex.execute(args)),
  );

  server.tool(
    'explain_widget',
    'Explain a widget from the local index (declaration, inheritance, documentation).',
    {
      name: ExplainWidgetInputSchema.shape.name,
      repository: ExplainWidgetInputSchema.shape.repository,
    },
    async (args) => toMcpContent(await explainWidget.execute(args)),
  );

  server.tool(
    'search_docs',
    'Search indexed documentation (guides, cookbook, migrations, CHANGELOGs).',
    {
      query: SearchDocsInputSchema.shape.query,
      repository: SearchDocsInputSchema.shape.repository,
      docKind: SearchDocsInputSchema.shape.docKind,
      limit: SearchDocsInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await searchDocs.execute(args)),
  );

  server.tool(
    'find_examples',
    'Find examples related to a topic from samples and example/ directories.',
    {
      topic: FindExamplesInputSchema.shape.topic,
      limit: FindExamplesInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await findExamples.execute(args)),
  );

  server.tool(
    'find_tests',
    'Find tests related to a symbol; widget tests are preferred when available.',
    {
      symbol: FindTestsInputSchema.shape.symbol,
      repository: FindTestsInputSchema.shape.repository,
      widgetTestsOnly: FindTestsInputSchema.shape.widgetTestsOnly,
      limit: FindTestsInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await findTests.execute(args)),
  );

  server.tool(
    'trace_widget',
    'Trace widget/class inheritance and related symbols from the index.',
    {
      symbol: TraceWidgetInputSchema.shape.symbol,
      repository: TraceWidgetInputSchema.shape.repository,
      depth: TraceWidgetInputSchema.shape.depth,
    },
    async (args) => toMcpContent(await traceWidget.execute(args)),
  );

  server.tool(
    'find_best_practice',
    'Rank website, samples, and docs hits for a best-practice topic.',
    {
      topic: FindBestPracticeInputSchema.shape.topic,
      limit: FindBestPracticeInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await findBestPractice.execute(args)),
  );

  server.tool(
    'review_project',
    'Analyze once: executive health summary + sessionId. Pass sessionId to follow-up tools (no rescan). Use detail=full only when you need the entire report.',
    {
      path: ReviewProjectInputSchema.shape.path,
      limit: ReviewProjectInputSchema.shape.limit,
      detail: ReviewProjectInputSchema.shape.detail,
    },
    async (args) => toMcpContent(await reviewProject.execute(args)),
  );

  server.tool(
    'find_intended_behavior',
    'How is this meant to be used? Joins widget tests, samples, migrations/cookbook/guides, and source.',
    {
      topic: FindIntendedBehaviorInputSchema.shape.topic,
      limit: FindIntendedBehaviorInputSchema.shape.limit,
    },
    async (args) => toMcpContent(await findIntendedBehavior.execute(args)),
  );

  server.tool(
    'analyze_code_quality',
    'Code quality view from a review_project session (or path). Slim findings + score — not a full rescan when sessionId is set.',
    {
      sessionId: AnalyzeCodeQualityInputObjectSchema.shape.sessionId,
      path: AnalyzeCodeQualityInputObjectSchema.shape.path,
      limit: AnalyzeCodeQualityInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeCodeQuality.execute(args)),
  );

  server.tool(
    'analyze_state_management',
    'State management view from a review_project session (or path). Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeStateManagementInputObjectSchema.shape.sessionId,
      path: AnalyzeStateManagementInputObjectSchema.shape.path,
      limit: AnalyzeStateManagementInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeStateManagement.execute(args)),
  );

  server.tool(
    'analyze_architecture',
    'Architecture view from a review_project session (or path). Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeArchitectureInputObjectSchema.shape.sessionId,
      path: AnalyzeArchitectureInputObjectSchema.shape.path,
      limit: AnalyzeArchitectureInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeArchitecture.execute(args)),
  );

  server.tool(
    'explain_finding',
    'Mentor-style explanation for one finding. Prefer sessionId from review_project.',
    {
      sessionId: ExplainFindingInputObjectSchema.shape.sessionId,
      path: ExplainFindingInputObjectSchema.shape.path,
      findingCode: ExplainFindingInputObjectSchema.shape.findingCode,
      findingId: ExplainFindingInputObjectSchema.shape.findingId,
    },
    async (args) => toMcpContent(await explainFinding.execute(args)),
  );

  server.tool(
    'explore_finding',
    'Evidence for one finding (files, symbols, refactor). Prefer sessionId from review_project.',
    {
      sessionId: ExploreFindingInputObjectSchema.shape.sessionId,
      path: ExploreFindingInputObjectSchema.shape.path,
      findingCode: ExploreFindingInputObjectSchema.shape.findingCode,
      findingId: ExploreFindingInputObjectSchema.shape.findingId,
      limit: ExploreFindingInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await exploreFinding.execute(args)),
  );

  server.tool(
    'analyze_complexity',
    'Complexity view from a review_project session (or path). Returns file-size distribution, estimated high-complexity files, and slim findings. Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeComplexityInputObjectSchema.shape.sessionId,
      path: AnalyzeComplexityInputObjectSchema.shape.path,
      limit: AnalyzeComplexityInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeComplexity.execute(args)),
  );

  server.tool(
    'analyze_documentation',
    'Documentation coverage view from a review_project session (or path). Returns widget/class doc ratios, README presence, and findings. Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeDocumentationInputObjectSchema.shape.sessionId,
      path: AnalyzeDocumentationInputObjectSchema.shape.path,
      limit: AnalyzeDocumentationInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeDocumentation.execute(args)),
  );

  server.tool(
    'analyze_testing',
    'Testing coverage view from a review_project session (or path). Returns test/lib ratios, test type counts, and untested features. Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeTestingInputObjectSchema.shape.sessionId,
      path: AnalyzeTestingInputObjectSchema.shape.path,
      limit: AnalyzeTestingInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeTesting.execute(args)),
  );

  server.tool(
    'analyze_dependencies',
    'Dependency health view from a review_project session (or path). Returns layer violations, circular cycles, and slim findings. Use detail=full to include full violation arrays. Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeDependenciesInputObjectSchema.shape.sessionId,
      path: AnalyzeDependenciesInputObjectSchema.shape.path,
      limit: AnalyzeDependenciesInputObjectSchema.shape.limit,
      detail: AnalyzeDependenciesInputObjectSchema.shape.detail,
    },
    async (args) => toMcpContent(await analyzeDependencies.execute(args)),
  );

  server.tool(
    'analyze_performance',
    'Performance view from a review_project session (or path). Returns build method sizes, setState issues, and animation controller leaks. Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzePerformanceInputObjectSchema.shape.sessionId,
      path: AnalyzePerformanceInputObjectSchema.shape.path,
      limit: AnalyzePerformanceInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzePerformance.execute(args)),
  );

  server.tool(
    'analyze_accessibility',
    'Accessibility view from a review_project session (or path). Returns semantics widget counts, tooltip usage, and missing semantic labels. Prefer sessionId to avoid rescanning.',
    {
      sessionId: AnalyzeAccessibilityInputObjectSchema.shape.sessionId,
      path: AnalyzeAccessibilityInputObjectSchema.shape.path,
      limit: AnalyzeAccessibilityInputObjectSchema.shape.limit,
    },
    async (args) => toMcpContent(await analyzeAccessibility.execute(args)),
  );
}

export const ToolSchemas = {
  repository_status: RepositoryStatusInputSchema,
  search_source: SearchSourceInputSchema,
  find_widget: FindWidgetInputSchema,
  update_repositories: z.object({}),
  reindex: ReindexInputSchema,
  explain_widget: ExplainWidgetInputSchema,
  search_docs: SearchDocsInputSchema,
  find_examples: FindExamplesInputSchema,
  find_tests: FindTestsInputSchema,
  trace_widget: TraceWidgetInputSchema,
  find_best_practice: FindBestPracticeInputSchema,
  review_project: ReviewProjectInputSchema,
  find_intended_behavior: FindIntendedBehaviorInputSchema,
  analyze_code_quality: AnalyzeCodeQualityInputSchema,
  analyze_state_management: AnalyzeStateManagementInputSchema,
  analyze_architecture: AnalyzeArchitectureInputSchema,
  explain_finding: ExplainFindingInputSchema,
  explore_finding: ExploreFindingInputSchema,
  analyze_complexity: AnalyzeComplexityInputSchema,
  analyze_documentation: AnalyzeDocumentationInputSchema,
  analyze_testing: AnalyzeTestingInputSchema,
  analyze_dependencies: AnalyzeDependenciesInputSchema,
  analyze_performance: AnalyzePerformanceInputSchema,
  analyze_accessibility: AnalyzeAccessibilityInputSchema,
} as const;
