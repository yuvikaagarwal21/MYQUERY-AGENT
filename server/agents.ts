import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type GenerateContentConfig,
} from '@google/genai';
import type { Database } from 'sql.js';
import type {
  Agent1Decomposition,
  Agent1Explanation,
  PipelineErrorCategory,
  PipelineQueryResponse,
  QuestionPlan,
  RepairAttempt,
  SqlExecutionOutput,
  VerificationMatrix,
  WorkspaceSchemaState,
} from '../src/types/domain.ts';
import {
  detectDestructivePromptIntent,
  executeSandboxedQuery,
} from './sqliteSandbox.ts';
import {
  buildSkippedVerificationMatrix,
  verifyDataQuality,
  verifyExplanation,
  verifyIntent,
  verifyStructural,
} from './verifier.ts';

const PRIMARY_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_GEMINI_MODEL = 'gemini-3.8-flash';
const MAX_REPAIR_ATTEMPTS = 3;

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is missing from the server environment. Configure it in Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 18000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateStructuredJson<T>(
  ai: GoogleGenAI,
  contents: string,
  config: GenerateContentConfig
): Promise<T> {
  const candidates: {
    model: string;
    extraConfig?: Partial<GenerateContentConfig>;
  }[] = [
    { model: PRIMARY_GEMINI_MODEL },
    { model: PRIMARY_GEMINI_MODEL },
    {
      model: FALLBACK_GEMINI_MODEL,
      extraConfig: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
    },
  ];

  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const response = await ai.models.generateContent({
        model: candidate.model,
        contents,
        config: {
          ...config,
          ...(candidate.extraConfig || {}),
        },
      });
      const rawText = (response.text || '').trim();
      if (!rawText) {
        throw new Error('Model returned an empty response body.');
      }
      return JSON.parse(rawText) as T;
    } catch (err: unknown) {
      lastErr = err;
    }
  }

  const rawMsg =
    lastErr instanceof Error ? lastErr.message : 'Gemini API request failed.';
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(rawMsg)) {
    throw new Error(
      'AI model rate limit reached (HTTP 429). Please wait a few seconds and retry.'
    );
  }
  if (/503|UNAVAILABLE/i.test(rawMsg)) {
    throw new Error(
      'AI model service is temporarily overloaded (HTTP 503). Please retry shortly.'
    );
  }
  throw new Error(`AI generation error: ${rawMsg}`);
}

export function formatSchemaContextForPrompt(
  schemaState: WorkspaceSchemaState
): string {
  const lines: string[] = [
    `Dataset: ${schemaState.datasetLabel} (Format: ${schemaState.format})`,
    `Tables Loaded: ${schemaState.tables.length}`,
    '',
  ];

  for (const table of schemaState.tables) {
    lines.push(
      `TABLE "${table.tableName}" (Source: ${table.sourceFileName}, Total Rows: ${table.rowCount}, Exact Duplicate Rows: ${table.duplicateRowCount}):`
    );
    for (const col of table.columns) {
      const sentinels = Object.entries(col.dirtyProfile.sentinelTokens)
        .map(([tok, cnt]) => `${tok}(${cnt})`)
        .join(', ');
      lines.push(
        `  - Column "${col.columnName}" [Original Header: "${col.sourceHeader}"] | SQLite Type: ${col.sqliteDeclaredType} | Semantic: ${col.inferredType}${col.isCandidatePrimaryKey ? ' | CANDIDATE PK' : ''}`
      );
      lines.push(
        `    Distinct Clean: ${col.distinctCount} | Null/Empty: ${col.dirtyProfile.nullOrEmptyCount} (${col.nullRate}%) | Dirty Rows: ${col.dirtyProfile.totalDirtyCount} (${col.dirtyProfile.dirtyRate}%)`
      );
      if (col.numericStats) {
        lines.push(
          `    Numeric Stats (clean): min=${col.numericStats.min}, max=${col.numericStats.max}, mean=${col.numericStats.mean}, median=${col.numericStats.median}`
        );
      }
      if (
        sentinels ||
        col.dirtyProfile.whitespacePaddedCount > 0 ||
        col.dirtyProfile.currencyFormattedCount > 0 ||
        col.dirtyProfile.commaFormattedCount > 0 ||
        col.dirtyProfile.invalidDateCount > 0
      ) {
        lines.push(
          `    Anomalies -> Sentinel Tokens: [${sentinels || 'none'}], Whitespace-padded: ${col.dirtyProfile.whitespacePaddedCount}, Currency($): ${col.dirtyProfile.currencyFormattedCount}, Commas(,): ${col.dirtyProfile.commaFormattedCount}, Percent(%): ${col.dirtyProfile.percentFormattedCount}, Invalid Dates: ${col.dirtyProfile.invalidDateCount}`
        );
      }
      lines.push(
        `    Sample Clean: [${col.sampleCleanValues.join(', ')}] | Sample Dirty: [${col.sampleDirtyValues.join(', ')}]`
      );
      lines.push(`    Defensive SQLite Expression: ${col.defensiveSqlExpression}`);
    }
    lines.push('');
  }

  if (schemaState.foreignKeys.length > 0) {
    lines.push('CANDIDATE FOREIGN KEY RELATIONSHIPS:');
    for (const fk of schemaState.foreignKeys) {
      lines.push(
        `  - "${fk.fromTable}"."${fk.fromColumn}" -> "${fk.toTable}"."${fk.toColumn}" (${fk.matchRatio}% key overlap${fk.requiresTrimJoin ? '; REQUIRES ON TRIM(UPPER(a.col)) = TRIM(UPPER(b.col)) due to whitespace padding!' : ''})`
      );
    }
  } else if (schemaState.tables.length > 1) {
    lines.push(
      'NOTE: Multiple tables are loaded, but no foreign key overlap >= 70% was detected. Only join tables if explicitly requested and matching columns exist.'
    );
  }

  return lines.join('\n');
}

