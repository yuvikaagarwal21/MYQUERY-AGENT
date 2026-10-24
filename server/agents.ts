import {
  GoogleGenAI,
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
const FALLBACK_GEMINI_MODEL = 'gemini-flash-latest';
const MAX_REPAIR_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      timeout: 16000,
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
  const candidates: { model: string; delayBeforeMs: number }[] = [
    { model: PRIMARY_GEMINI_MODEL, delayBeforeMs: 0 },
    { model: PRIMARY_GEMINI_MODEL, delayBeforeMs: 400 },
    { model: PRIMARY_GEMINI_MODEL, delayBeforeMs: 850 },
    { model: FALLBACK_GEMINI_MODEL, delayBeforeMs: 500 },
  ];

  let lastErr: unknown = null;
  for (const candidate of candidates) {
    if (candidate.delayBeforeMs > 0) {
      await sleep(candidate.delayBeforeMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: candidate.model,
        contents,
        config,
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
  if (/503|UNAVAILABLE|504|DEADLINE_EXCEEDED|timeout/i.test(rawMsg)) {
    throw new Error(
      'AI model service timed out or is temporarily busy. Please retry your question in a moment.'
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
          `    Numeric Stats (clean): validN=${col.numericStats.validCount}, min=${col.numericStats.min}, max=${col.numericStats.max}, mean=${col.numericStats.mean}, median=${col.numericStats.median}`
        );
      }
      if (col.topCategories && col.topCategories.length > 0) {
        const catStr = col.topCategories
          .map((c) => `"${c.value}": ${c.count} (${c.percentage}%)`)
          .join(', ');
        lines.push(`    Category Distribution: [${catStr}]`);
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

    if (table.sampleRows && table.sampleRows.length > 0) {
      lines.push(
        `  Sample Rows (up to 4 records from "${table.tableName}"): ${JSON.stringify(
          table.sampleRows.slice(0, 4)
        )}`
      );
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
      `Rank records in ${firstTable.tableName} from highest to lowest ${numCol.columnName}.`
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
  const systemInstruction = `You are Agent 1 (Decision-Oriented Semantic Intent & Dynamic Schema Discovery Agent) in a Two-Agent Natural-Language-to-SQL system.
Your job is to understand the real-world analytical or decision intent behind the user's question — even when phrased informally, indirectly, or as a complex management/business question — and map it strictly to the ACTUAL tables, columns, data types, distributions, and relationships of the currently selected uploaded dataset.

NEVER hardcode or assume specific table names, column names, or employee datasets. Discover everything dynamically from the provided schema!

CORE DECISION-ORIENTED INTENT & SCHEMA DISCOVERY RULES:
1. DYNAMIC MULTI-INDICATOR MAPPING (NO EXACT COLUMN NAMES REQUIRED):
   - Map natural-language concepts to all relevant columns that actually exist across the uploaded tables, and list them in semanticMappings and availableIndicators ("table.column").
   - Also identify important real-world context absent from the dataset in missingContextFactors (e.g., "salary bands / market benchmarks", "compensation budget", "promotion history", "historical multi-period reviews", "qualitative manager feedback").
   - Record scaleDirection for each matched column:
     * "higher_is_better": higher numbers = stronger/better outcome (e.g., performance score, KPI, productivity, target_achievement, attendance_rate, revenue, profit, margin, satisfaction).
     * "lower_is_better": lower numbers = better outcome / higher numbers = worse outcome (e.g., days_absent, error_rate, defect_count, churn_risk_score, support_tickets, rank #1 = best).
     * "categorical_meaning": text tiers have clear ordinal meaning (e.g., "Exceeds Expectations" > "Meets Expectations" > "Needs Improvement" > "Unsatisfactory"; "High" / "Medium" / "Low").
     * "neutral": descriptive, grouping, or baseline context column (e.g., department, role, level, tenure, current salary when used alongside performance).

2. EMPLOYEE COMPENSATION, RAISES & BONUSES (EVIDENCE-BASED):
   - For questions like "Who deserves a raise?", "Which employees should be considered for a salary increase?", "Who is most deserving of a bonus?", "Which employees are underpaid relative to their performance?", or "Who has high performance but a salary below the department average?":
     * NEVER equate deserving a raise/bonus to simply having the highest salary OR simply having the lowest salary!
     * Dynamically check which relevant indicators exist across all loaded tables: performance/rating/KPI, current salary/compensation, productivity/quota/target achievement, attendance/reliability, tenure/experience, role/job_title/level/department/location, and multi-period review trends.
     * PEER-GROUP RELATIVE SALARY COMPARISON: When salary AND a peer context column (role, job_title, level, grade, department, team, location) exist, compare salary against the role/level/department peer average rather than labeling someone underpaid solely vs. the overall company average!
     * MISSING COMPENSATION RULES:
       - If the user explicitly asks about pay disparity (e.g., "underpaid relative to performance", "salary below the department average") and salary/compensation (or department) does NOT exist in the dataset: set status = "unanswerable", explain clearly in abstentionReason which required field is missing, and provide suggestedAlternatives using available columns.
       - If the user asks "Who deserves a raise?" or "Who deserves a bonus?":
         a) If performance/achievement indicators AND salary exist: set status = "answerable", isSensitiveDecision = true, and analyze high-performing contributors alongside their current salary, peer/department average salary, and supporting indicators.
         b) If performance/achievement/productivity indicators exist, even if salary is missing: set status = "answerable", isSensitiveDecision = true, perform a preliminary multi-indicator ranking of top performers while listing missing salary/pay-band/budget context in missingContextFactors.
         c) If ONLY salary exists and NO performance, productivity, rating, target, or contribution column exists anywhere in the dataset: set status = "unanswerable" and explain that evaluating raise/bonus merit requires performance or contribution metrics not present in this dataset.

3. PROMOTIONS, LEADERSHIP, PIPs & TERMINATION REVIEWS (isSensitiveDecision = true):
   - Set isSensitiveDecision = true for ALL employment and personnel decisions: raises, salary increases, bonuses, promotions, leadership candidacy, PIPs, demotions, layoffs, hiring, or firing/termination.
   - For promotions / leadership roles ("Who should be considered for promotion?", "strongest candidates for leadership"): combine strong/consistent performance, target achievement, productivity, attendance, leadership/team metrics, and tenure/experience where available.
   - For underperformance / PIP / termination ("needs to be fired", "underperforming", "benefit from a PIP"): evaluate objective performance/KPI indicators (lowest scores, negative categorical tiers, or strictly below dataset AVG when "underperforming"/"below average" is asked).
   - PROTECTED CHARACTERISTICS GUARDRAIL: NEVER use protected characteristics (age, gender, sex, race, ethnicity, religion, disability, nationality, marital_status) to rank, filter, or recommend individuals for any employment decision. If asked to decide based on a protected attribute, set status = "unanswerable".

4. LONGITUDINAL TRENDS OVER TIME ("improved the most", "declining performance", "consistently high"):
   - Inspect whether the dataset has temporal/historical data: multiple rows per entity across a date/year/quarter/review_period column (or child review/sales table), OR multiple period columns (e.g., q1_score..q4_score, score_2023/score_2024).
   - If multi-period data exists: set status = "answerable" and specify comparing earliest vs. latest period (latest - earliest) or multi-period consistency (MIN, AVG, period count) in inferredThresholdOrRule.
   - CRITICAL SNAPSHOT RULE: If the user asks about change over time ("improved the most over time", "declining performance", "fastest growing") and the dataset is a single static snapshot with NO time/period columns and only 1 record per entity (and no growth_rate column), set status = "unanswerable" and explain clearly that historical multi-period data is missing!

5. BUSINESS, PRODUCT, CUSTOMER & FINANCIAL DECISIONS:
   - "Which products deserve more investment?" / "greatest growth potential": evaluate strong profit/margin, high sales/demand, return on cost, or positive growth rate/trend using actual columns.
   - "Which products should be discontinued based on sales and profitability?": identify records with low sales/units/revenue AND low or negative profit/margin (ordered worst-first).
   - "Which customers should receive loyalty rewards?": evaluate high total spend/revenue, order frequency, tenure, or satisfaction (joining and pre-aggregating order tables if multi-table).
   - "Which customers are at risk of leaving?" (churn): match churn/risk columns, declining activity, long recency/days_since_last_order, low satisfaction, or high support tickets.
   - "Which business categories generate the highest profit relative to cost?": group by category and calculate profit-to-cost efficiency (SUM(profit) / NULLIF(SUM(cost), 0), or (SUM(revenue) - SUM(cost)) / NULLIF(SUM(cost), 0)), ordered highest-to-lowest.

6. WHEN TO ASK CLARIFICATION ("ambiguous") VS. EXECUTE ("answerable"):
   - Set status = "ambiguous" when:
     a) A matched column has an opaque/unknown scale direction (e.g., codes like "Band A"/"Band B" without meaning, or "tier 1..5" where 1=best vs 1=worst is unknown), OR
     b) A narrow single-metric question ("Who is doing the worst?") matches 2+ distinct, potentially conflicting metric columns and the user did not ask for a combined multi-factor view.
   - For holistic decision questions ("Who deserves a raise?", "Who should be promoted?", "Rank employees by performance, attendance, and productivity"), DO NOT needlessly block if the scales of the available indicators are clear — set status = "answerable" and combine/project the relevant available indicators transparently!
   - IMPORTANT FOR expectedAggregations: List ONLY standard SQL aggregate functions ("AVG", "SUM", "COUNT", "MIN", "MAX") that MUST appear in the SQL query. Leave expectedAggregations = [] when simple sorting, ratios on row-level columns, or LAG/FIRST_VALUE window functions suffice.
   - Set requiresTopN = false when ranking an entire table ("Rank employees by..."), grouping categories ("Which categories..."), or filtering all records matching a threshold ("below average", "high performance but salary below department average"); set requiresTopN = true when selecting top/bottom candidates with a LIMIT.

7. DESTRUCTIVE / INJECTION QUERIES ("destructive_blocked"):
   - Set status = "destructive_blocked" ONLY for SQL injection or requests to mutate/delete/drop/update/insert database tables/rows (business questions like "which product should be discontinued" or "who should be fired" are read-only analytical SELECT intents!).`;

  const parsed = await generateStructuredJson<Agent1Decomposition>(
    ai,
    `ACTUAL UPLOADED DATABASE SCHEMA, STATS & SAMPLE ROWS:\n${schemaPrompt}\n\nUSER QUESTION:\n${question}`,
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
          requiresTopN: {
            type: Type.BOOLEAN,
            description:
              'True ONLY when selecting top N / bottom N candidate records with a LIMIT clause. False for full-table rankings, category summaries, or explicit threshold filters.',
          },
          semanticMappings: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                userConcept: { type: Type.STRING },
                matchedTable: { type: Type.STRING },
                matchedColumn: { type: Type.STRING },
                scaleDirection: {
                  type: Type.STRING,
                  description:
                    'One of: higher_is_better, lower_is_better, categorical_meaning, neutral',
                },
                interpretationNote: { type: Type.STRING },
              },
              required: [
                'userConcept',
                'matchedTable',
                'matchedColumn',
                'scaleDirection',
                'interpretationNote',
              ],
            },
          },
          availableIndicators: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          missingContextFactors: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          inferredThresholdOrRule: { type: Type.STRING },
          isSensitiveDecision: { type: Type.BOOLEAN },
          sensitiveDecisionTopic: { type: Type.STRING },
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
          'semanticMappings',
          'availableIndicators',
          'missingContextFactors',
          'isSensitiveDecision',
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
  const systemInstruction = `You are Agent 2 (Schema-Grounded SQLite Decision Analyst & Defensive Data Cleaning Agent).
Given the actual uploaded database schema, data-quality profile, sample rows, and Agent 1's semantic decomposition, construct a QuestionPlan and a single read-only SQLite SELECT (or WITH ... SELECT) query.

CRITICAL SQLITE & MULTI-FACTOR DECISION RULES:
1. EXACT SCHEMA IDENTIFIERS ONLY:
   - Use ONLY exact SQLite table and column names from the provided schema (double-quote identifiers, e.g. "column_name"). NEVER invent table or column names!
   - Single read-only SELECT or WITH ... SELECT statement only.

2. PROJECT COMPLETE EVIDENCE & COMPUTED BENCHMARKS IN SELECT:
   - Include entity identifiers (id, name/title), relevant context columns (role, level, department, category, region, tenure), every raw indicator column used in the analysis, AND any computed peer averages, differences, growth deltas, or ratios (rounded with ROUND(..., 2)) directly in the SELECT list!
   - Projecting computed columns (such as "peer_avg_salary", "salary_vs_peer_avg", "dataset_avg_performance", "score_change", "profit_to_cost_ratio") lets the user verify every comparison directly in the result table.

3. MULTI-FACTOR & DECISION-ORIENTED SQL PATTERNS:
   - RAISES, BONUSES & UNDERPAID-RELATIVE-TO-PERFORMANCE:
     * NEVER simply sort by highest salary or lowest salary alone!
     * When both performance and salary exist: use a WITH CTE to compute peer benchmark salary — e.g., ROUND(AVG(clean_salary) OVER (PARTITION BY "role"), 2) or PARTITION BY "department" (using role/level/department if present, or AVG(clean_salary) OVER () if no grouping column exists) and overall/peer average performance AVG(clean_perf) OVER ().
     * For "Who has high performance but a salary below the department average?" or "Which employees are underpaid relative to their performance?": filter WHERE clean_perf >= peer_or_overall_avg_perf (or top tier) AND clean_salary < peer_avg_salary, projecting clean_perf, clean_salary, peer_avg_salary, and ROUND(clean_salary - peer_avg_salary, 2) AS "salary_diff_vs_peer_avg", ordered by strong performance and largest pay gap!
     * For general "Who deserves a raise?" / "considered for a salary increase": surface candidates with above-average / strong performance (and strong supporting metrics like productivity/attendance/tenure if available), projecting their performance, supporting indicators, current salary, peer_avg_salary, and salary_diff_vs_peer_avg, prioritizing high performers paid below or modestly relative to peers (LIMIT 10 if requiresTopN is true).
   - PROMOTIONS, LEADERSHIP & MULTI-METRIC RANKING ("Rank employees by performance, attendance, and productivity", "Who should be considered for promotion?"):
     * Filter out rows where key evaluated metrics are NULL.
     * Include all relevant available indicators (performance, productivity/targets, attendance, tenure) and compute a transparent normalized composite score (using max/min window values with NULLIF(..., 0), accounting for higher_is_better vs lower_is_better!) or multi-column ordering so candidates excelling across multiple dimensions rank highest.
   - LONGITUDINAL IMPROVEMENT OR DECLINE OVER TIME ("improved the most over time", "declining performance"):
     * If historical rows exist per entity across a date/period/quarter/year column: use WITH CTEs (e.g., ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY period_col ASC) AS rn_first and DESC AS rn_last, requiring COUNT(*) >= 2 periods) to join each entity's earliest value and latest value, project earliest_period, earliest_value, latest_period, latest_value, and ROUND(latest_value - earliest_value, 2) AS "change_over_time", and sort DESC for most improved or ASC for declining!
     * If multiple period columns exist on the same row (e.g. "q1_score", "q4_score"), compute ROUND(clean_latest - clean_earliest, 2) AS "change_over_time" and sort accordingly.
   - BUSINESS, INVESTMENT, DISCONTINUATION & PROFIT-TO-COST:
     * Always guard division with NULLIF(denominator, 0) (e.g., ROUND((SUM(clean_profit) * 1.0) / NULLIF(SUM(clean_cost), 0), 4) AS "profit_to_cost_ratio" and ROUND((SUM(clean_profit) * 100.0) / NULLIF(SUM(clean_cost), 0), 2) AS "profit_to_cost_pct").
     * For "discontinued based on sales and profitability": project units/sales, revenue, cost, profit/margin, and sort by lowest profit/margin and lowest sales ASC (or filter negative/below-average profit and below-average sales if clearly warranted, ensuring valid rows are returned).

4. SCALE DIRECTION, CATEGORICAL MEANINGS & DEFENSIVE CLEANING:
   - ALWAYS EXCLUDE NULLS WHEN RANKING OR FILTERING SCORES: In SQLite, NULL sorts BEFORE numbers in ORDER BY ASC! Always include WHERE <cleaned_expr> IS NOT NULL.
   - Respect scaleDirection ("higher_is_better" vs "lower_is_better"). For "categorical_meaning", NEVER sort ordinal labels alphabetically — use an explicit CASE UPPER(TRIM("col")) WHEN ... END ordering based on actual Category Distribution values!
   - Whenever aggregating, comparing, or sorting a numeric_dirty column (with $, commas, %, or sentinel strings like UNKNOWN, ERROR, N/A), ALWAYS use its Defensive SQLite Expression from the schema so sentinel strings never silently cast to 0.0.
   - MULTI-TABLE FAN-OUT PREVENTION: When joining 1-to-many child tables (reviews, sales, orders, attendance logs) to a parent entity table, pre-aggregate each child table by foreign key inside a WITH CTE BEFORE joining so parent records are never duplicated or inflated! When whitespace padding exists on join keys, join using TRIM(a."col") = TRIM(b."col").
   - Never rank or filter individuals using protected characteristics (age, gender, sex, race, ethnicity, religion, disability).`;

  return generateStructuredJson<{
    questionPlan: QuestionPlan;
    sql: string;
  }>(
    ai,
    `ACTUAL SCHEMA, STATS & SAMPLE ROWS:\n${schemaPrompt}\n\nUSER QUESTION:\n${question}\n\nAGENT 1 SEMANTIC DECOMPOSITION:\n${JSON.stringify(decomposition, null, 2)}`,
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
  decomposition: Agent1Decomposition,
  finalSql: string,
  output: SqlExecutionOutput,
  schemaPrompt: string
): Promise<Agent1Explanation> {
  const systemInstruction = `You are Agent 1 (Decision-Support Result Explainer & Responsible Analytics Auditor).
Explain the executed SQL query results clearly, objectively, and transparently.

STRICT GROUNDING & DECISION-SUPPORT EXPLANATION RULES:
1. ZERO FABRICATION & EXACT NUMBERS ONLY:
   - Cite ONLY exact names, categories, and numbers that appear directly in the SQL QUERY RESULT ROWS or dataset summary stats. NEVER invent records, policies, or mental-math numbers not present in the result cells! If 0 rows matched, state clearly that 0 records matched the criteria.
2. directTakeaway (2-3 clear sentences):
   - Summarize the key findings from the returned records and strictly distinguish observed data from recommendations.
   - RESPONSIBLE PERSONNEL & DECISION-SUPPORT FRAMING:
     If isSensitiveDecision is true (raises, bonuses, salary reviews, promotions, leadership candidacy, PIPs, layoffs, or termination):
     * Treat the output as objective decision support for further human review — NEVER as an automatic final employment decision or authoritative company policy!
     * For raises/promotions/bonuses: e.g., "Based on the available metrics in this dataset, these employees stand out as strong candidates for a compensation/promotion review..."
     * For underperformance/PIP/termination: NEVER recommend firing or penalizing anyone; frame strictly as objective performance records surfaced for review.
     * Never reference or infer protected characteristics.
3. recordReasoning (1-4 concise strings; empty array [] if 0 rows returned):
   - Explain concretely WHY the top returned records (or groups) appear in the results, referencing their exact observed metrics and peer/benchmark comparisons from the SQL output rows.
4. analyticalCriteriaUsed (1-2 concise sentences):
   - State the exact table(s), indicator column(s), peer comparison or aggregation logic, and sorting/filtering rules executed in SQL.
5. missingInformation (1-3 concise strings):
   - Explicitly state relevant real-world factors that are unavailable in this dataset and therefore cannot be concluded from the data alone (e.g., formal pay bands, compensation budget, market benchmarks, time since last raise/promotion, role expectations, or qualitative manager evaluations).
6. assumptionsAndLimitations (1-3 concise strings):
   - Note any threshold/ranking assumptions applied when the user did not specify an explicit numeric cutoff, and invite custom thresholds if desired.
7. sensitiveDecisionDisclaimer:
   - Populate ONLY when isSensitiveDecision is true (otherwise return ""). Provide a balanced 1-2 sentence reminder tailored to the topic (compensation, promotion, or performance review) that dataset metrics support structured review and are not a substitute for holistic human judgment and organizational context.
8. verifiedFigures:
   - Extract key figures directly from the returned SQL rows ({ label, value, sourceColumn }). Every numeric value MUST appear in the SQL result rows or dataset stats.
9. dataQualityDisclosures:
   - Note any excluded NULLs, dirty sentinel values, whitespace trimming, or duplicate rows in the queried tables.`;

  const previewRows = output.rows.slice(0, 40);

  return generateStructuredJson<Agent1Explanation>(
    ai,
    `USER QUESTION:\n${question}\n\nDECOMPOSED INTENT & INDICATORS:\n${JSON.stringify(
      {
        semanticMappings: decomposition.semanticMappings,
        availableIndicators: decomposition.availableIndicators,
        missingContextFactors: decomposition.missingContextFactors,
        inferredThresholdOrRule: decomposition.inferredThresholdOrRule,
        isSensitiveDecision: Boolean(decomposition.isSensitiveDecision),
        sensitiveDecisionTopic: decomposition.sensitiveDecisionTopic,
      },
      null,
      2
    )}\n\nEXECUTED VERIFIED SQL:\n${finalSql}\n\nSQL QUERY RESULT (Total Matched Rows: ${output.totalMatchedRows ?? output.rowCount}, Showing ${previewRows.length} rows):\n${JSON.stringify(previewRows, null, 2)}\n\nSCHEMA & DATA PROFILE:\n${schemaPrompt}`,
    {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          directTakeaway: { type: Type.STRING },
          analyticalCriteriaUsed: { type: Type.STRING },
          recordReasoning: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          missingInformation: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          assumptionsAndLimitations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          sensitiveDecisionDisclaimer: { type: Type.STRING },
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
        required: [
          'directTakeaway',
          'analyticalCriteriaUsed',
          'recordReasoning',
          'missingInformation',
          'assumptionsAndLimitations',
          'verifiedFigures',
          'dataQualityDisclosures',
        ],
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

  // Step 1: Agent 1 — Semantic Intent Discovery, Scale Inspection & Ambiguity/Abstention Detection
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
          `Your question could refer to multiple columns or scales in "${schemaState.datasetLabel}". How would you like to proceed?`,
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

  // Step 2: Agent 2 — Question Plan + Schema-Grounded SQL Synthesis + Bounded Self-Repair
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

  // NEVER report results unless the SQL query actually executed successfully!
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

  // Step 3: Agent 1 — Grounded Natural-Language Explanation & Responsible Framing
  let explanation: Agent1Explanation | undefined;
  try {
    explanation = await runAgent1Explanation(
      ai,
      question,
      decomposition,
      currentSql,
      finalOutput,
      schemaPrompt
    );
  } catch {
    explanation = {
      directTakeaway:
        finalOutput.rowCount === 0
          ? 'The query executed successfully and returned 0 matching rows.'
          : decomposition.isSensitiveDecision
            ? `Returned ${finalOutput.rowCount} record(s) matching the objective query criteria. These findings are provided as structured decision support for further human review rather than a final personnel decision.`
            : `The query executed successfully and returned ${finalOutput.rowCount} row(s).`,
      analyticalCriteriaUsed: initialPlanAndSql.questionPlan.aggregationAndOrdering,
      recordReasoning: [],
      missingInformation: decomposition.missingContextFactors || [],
      assumptionsAndLimitations: decomposition.isSensitiveDecision
        ? [
            'Quantitative dataset metrics support objective review and must be weighed alongside organizational policies, role context, and qualitative evaluation.',
          ]
        : [],
      sensitiveDecisionDisclaimer: decomposition.isSensitiveDecision
        ? 'Quantitative dataset metrics provide objective decision support for human review and are not a substitute for holistic evaluation, role context, and organizational policy.'
        : '',
      verifiedFigures: [],
      dataQualityDisclosures: [],
    };
  }

  // Deterministic safeguard: ensure sensitive personnel decisions ALWAYS carry responsible decision-support framing
  if (decomposition.isSensitiveDecision && explanation) {
    if (
      !explanation.sensitiveDecisionDisclaimer ||
      !explanation.sensitiveDecisionDisclaimer.trim()
    ) {
      explanation.sensitiveDecisionDisclaimer =
        'Quantitative dataset records provide objective decision support for further review and should be combined with role expectations, qualitative context, and organizational policy before making final personnel decisions.';
    }
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
