import 'reflect-metadata';
import { container, type DependencyContainer } from 'tsyringe';
import {
  AccessibilityAnalyzer,
  AnalysisSessionStore,
  ArchitectureAnalyzer,
  ArchitectureMatchEngine,
  AstAdapter,
  CodeQualityAnalyzer,
  ComplexityAnalyzer,
  DependencyAnalyzer,
  DocumentationAnalyzer,
  EvidenceEngine,
  ExplanationEngine,
  FindingRelationshipEngine,
  IntendedBehaviourEngine,
  KnowledgeEngine,
  MetricsEngine,
  OfficialReferenceResolver,
  PerformanceAnalyzer,
  PriorityActionEngine,
  ProjectHealthScorer,
  ProjectReportBuilder,
  ProjectScanner,
  RecommendationEngine,
  RuleEngine,
  ScoringEngine,
  StateManagementAnalyzer,
  TechnicalDebtEngine,
  TestingAnalyzer,
} from '../analysis/index.js';
import type { AppConfig } from '../config/schema.js';
import { RepositoryIndexer, type Indexer } from '../indexer/index.js';
import {
  DartAnalyzerClient,
  HeuristicSymbolExtractor,
  type SymbolExtractor,
} from '../parser/index.js';
import { SUPPORTED_REPOSITORIES } from '../repository/definitions.js';
import { KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import { GitRepositoryManager } from '../repository/repository-manager.js';
import type { RepositoryDefinition, RepositoryManager } from '../repository/types.js';
import {
  FilesystemSearchEngine,
  IndexedSearchEngine,
  SearchService,
  type SearchEngine,
} from '../search/index.js';
import { createSqliteKnowledgeStore, type KnowledgeStore } from '../store/index.js';
import {
  AnalyzeArchitectureHandler,
  AnalyzeCodeQualityHandler,
  AnalyzeStateManagementHandler,
  AnalyzeComplexityHandler,
  AnalyzeDocumentationHandler,
  AnalyzeTestingHandler,
  AnalyzeDependenciesHandler,
  AnalyzePerformanceHandler,
  AnalyzeAccessibilityHandler,
  CheckEnvironmentHandler,
  ExplainFindingHandler,
  ExplainWidgetHandler,
  ExploreFindingHandler,
  FindBestPracticeHandler,
  FindExamplesHandler,
  FindIntendedBehaviorHandler,
  FindTestsHandler,
  FindWidgetHandler,
  ReindexHandler,
  RepositoryStatusHandler,
  ReviewProjectHandler,
  SearchDocsHandler,
  SearchSourceHandler,
  TraceWidgetHandler,
  UpdateRepositoriesHandler,
} from '../tools/index.js';
import type { Logger } from '../types/logger.js';
import { TYPES } from '../types/tokens.js';
import { StructuredLogger } from '../utils/logger.js';

export interface CreateContainerOptions {
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly repositories?: readonly RepositoryDefinition[];
  readonly parent?: DependencyContainer;
  readonly store?: KnowledgeStore;
  readonly extractor?: SymbolExtractor;
}

export function createContainer(options: CreateContainerOptions): DependencyContainer {
  const child = (options.parent ?? container).createChildContainer();

  child.registerInstance<AppConfig>(TYPES.Config, options.config);
  child.registerInstance<Logger>(TYPES.Logger, options.logger ?? new StructuredLogger());
  child.registerInstance<readonly RepositoryDefinition[]>(
    TYPES.RepositoryDefinitions,
    options.repositories ?? SUPPORTED_REPOSITORIES,
  );

  const store = options.store ?? createSqliteKnowledgeStore(options.config.indexPath);
  child.registerInstance<KnowledgeStore>(TYPES.KnowledgeStore, store);

  const extractor = options.extractor ?? new HeuristicSymbolExtractor();
  child.registerInstance<SymbolExtractor>(TYPES.SymbolExtractor, extractor);

  child.registerSingleton(TYPES.DartAnalyzerClient, DartAnalyzerClient);
  child.registerSingleton(TYPES.AstAdapter, AstAdapter);
  child.registerSingleton(TYPES.OfficialReferenceResolver, OfficialReferenceResolver);
  child.registerSingleton(TYPES.ProjectScanner, ProjectScanner);
  child.registerSingleton(TYPES.CodeQualityAnalyzer, CodeQualityAnalyzer);
  child.registerSingleton(TYPES.StateManagementAnalyzer, StateManagementAnalyzer);
  child.registerSingleton(TYPES.ArchitectureAnalyzer, ArchitectureAnalyzer);
  child.registerSingleton(TYPES.ComplexityAnalyzer, ComplexityAnalyzer);
  child.registerSingleton(TYPES.TestingAnalyzer, TestingAnalyzer);
  child.registerSingleton(TYPES.DependencyAnalyzer, DependencyAnalyzer);
  child.registerSingleton(TYPES.PerformanceAnalyzer, PerformanceAnalyzer);
  child.registerSingleton(TYPES.DocumentationAnalyzer, DocumentationAnalyzer);
  child.registerSingleton(TYPES.AccessibilityAnalyzer, AccessibilityAnalyzer);
  child.registerSingleton(TYPES.ArchitectureMatchEngine, ArchitectureMatchEngine);
  child.registerSingleton(TYPES.MetricsEngine, MetricsEngine);
  child.registerSingleton(TYPES.EvidenceEngine, EvidenceEngine);
  child.registerSingleton(TYPES.KnowledgeEngine, KnowledgeEngine);
  child.registerSingleton(TYPES.ScoringEngine, ScoringEngine);
  child.registerSingleton(TYPES.TechnicalDebtEngine, TechnicalDebtEngine);
  child.registerSingleton(TYPES.FindingRelationshipEngine, FindingRelationshipEngine);
  child.registerSingleton(TYPES.IntendedBehaviourEngine, IntendedBehaviourEngine);
  child.registerSingleton(TYPES.PriorityActionEngine, PriorityActionEngine);
  child.registerSingleton(TYPES.ExplanationEngine, ExplanationEngine);
  child.registerSingleton(TYPES.RecommendationEngine, RecommendationEngine);
  child.registerSingleton(TYPES.ProjectHealthScorer, ProjectHealthScorer);
  child.registerSingleton(TYPES.RuleEngine, RuleEngine);
  child.registerSingleton(TYPES.ProjectReportBuilder, ProjectReportBuilder);
  child.registerSingleton(TYPES.AnalysisSessionStore, AnalysisSessionStore);

  child.registerSingleton<RepositoryManager>(TYPES.RepositoryManager, GitRepositoryManager);
  child.registerSingleton(TYPES.KnowledgeBaseReadinessChecker, KnowledgeBaseReadinessChecker);

  child.register<Indexer>(TYPES.Indexer, {
    useClass: RepositoryIndexer,
  });

  child.register<SearchEngine>(TYPES.FilesystemSearchEngine, {
    useClass: FilesystemSearchEngine,
  });

  child.register<SearchEngine>(TYPES.SearchEngine, {
    useClass: IndexedSearchEngine,
  });

  child.registerSingleton(TYPES.SearchService, SearchService);
  child.registerSingleton(TYPES.UpdateRepositoriesHandler, UpdateRepositoriesHandler);
  child.registerSingleton(TYPES.RepositoryStatusHandler, RepositoryStatusHandler);
  child.registerSingleton(TYPES.SearchSourceHandler, SearchSourceHandler);
  child.registerSingleton(TYPES.FindWidgetHandler, FindWidgetHandler);
  child.registerSingleton(TYPES.ReindexHandler, ReindexHandler);
  child.registerSingleton(TYPES.ExplainWidgetHandler, ExplainWidgetHandler);
  child.registerSingleton(TYPES.SearchDocsHandler, SearchDocsHandler);
  child.registerSingleton(TYPES.FindExamplesHandler, FindExamplesHandler);
  child.registerSingleton(TYPES.FindTestsHandler, FindTestsHandler);
  child.registerSingleton(TYPES.TraceWidgetHandler, TraceWidgetHandler);
  child.registerSingleton(TYPES.FindBestPracticeHandler, FindBestPracticeHandler);
  child.registerSingleton(TYPES.ReviewProjectHandler, ReviewProjectHandler);
  child.registerSingleton(TYPES.FindIntendedBehaviorHandler, FindIntendedBehaviorHandler);
  child.registerSingleton(TYPES.AnalyzeCodeQualityHandler, AnalyzeCodeQualityHandler);
  child.registerSingleton(TYPES.AnalyzeStateManagementHandler, AnalyzeStateManagementHandler);
  child.registerSingleton(TYPES.AnalyzeArchitectureHandler, AnalyzeArchitectureHandler);
  child.registerSingleton(TYPES.ExplainFindingHandler, ExplainFindingHandler);
  child.registerSingleton(TYPES.ExploreFindingHandler, ExploreFindingHandler);
  child.registerSingleton(TYPES.AnalyzeComplexityHandler, AnalyzeComplexityHandler);
  child.registerSingleton(TYPES.AnalyzeDocumentationHandler, AnalyzeDocumentationHandler);
  child.registerSingleton(TYPES.AnalyzeTestingHandler, AnalyzeTestingHandler);
  child.registerSingleton(TYPES.AnalyzeDependenciesHandler, AnalyzeDependenciesHandler);
  child.registerSingleton(TYPES.AnalyzePerformanceHandler, AnalyzePerformanceHandler);
  child.registerSingleton(TYPES.AnalyzeAccessibilityHandler, AnalyzeAccessibilityHandler);
  child.registerSingleton(TYPES.CheckEnvironmentHandler, CheckEnvironmentHandler);

  return child;
}