function buildDynamicFallbackAlternatives(
  schemaState: WorkspaceSchemaState
): string[] {
  const suggestions: string[] = [];
  const firstTable = schemaState.tables[0];
  if (!firstTable) return suggestions;

  suggestions.push(`How many total rows are in ${firstTable.tableName}?`);

  const numCol = firstTable.columns.find(
    (c) =>
      c.inferredType === 'numeric_clean' || c.inferredType === 'numeric_dirty'
  );
  const catCol = firstTable.columns.find(
    (c) => c.inferredType === 'categorical' || c.inferredType === 'text'
  );

  if (numCol && catCol) {
    suggestions.push(
      `What is the total and average ${numCol.columnName} grouped by ${catCol.columnName} in ${firstTable.tableName}?`
    );
  } else if (numCol) {
    suggestions.push(
      `What are the minimum, maximum, and average values of ${numCol.columnName} in ${firstTable.tableName}?`
    );
  }

  suggestions.push(
    `Show the first 10 records from ${firstTable.tableName}.`
  );
  return suggestions.slice(0, 3);
}

async function runAgent1Decomposition(
  ai: GoogleGenAI,
  question: string,
  schemaPrompt: string,
  schemaState: WorkspaceSchemaState
): Promise<Agent1Decomposition> {
  const systemInstruction = `You are Agent 1 (Conversational Intent & Schema Grounding Agent) in a Two-Agent Text-to-SQL system.
Inspect the user's natural language question strictly against the ACTUAL uploaded SQLite database schema and data profile. Never assume hardcoded tables or columns!

Classification Rules:
1. "destructive_blocked": If the question attempts SQL injection (e.g., "; DROP TABLE", "UNION SELECT" exploit) or asks to mutate/delete/drop/update/insert database rows or tables.
2. "unanswerable": If the question asks for metrics, attributes, columns, tables, or external facts that DO NOT EXIST in the currently uploaded dataset. NEVER guess or map unrelated columns. Explain clearly in abstentionReason which missing column/table makes the question unanswerable, and provide 2-3 helpful suggestedAlternatives using ONLY real columns present in the uploaded schema.
3. "ambiguous": ONLY if the question is genuinely underspecified with multiple conflicting interpretations across existing columns and lacks a clear analytical meaning (for example: "Show me the best performers recently" where neither entity, metric, nor timeframe is defined). Provide a concise clarificationPrompt and 3 concrete clarificationOptions grounded strictly in the actual uploaded tables and columns.
   - Standard analytical questions (counts, averages, sums, top-N rankings, grouping by category, finding missing/duplicate values, filtering by date, joining related tables) are CLEAR and "answerable" — do NOT mark clear analytical questions as ambiguous!
4. "answerable": Decompose into targetMetrics, groupingDimensions, temporalBoundaries, filters, requiredTables, referencedColumns (using sanitized SQLite column names), expectedAggregations (subset of SUM, AVG, COUNT, MIN, MAX — empty array if row listing), requiresJoin (boolean), and requiresTopN (boolean, true ONLY when asking for top N / highest N / bottom N with a limit).`;

  const parsed = await generateStructuredJson<Agent1Decomposition>(
    ai,
    `ACTUAL UPLOADED DATABASE SCHEMA & PROFILE:\n${schemaPrompt}\n\nUSER QUESTION:\n${question}`,
    {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          status: {
            type: Type.STRING,
            description:
              'One of: answerable, ambiguous, unanswerable, destructive_blocked',
          },
          reasoning: {
            type: Type.STRING,
          },
          targetMetrics: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          groupingDimensions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          temporalBoundaries: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          filters: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          requiredTables: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          referencedColumns: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          expectedAggregations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          requiresJoin: { type: Type.BOOLEAN },
          requiresTopN: { type: Type.BOOLEAN },
          clarificationPrompt: { type: Type.STRING },
          clarificationOptions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          abstentionReason: { type: Type.STRING },
          suggestedAlternatives: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          'status',
          'reasoning',
          'targetMetrics',
          'groupingDimensions',
          'temporalBoundaries',
          'filters',
          'requiredTables',
          'referencedColumns',
          'expectedAggregations',
          'requiresJoin',
          'requiresTopN',
        ],
      },
    }
  );

  const validStatuses = new Set([
    'answerable',
    'ambiguous',
    'unanswerable',
    'destructive_blocked',
  ]);
  if (!validStatuses.has(parsed.status)) {
    parsed.status = 'answerable';
  }

  if (
    parsed.status === 'unanswerable' &&
    (!parsed.suggestedAlternatives || parsed.suggestedAlternatives.length === 0)
  ) {
    parsed.suggestedAlternatives = buildDynamicFallbackAlternatives(schemaState);
  }

  return parsed;
}

