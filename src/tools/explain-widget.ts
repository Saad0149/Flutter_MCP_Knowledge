import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { KnowledgeBaseNotice, KnowledgeBaseReadinessChecker } from '../repository/knowledge-base-readiness.js';
import type { KnowledgeStore } from '../store/types.js';
import { TYPES } from '../types/tokens.js';
import { toolFail, toolOk, type ToolResult } from './tool-result.js';

export const ExplainWidgetInputSchema = z.object({
  name: z.string().min(1).max(200).describe('Widget class name'),
  repository: z.string().min(1).max(200).optional(),
});

export type ExplainWidgetInput = z.infer<typeof ExplainWidgetInputSchema>;

export interface ExplainWidgetData {
  readonly widget: string;
  readonly found: boolean;
  readonly file: string | null;
  readonly line: number | null;
  readonly package: string | null;
  readonly kind: string | null;
  readonly extendsClause: string | null;
  readonly withClause: string | null;
  readonly implementsClause: string | null;
  readonly documentation: string | null;
  readonly repository: string | null;
  readonly knowledgeBase?: KnowledgeBaseNotice;
}

@injectable()
export class ExplainWidgetHandler {
  constructor(
    @inject(TYPES.KnowledgeStore) private readonly store: KnowledgeStore,
    @inject(TYPES.KnowledgeBaseReadinessChecker)
    private readonly readiness?: KnowledgeBaseReadinessChecker,
  ) {}

  async execute(input: ExplainWidgetInput): Promise<ToolResult<ExplainWidgetData>> {
    try {
      const parsed = ExplainWidgetInputSchema.safeParse(input);
      if (!parsed.success) {
        return toolFail({
          code: 'InvalidArguments',
          message: 'Invalid arguments for explain_widget',
          details: parsed.error.flatten(),
        });
      }

      const name = parsed.data.name.trim();
      const repository = parsed.data.repository ?? 'flutter/flutter';

      const readiness = await this.readiness?.check();
      if (readiness?.state === 'building') {
        return toolOk({
          widget: name,
          found: false,
          file: null,
          line: null,
          package: null,
          kind: null,
          extendsClause: null,
          withClause: null,
          implementsClause: null,
          documentation: null,
          repository: null,
          knowledgeBase: readiness.notice,
        });
      }
      const knowledgeBase = readiness?.state === 'degraded' ? readiness.notice : undefined;

      const hit =
        this.store.getSymbolByName(name, { isWidget: true, repositoryName: repository }) ??
        this.store.getSymbolByName(name, { repositoryName: repository }) ??
        this.store.getSymbolByName(name, { isWidget: true }) ??
        this.store.getSymbolByName(name);

      if (!hit) {
        return toolOk({
          widget: name,
          found: false,
          file: null,
          line: null,
          package: null,
          kind: null,
          extendsClause: null,
          withClause: null,
          implementsClause: null,
          documentation: null,
          repository: null,
          knowledgeBase,
        });
      }

      return toolOk({
        widget: name,
        found: true,
        file: hit.filePath,
        line: hit.line,
        package: hit.packageName,
        kind: hit.kind,
        knowledgeBase,
        extendsClause: hit.extendsClause,
        withClause: hit.withClause,
        implementsClause: hit.implementsClause,
        documentation: hit.docstring,
        repository: hit.repositoryName,
      });
    } catch (error) {
      return toolFail(error);
    }
  }
}
