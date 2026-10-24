export type InferredSemanticType =
  | 'identifier'
  | 'numeric_clean'
  | 'numeric_dirty'
  | 'date_clean'
  | 'date_dirty'
  | 'categorical'
  | 'text';

export interface DirtyTokenSummary {
  nullOrEmptyCount: number;
  sentinelTokens: Record<string, number>;
  whitespacePaddedCount: number;
  currencyFormattedCount: number;
  commaFormattedCount: number;
  percentFormattedCount: number;
  invalidDateCount: number;
  totalDirtyCount: number;
  dirtyRate: number;
}

export interface NumericColumnSummary {
  validCount: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

export interface CategoryFrequencyItem {
  value: string;
  count: number;
  percentage: number;
}

export interface ColumnProfile {
  columnName: string; // Sanitized SQLite identifier
  sourceHeader: string; // Original header preserved
  sqliteDeclaredType: 'TEXT' | 'REAL' | 'INTEGER';
  inferredType: InferredSemanticType;
  totalRows: number;
  nonEmptyCount: number;
  nullRate: number;
  distinctCount: number;
  isCandidatePrimaryKey: boolean;
  sampleCleanValues: string[];
  sampleDirtyValues: string[];
  dirtyProfile: DirtyTokenSummary;
  numericStats?: NumericColumnSummary;
  topCategories?: CategoryFrequencyItem[];
  warnings: string[];
  defensiveSqlExpression: string;
}

export interface ForeignKeyCandidate {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  matchRatio: number;
  requiresTrimJoin: boolean;
}

export interface TableProfile {
  tableName: string;
  sourceFileName: string;
  rowCount: number;
  duplicateRowCount: number;
  columns: ColumnProfile[];
  warnings: string[];
  sampleRows: Record<string, string | number | null>[];
}

export type DatasetFormatType =
  | 'csv'
  | 'excel'
  | 'sqlite'
  | 'sql'
  | 'json'
  | 'sample';

export interface DatasetSummaryItem {
  datasetId: string;
  datasetLabel: string;
  format: DatasetFormatType;
  fileNames: string[];
  tableCount: number;
  totalRows: number;
  uploadedAt: string;
  isDefaultSample?: boolean;
}

export interface WorkspaceSchemaState {
  datasetId: string;
  datasetLabel: string;
  format: DatasetFormatType;
  fileNames: string[];
  tables: TableProfile[];
  foreignKeys: ForeignKeyCandidate[];
  ingestedAt: string;
  availableDatasets?: DatasetSummaryItem[];
}

export type QueryIntentStatus =
  | 'answerable'
  | 'ambiguous'
  | 'unanswerable'
  | 'destructive_blocked'
  | 'execution_failed';

export type PipelineErrorCategory =
  | 'none'
  | 'generation_error'
  | 'execution_error'
  | 'verification_defect'
  | 'security_blocked'
  | 'abstention'
  | 'ambiguous';

export interface SemanticColumnMatch {
  userConcept: string;
  matchedTable: string;
  matchedColumn: string;
  scaleDirection:
    | 'higher_is_better'
    | 'lower_is_better'
    | 'categorical_meaning'
    | 'neutral';
  interpretationNote: string;
}

export interface Agent1Decomposition {
  status: 'answerable' | 'ambiguous' | 'unanswerable' | 'destructive_blocked';
  reasoning: string;
  targetMetrics: string[];
  groupingDimensions: string[];
  temporalBoundaries: string[];
  filters: string[];
  requiredTables: string[];
  referencedColumns: string[];
  expectedAggregations: string[];
  requiresJoin: boolean;
  requiresTopN: boolean;
  semanticMappings?: SemanticColumnMatch[];
  availableIndicators?: string[];
  missingContextFactors?: string[];
  inferredThresholdOrRule?: string;
  isSensitiveDecision?: boolean;
  sensitiveDecisionTopic?: string;
  clarificationPrompt?: string;
  clarificationOptions?: string[];
  abstentionReason?: string;
  suggestedAlternatives?: string[];
}

export interface QuestionPlan {
  primaryObjective: string;
  tablesInvolved: string[];
  joinStrategy: string;
  defensiveCleaningRules: string[];
  aggregationAndOrdering: string;
  readOnlyConstraintChecked: boolean;
}

export interface RepairAttempt {
  attemptNumber: number;
  generatedSql: string;
  succeeded: boolean;
  errorType?:
    | 'security_blocked'
    | 'sqlite_error'
    | 'generation_error'
    | 'verification_defect';
  errorMessage?: string;
  rootCauseDiagnosis?: string;
  latencyMs: number;
}

export interface VerificationCheckItem {
  level: 'Structural' | 'Intent' | 'Data Quality' | 'Explanation';
  passed: boolean;
  summary: string;
  details: string[];
}

export interface VerificationMatrix {
  overallPassed: boolean;
  structural: VerificationCheckItem;
  intent: VerificationCheckItem;
  dataQuality: VerificationCheckItem;
  explanation: VerificationCheckItem;
}

export interface VerifiedFigure {
  label: string;
  value: string;
  sourceColumn: string;
}

export interface Agent1Explanation {
  directTakeaway: string;
  analyticalCriteriaUsed?: string;
  recordReasoning?: string[];
  missingInformation?: string[];
  assumptionsAndLimitations?: string[];
  sensitiveDecisionDisclaimer?: string;
  verifiedFigures: VerifiedFigure[];
  dataQualityDisclosures: string[];
}

export interface SqlExecutionOutput {
  columns: string[];
  rows: Record<string, string | number | null>[];
  rowCount: number;
  totalMatchedRows?: number;
  truncated?: boolean;
  executionLatencyMs: number;
}

export interface PipelineQueryResponse {
  question: string;
  datasetId?: string;
  datasetLabel?: string;
  status: QueryIntentStatus;
  errorCategory: PipelineErrorCategory;
  errorMessage?: string;
  totalLatencyMs: number;
  agent1Decomposition: Agent1Decomposition;
  questionPlan?: QuestionPlan;
  finalSql?: string;
  repairAttempts: RepairAttempt[];
  autoRepairsCount: number;
  executionOutput?: SqlExecutionOutput;
  agent1Explanation?: Agent1Explanation;
  verificationMatrix: VerificationMatrix;
}

export interface QueryHistoryEntry {
  id: string;
  timestamp: string;
  datasetId: string;
  datasetLabel: string;
  question: string;
  response: PipelineQueryResponse;
}