async function generateInitialSqlAndPlan(
  ai: GoogleGenAI,
  question: string,
  decomposition: Agent1Decomposition,
  schemaPrompt: string
): Promise<{ questionPlan: QuestionPlan; sql: string }> {
  const systemInstruction = `You are Agent 2 (SQLite Analyst & Defensive Data Cleaning Agent).
Given the actual uploaded database schema, data-quality profile, and Agent 1's decomposition, construct a QuestionPlan and a single read-only SQLite SELECT (or WITH ... SELECT) query.

CRITICAL SQLITE & DATA ACCURACY RULES:
1. Use ONLY exact SQLite table and column names from the provided schema (double-quote identifiers if needed, e.g. "column_name"). NEVER invent table or column names!
2. NEVER write multi-statement SQL or destructive commands (SELECT / WITH only).
3. DEFENSIVE NUMERIC CLEANING: In SQLite, CAST('UNKNOWN' AS REAL) silently evaluates to 0.0, corrupting AVG(), MIN(), and COUNT()!
   Whenever aggregating, filtering, or sorting a numeric_dirty column (containing $, commas, %, or sentinel tokens like UNKNOWN, ERROR, N/A, NULL, empty string), ALWAYS use its Defensive SQLite Expression from the schema:
   CASE WHEN "col" IS NULL OR UPPER(TRIM("col")) IN ('', 'UNKNOWN', 'ERROR', 'N/A', 'NA', 'NULL', 'NONE', 'TBD', '-') THEN NULL ELSE CAST(TRIM(REPLACE(REPLACE(TRIM("col"), '$', ''), ',', '')) AS REAL) END
4. DEFENSIVE WHITESPACE & CASE CLEANING:
   - When joining tables on string IDs with whitespace padding, join using TRIM: ON TRIM(a."col") = TRIM(b."col").
   - Prevent duplicate fan-out counts when joining 1-to-many tables: use COUNT(DISTINCT ...) for parent entity counts or pre-aggregate child metrics in a CTE before joining!
   - When filtering or grouping categorical columns with mixed case or whitespace, normalize with UPPER(TRIM("col")) or TRIM("col").
   - Exclude dirty sentinel categories ('UNKNOWN', 'ERROR', 'N/A') when grouping by category UNLESS the user explicitly asks about missing/dirty/invalid values.
5. DEFENSIVE DATE CLEANING:
   - Guard against malformed dates (like '2024/13/45' or 'TBD') using TRIM("col") GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND SUBSTR(TRIM("col"), 6, 2) BETWEEN '01' AND '12' AND SUBSTR(TRIM("col"), 9, 2) BETWEEN '01' AND '31'.
6. Round floating-point aggregations cleanly with ROUND(..., 2) and give clear alias names.`;

  return generateStructuredJson<{
    questionPlan: QuestionPlan;
    sql: string;
  }>(
    ai,
    `ACTUAL SCHEMA & DATA PROFILE:\n${schemaPrompt}\n\nUSER QUESTION:\n${question}\n\nAGENT 1 DECOMPOSITION:\n${JSON.stringify(decomposition, null, 2)}`,
    {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          questionPlan: {
            type: Type.OBJECT,
            properties: {
              primaryObjective: { type: Type.STRING },
              tablesInvolved: { type: Type.ARRAY, items: { type: Type.STRING } },
              joinStrategy: { type: Type.STRING },
              defensiveCleaningRules: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              aggregationAndOrdering: { type: Type.STRING },
              readOnlyConstraintChecked: { type: Type.BOOLEAN },
            },
            required: [
              'primaryObjective',
              'tablesInvolved',
              'joinStrategy',
              'defensiveCleaningRules',
              'aggregationAndOrdering',
              'readOnlyConstraintChecked',
            ],
          },
          sql: {
            type: Type.STRING,
            description: 'Single read-only SQLite SELECT or WITH query.',
          },
        },
        required: ['questionPlan', 'sql'],
      },
    }
  );
}

async function repairSqlQuery(
  ai: GoogleGenAI,
  question: string,
  decomposition: Agent1Decomposition,
  schemaPrompt: string,
  previousSql: string,
  failureMessage: string,
  attemptNumber: number
): Promise<{ rootCauseDiagnosis: string; correctedSql: string }> {
  const systemInstruction = `You are Agent 2's Bounded Self-Repair Module (Attempt ${attemptNumber} of ${MAX_REPAIR_ATTEMPTS}).
A previous SQLite query failed compilation, execution, or verification against the uploaded dataset.
Diagnose the exact root cause in 1 concise sentence, and produce a corrected, single-statement, read-only SQLite SELECT query using ONLY real tables and columns from the schema.`;

  return generateStructuredJson<{
    rootCauseDiagnosis: string;
    correctedSql: string;
  }>(
    ai,
    `ACTUAL SCHEMA & DATA PROFILE:\n${schemaPrompt}\n\nUSER QUESTION:\n${question}\n\nAGENT 1 DECOMPOSITION:\n${JSON.stringify(decomposition)}\n\nFAILED SQL:\n${previousSql}\n\nERROR / VERIFICATION FAILURE:\n${failureMessage}`,
    {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          rootCauseDiagnosis: { type: Type.STRING },
          correctedSql: { type: Type.STRING },
        },
        required: ['rootCauseDiagnosis', 'correctedSql'],
      },
    }
  );
}

async function runAgent1Explanation(
  ai: GoogleGenAI,
  question: string,
  finalSql: string,
  output: SqlExecutionOutput,
  schemaPrompt: string
): Promise<Agent1Explanation> {
  const systemInstruction = `You are Agent 1 (Conversational Explainer & Data Quality Auditor).
Explain the verified SQL query result to the user with strict numerical accuracy.

STRICT GROUNDING RULES:
1. directTakeaway: 1-2 crisp, direct sentences answering the user's question using ONLY exact values present in the SQL QUERY RESULT ROWS (or stating clearly if 0 rows matched). Never invent, extrapolate, or alter numbers!
2. verifiedFigures: Extract key metrics directly from the returned rows, recording { label, value, sourceColumn }. Every value MUST match a cell in the SQL result rows (or rowCount).
3. dataQualityDisclosures: Disclose any relevant data-quality handling on the queried columns (e.g., excluded NULL/dirty sentinel tokens, trimmed whitespace, or duplicate rows in the table).`;

  // Cap rows sent to LLM explanation to 40 rows so large outputs never overflow prompt context
  const previewRows = output.rows.slice(0, 40);

  return generateStructuredJson<Agent1Explanation>(
    ai,
    `USER QUESTION:\n${question}\n\nEXECUTED VERIFIED SQL:\n${finalSql}\n\nSQL QUERY RESULT (Total Matched Rows: ${output.totalMatchedRows ?? output.rowCount}, Showing ${previewRows.length} rows):\n${JSON.stringify(previewRows, null, 2)}\n\nSCHEMA & DATA PROFILE:\n${schemaPrompt}`,
    {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          directTakeaway: { type: Type.STRING },
          verifiedFigures: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.STRING },
                sourceColumn: { type: Type.STRING },
              },
              required: ['label', 'value', 'sourceColumn'],
            },
          },
          dataQualityDisclosures: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['directTakeaway', 'verifiedFigures', 'dataQualityDisclosures'],
      },
    }
  );
}

export interface ExecutePipelineOptions {
  injectFaultDemo?: boolean;
}

export async function runTwoAgentPipeline(
  db: Database,
  schemaState: WorkspaceSchemaState,
  rawQuestion: string,
  options: ExecutePipelineOptions = {}
): Promise<PipelineQueryResponse> {
  const pipelineStart = performance.now();
  const question = rawQuestion.trim();

  if (!schemaState.tables || schemaState.tables.length === 0) {
    throw new Error(
      'The selected dataset contains no tables. Please upload a valid dataset first.'
    );
  }

  // Step 0: Deterministic Pre-Screen for SQL Injection / Destructive Commands
  const destructivePreCheck = detectDestructivePromptIntent(question);
  if (destructivePreCheck.isDestructive) {
    const sandboxAttempt = executeSandboxedQuery(db, question);
    const blockReason =
      destructivePreCheck.reason ||
      (!sandboxAttempt.ok
        ? sandboxAttempt.errorMessage
        : 'Blocked by Read-Only Sandbox.');
    const elapsed = Math.max(1, Math.round(performance.now() - pipelineStart));

    return {
      question,
      datasetId: schemaState.datasetId,
      datasetLabel: schemaState.datasetLabel,
      status: 'destructive_blocked',
      errorCategory: 'security_blocked',
      errorMessage: blockReason,
      totalLatencyMs: elapsed,
      agent1Decomposition: {
        status: 'destructive_blocked',
        reasoning: blockReason,
        targetMetrics: [],
        groupingDimensions: [],
        temporalBoundaries: [],
        filters: [],
        requiredTables: [],
        referencedColumns: [],
        expectedAggregations: [],
        requiresJoin: false,
        requiresTopN: false,
        abstentionReason: blockReason,
      },
      repairAttempts: [
        {
          attemptNumber: 1,
          generatedSql: question,
          succeeded: false,
          errorType: 'security_blocked',
          errorMessage: blockReason,
          rootCauseDiagnosis:
            'Destructive DDL/DML or multi-statement injection blocked permanently.',
          latencyMs: elapsed,
        },
      ],
      autoRepairsCount: 0,
      verificationMatrix: buildSkippedVerificationMatrix(
        'destructive_blocked',
        blockReason
      ),
    };
  }

  const ai = getGenAIClient();
  const schemaPrompt = formatSchemaContextForPrompt(schemaState);

  // Step 1: Agent 1 — Natural Language Decomposition & Ambiguity/Abstention Detection
  const decomposition = await runAgent1Decomposition(
    ai,
    question,
    schemaPrompt,
    schemaState
  );

  if (decomposition.status === 'destructive_blocked') {
    const reason =
      decomposition.abstentionReason ||
      decomposition.reasoning ||
      'Mutating query blocked by Read-Only policy.';
    const elapsed = Math.max(1, Math.round(performance.now() - pipelineStart));
    return {
      question,
      datasetId: schemaState.datasetId,
      datasetLabel: schemaState.datasetLabel,
      status: 'destructive_blocked',
      errorCategory: 'security_blocked',
      errorMessage: reason,
      totalLatencyMs: elapsed,
      agent1Decomposition: decomposition,
      repairAttempts: [],
      autoRepairsCount: 0,
      verificationMatrix: buildSkippedVerificationMatrix(
        'destructive_blocked',
        reason
      ),
    };
  }

  if (decomposition.status === 'ambiguous') {
    const elapsed = Math.max(1, Math.round(performance.now() - pipelineStart));
    const dynamicOptions =
      decomposition.clarificationOptions &&
      decomposition.clarificationOptions.length > 0
        ? decomposition.clarificationOptions
        : buildDynamicFallbackAlternatives(schemaState);

    return {
      question,
      datasetId: schemaState.datasetId,
      datasetLabel: schemaState.datasetLabel,
      status: 'ambiguous',
      errorCategory: 'ambiguous',
      totalLatencyMs: elapsed,
      agent1Decomposition: {
        ...decomposition,
        clarificationPrompt:
          decomposition.clarificationPrompt ||
          `Your question could refer to multiple metrics or dimensions in "${schemaState.datasetLabel}". Which specific question would you like answered?`,
        clarificationOptions: dynamicOptions,
      },
      repairAttempts: [],
      autoRepairsCount: 0,
      verificationMatrix: buildSkippedVerificationMatrix(
        'ambiguous',
        decomposition.reasoning
      ),
    };
  }

  if (decomposition.status === 'unanswerable') {
    const elapsed = Math.max(1, Math.round(performance.now() - pipelineStart));
    return {
      question,
      datasetId: schemaState.datasetId,
      datasetLabel: schemaState.datasetLabel,
      status: 'unanswerable',
      errorCategory: 'abstention',
      totalLatencyMs: elapsed,
      agent1Decomposition: {
        ...decomposition,
        abstentionReason:
          decomposition.abstentionReason || decomposition.reasoning,
        suggestedAlternatives:
          decomposition.suggestedAlternatives &&
          decomposition.suggestedAlternatives.length > 0
            ? decomposition.suggestedAlternatives
            : buildDynamicFallbackAlternatives(schemaState),
      },
      repairAttempts: [],
      autoRepairsCount: 0,
      verificationMatrix: buildSkippedVerificationMatrix(
        'unanswerable',
        decomposition.abstentionReason || decomposition.reasoning
      ),
    };
  }

  // Step 2: Agent 2 — Question Plan + Defensive SQL Synthesis + Bounded Self-Repair
  const initialGenStart = performance.now();
  let initialPlanAndSql: { questionPlan: QuestionPlan; sql: string };
  try {
    initialPlanAndSql = await generateInitialSqlAndPlan(
      ai,
      question,
      decomposition,
      schemaPrompt
    );
  } catch (genErr: unknown) {
    const errMsg = genErr instanceof Error ? genErr.message : String(genErr);
    const elapsed = Math.max(1, Math.round(performance.now() - pipelineStart));
    return {
      question,
      datasetId: schemaState.datasetId,
      datasetLabel: schemaState.datasetLabel,
      status: 'execution_failed',
      errorCategory: 'generation_error',
      errorMessage: `SQL generation failed: ${errMsg}`,
      totalLatencyMs: elapsed,
      agent1Decomposition: decomposition,
      repairAttempts: [
        {
          attemptNumber: 1,
          generatedSql: '',
          succeeded: false,
          errorType: 'generation_error',
          errorMessage: errMsg,
          rootCauseDiagnosis: 'AI model failed to synthesize initial SQL JSON.',
          latencyMs: elapsed,
        },
      ],
      autoRepairsCount: 0,
      verificationMatrix: {
        overallPassed: false,
        structural: verifyStructural(false, false, undefined, errMsg),
        intent: {
          level: 'Intent',
          passed: false,
          summary: 'SQL generation failed prior to intent verification.',
          details: [errMsg],
        },
        dataQuality: {
          level: 'Data Quality',
          passed: false,
          summary: 'SQL generation failed prior to data quality checks.',
          details: [],
        },
        explanation: {
          level: 'Explanation',
          passed: false,
          summary: 'No query output produced.',
          details: [],
        },
      },
    };
  }

  const initialGenLatency = Math.round(performance.now() - initialGenStart);

  let currentSql = (initialPlanAndSql.sql || '').trim();
  if (options.injectFaultDemo && schemaState.tables.length > 0) {
    const firstTable = schemaState.tables[0];
    currentSql = `SELECT unverified_raw_header_col, COUNT(*) FROM "${firstTable.tableName}" GROUP BY 1`;
  }

  const repairAttempts: RepairAttempt[] = [];
  let finalOutput: SqlExecutionOutput | undefined;
  let structuralCheck = verifyStructural(false, false);
  let intentCheck = verifyIntent(currentSql, decomposition);
  let qualityCheck = verifyDataQuality(currentSql, schemaState);
  let pendingDiagnosis: string | undefined;
  let lastExecutionError: string | undefined;
  let blockedBySecurity = false;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const attemptStart = performance.now();
    const execRes = executeSandboxedQuery(db, currentSql);
    const attemptExecLatency =
      attempt === 1
        ? initialGenLatency +
          (execRes.ok ? execRes.output.executionLatencyMs : execRes.latencyMs)
        : Math.max(1, Math.round(performance.now() - attemptStart));

    if (!execRes.ok) {
      lastExecutionError = execRes.errorMessage;
      structuralCheck = verifyStructural(
        execRes.errorType !== 'security_blocked',
        false,
        undefined,
        execRes.errorMessage
      );

      if (execRes.errorType === 'security_blocked') {
        blockedBySecurity = true;
        repairAttempts.push({
          attemptNumber: attempt,
          generatedSql: execRes.sanitizedSql || currentSql,
          succeeded: false,
          errorType: 'security_blocked',
          errorMessage: execRes.errorMessage,
          rootCauseDiagnosis: 'Blocked by Read-Only Sandbox guardrail.',
          latencyMs: attemptExecLatency,
        });
        break;
      }

      if (attempt < MAX_REPAIR_ATTEMPTS) {
        try {
          const repairRes = await repairSqlQuery(
            ai,
            question,
            decomposition,
            schemaPrompt,
            currentSql,
            `SQLite Database Execution Error: ${execRes.errorMessage}`,
            attempt + 1
          );
          repairAttempts.push({
            attemptNumber: attempt,
            generatedSql: execRes.sanitizedSql || currentSql,
            succeeded: false,
            errorType: 'sqlite_error',
            errorMessage: execRes.errorMessage,
            rootCauseDiagnosis: repairRes.rootCauseDiagnosis,
            latencyMs: attemptExecLatency,
          });
          pendingDiagnosis = repairRes.rootCauseDiagnosis;
          currentSql = repairRes.correctedSql;
          continue;
        } catch (repErr: unknown) {
          const repMsg =
            repErr instanceof Error ? repErr.message : String(repErr);
          repairAttempts.push({
            attemptNumber: attempt,
            generatedSql: execRes.sanitizedSql || currentSql,
            succeeded: false,
            errorType: 'generation_error',
            errorMessage: `${execRes.errorMessage} (Repair generation failed: ${repMsg})`,
            latencyMs: attemptExecLatency,
          });
          break;
        }
      } else {
        repairAttempts.push({
          attemptNumber: attempt,
          generatedSql: execRes.sanitizedSql || currentSql,
          succeeded: false,
          errorType: 'sqlite_error',
          errorMessage: execRes.errorMessage,
          rootCauseDiagnosis:
            'Maximum bounded repair limit (3 attempts) reached without database execution success.',
          latencyMs: attemptExecLatency,
        });
        break;
      }
    }

    // SQLite succeeded! Run Structural, Intent, and Data Quality Verification
    currentSql = execRes.sanitizedSql;
    structuralCheck = verifyStructural(true, true, execRes.output);
    intentCheck = verifyIntent(currentSql, decomposition);
    qualityCheck = verifyDataQuality(currentSql, schemaState);

    if (
      (!intentCheck.passed || !qualityCheck.passed) &&
      attempt < MAX_REPAIR_ATTEMPTS
    ) {
      const defectMsg = [
        !intentCheck.passed
          ? `Intent Defect: ${intentCheck.details.join(' ')}`
          : '',
        !qualityCheck.passed
          ? `Data Quality Defect: ${qualityCheck.details.join(' ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' | ');

      try {
        const repairRes = await repairSqlQuery(
          ai,
          question,
          decomposition,
          schemaPrompt,
          currentSql,
          defectMsg,
          attempt + 1
        );

        repairAttempts.push({
          attemptNumber: attempt,
          generatedSql: currentSql,
          succeeded: false,
          errorType: 'verification_defect',
          errorMessage: defectMsg,
          rootCauseDiagnosis: repairRes.rootCauseDiagnosis,
          latencyMs: attemptExecLatency,
        });
        pendingDiagnosis = repairRes.rootCauseDiagnosis;
        currentSql = repairRes.correctedSql;
        continue;
      } catch {
        // Keep the working SQL execution output if repair LLM call fails on non-fatal lint
      }
    }

    finalOutput = execRes.output;
    repairAttempts.push({
      attemptNumber: attempt,
      generatedSql: currentSql,
      succeeded: true,
      rootCauseDiagnosis:
        attempt > 1
          ? pendingDiagnosis || 'Repaired query compiled and passed verification.'
          : undefined,
      latencyMs: attemptExecLatency,
    });
    break;
  }

  const autoRepairsCount = Math.max(0, repairAttempts.length - 1);

  // NEVER claim query succeeded if finalOutput is undefined!
  if (!finalOutput) {
    const totalLatencyMs = Math.max(
      1,
      Math.round(performance.now() - pipelineStart)
    );
    const errCat: PipelineErrorCategory = blockedBySecurity
      ? 'security_blocked'
      : 'execution_error';

    return {
      question,
      datasetId: schemaState.datasetId,
      datasetLabel: schemaState.datasetLabel,
      status: blockedBySecurity ? 'destructive_blocked' : 'execution_failed',
      errorCategory: errCat,
      errorMessage:
        lastExecutionError ||
        'Generated SQL failed database execution after 3 bounded attempts.',
      totalLatencyMs,
      agent1Decomposition: decomposition,
      questionPlan: initialPlanAndSql.questionPlan,
      finalSql: currentSql,
      repairAttempts,
      autoRepairsCount,
      verificationMatrix: {
        overallPassed: false,
        structural: structuralCheck,
        intent: intentCheck,
        dataQuality: qualityCheck,
        explanation: verifyExplanation(undefined, undefined, schemaState),
      },
    };
  }

  // Step 3: Agent 1 — Grounded Result Explanation & Level 4 Verification
  let explanation: Agent1Explanation | undefined;
  try {
    explanation = await runAgent1Explanation(
      ai,
      question,
      currentSql,
      finalOutput,
      schemaPrompt
    );
  } catch {
    explanation = {
      directTakeaway:
        finalOutput.rowCount === 0
          ? 'The query executed successfully and returned 0 matching rows.'
          : `The query executed successfully and returned ${finalOutput.rowCount} row(s).`,
      verifiedFigures: [],
      dataQualityDisclosures: [],
    };
  }

  const explanationCheck = verifyExplanation(
    explanation,
    finalOutput,
    schemaState
  );

  const overallPassed =
    structuralCheck.passed &&
    intentCheck.passed &&
    qualityCheck.passed &&
    explanationCheck.passed;

  const verificationMatrix: VerificationMatrix = {
    overallPassed,
    structural: structuralCheck,
    intent: intentCheck,
    dataQuality: qualityCheck,
    explanation: explanationCheck,
  };

  const totalLatencyMs = Math.max(
    1,
    Math.round(performance.now() - pipelineStart)
  );

  return {
    question,
    datasetId: schemaState.datasetId,
    datasetLabel: schemaState.datasetLabel,
    status: 'answerable',
    errorCategory: overallPassed ? 'none' : 'verification_defect',
    totalLatencyMs,
    agent1Decomposition: decomposition,
    questionPlan: initialPlanAndSql.questionPlan,
    finalSql: currentSql,
    repairAttempts,
    autoRepairsCount,
    executionOutput: finalOutput,
    agent1Explanation: explanation,
    verificationMatrix,
  };
}
