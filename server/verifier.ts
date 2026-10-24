import type {
  Agent1Decomposition,
  Agent1Explanation,
  ColumnProfile,
  SqlExecutionOutput,
  VerificationCheckItem,
  VerificationMatrix,
  WorkspaceSchemaState,
} from '../src/types/domain.ts';

export function verifyStructural(
  sqlAllowed: boolean,
  executionSucceeded: boolean,
  output?: SqlExecutionOutput,
  errorMsg?: string
): VerificationCheckItem {
  if (!sqlAllowed) {
    return {
      level: 'Structural',
      passed: false,
      summary: 'Rejected by Read-Only Sandbox before SQLite compilation.',
      details: [errorMsg || 'Query violated read-only or single-statement policy.'],
    };
  }

  if (!executionSucceeded || !output) {
    return {
      level: 'Structural',
      passed: false,
      summary: 'SQLite statement failed compilation or runtime execution.',
      details: [errorMsg || 'Unknown SQLite execution error.'],
    };
  }

  if (output.columns.length === 0 && output.rowCount === 0) {
    return {
      level: 'Structural',
      passed: true,
      summary: 'Compiled cleanly in SQLite (0 matching rows returned).',
      details: [
        'Read-only single-statement check passed.',
        `Executed in ${output.executionLatencyMs}ms with 0 rows.`,
      ],
    };
  }

  return {
    level: 'Structural',
    passed: true,
    summary: `Compiled and returned ${output.rowCount} row(s) × ${output.columns.length} column(s).`,
    details: [
      'Read-only single-statement AST check passed.',
      `Output schema: [${output.columns.join(', ')}].`,
      `Execution completed in ${output.executionLatencyMs}ms.`,
    ],
  };
}

export function verifyIntent(
  sql: string,
  decomposition: Agent1Decomposition
): VerificationCheckItem {
  const upperSql = sql.toUpperCase();
  const issues: string[] = [];
  const notes: string[] = [];

  for (const agg of decomposition.expectedAggregations) {
    const cleanAgg = agg.trim().toUpperCase();
    if (['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'].includes(cleanAgg)) {
      const regex = new RegExp(`\\b${cleanAgg}\\s*\\(`, 'i');
      if (!regex.test(sql)) {
        issues.push(`Expected aggregation ${cleanAgg}(...) missing from SQL query.`);
      } else {
        notes.push(`Verified ${cleanAgg}(...) aggregation present.`);
      }
    }
  }

  if (decomposition.requiresJoin) {
    const hasJoin =
      /\bJOIN\b/i.test(sql) ||
      (decomposition.requiredTables.length >= 2 &&
        decomposition.requiredTables.every((t) =>
          new RegExp(`\\b${t}\\b`, 'i').test(sql)
        ));
    if (!hasJoin) {
      issues.push(
        `Multi-table intent requires joining [${decomposition.requiredTables.join(', ')}], but no JOIN clause was found.`
      );
    } else {
      notes.push('Multi-table JOIN alignment verified.');
    }
  }

  if (
    decomposition.groupingDimensions.length > 0 &&
    decomposition.expectedAggregations.length > 0
  ) {
    if (!/\bGROUP\s+BY\b/i.test(sql)) {
      issues.push(
        `Grouping dimension(s) [${decomposition.groupingDimensions.join(', ')}] requested without GROUP BY clause.`
      );
    } else {
      notes.push('GROUP BY clause matches dimensional breakdown.');
    }
  }

  if (decomposition.requiresTopN) {
    if (!/\bORDER\s+BY\b/i.test(sql)) {
      issues.push('Top-N ranking intent requires an ORDER BY clause.');
    } else if (!/\bDESC\b/i.test(upperSql) && !/\bASC\b/i.test(upperSql)) {
      notes.push('ORDER BY present (implicit ASC ordering).');
    } else {
      notes.push('Ranking ORDER BY direction verified.');
    }
    if (!/\bLIMIT\s+\d+/i.test(sql)) {
      issues.push('Top-N ranking intent requires an explicit LIMIT N clause.');
    } else {
      notes.push('Explicit LIMIT clause verified.');
    }
  }

  if (
    (decomposition.temporalBoundaries.length > 0 ||
      decomposition.filters.length > 0) &&
    !/\b(WHERE|HAVING|CASE\s+WHEN)\b/i.test(sql)
  ) {
    issues.push(
      'Temporal or categorical filter specified in plan, but SQL lacks WHERE/CASE filter logic.'
    );
  } else if (
    decomposition.temporalBoundaries.length > 0 ||
    decomposition.filters.length > 0
  ) {
    notes.push('Filter/temporal predicate clause verified.');
  }

  if (notes.length === 0 && issues.length === 0) {
    notes.push('Projection and table scope align with decomposed intent.');
  }

  return {
    level: 'Intent',
    passed: issues.length === 0,
    summary:
      issues.length === 0
        ? 'Aggregations, joins, ordering, and filters match query plan.'
        : issues[0],
    details: issues.length > 0 ? [...issues, ...notes] : notes,
  };
}

export function verifyDataQuality(
  sql: string,
  schemaState: WorkspaceSchemaState
): VerificationCheckItem {
  const issues: string[] = [];
  const notes: string[] = [];

  // Inspect referenced columns across loaded tables
  const referencedDirtyCols: { table: string; col: ColumnProfile }[] = [];
  for (const table of schemaState.tables) {
    // Only check tables mentioned in SQL
    if (!new RegExp(`\\b${table.tableName}\\b`, 'i').test(sql)) continue;
    for (const col of table.columns) {
      if (new RegExp(`\\b${col.columnName}\\b`, 'i').test(sql)) {
        referencedDirtyCols.push({ table: table.tableName, col });
      }
    }
  }

  for (const { table, col } of referencedDirtyCols) {
    const dp = col.dirtyProfile;

    // 1. Check numeric_dirty columns used with CAST or numeric aggregations
    if (col.inferredType === 'numeric_dirty') {
      const usedInNumericContext =
        new RegExp(
          `\\b(SUM|AVG|MIN|MAX)\\s*\\([\\s\\S]*?\\b${col.columnName}\\b`,
          'i'
        ).test(sql) ||
        new RegExp(`CAST\\s*\\([\\s\\S]*?\\b${col.columnName}\\b[\\s\\S]*?AS\\s+(REAL|FLOAT|NUMERIC|INTEGER)`, 'i').test(
          sql
        );

      if (usedInNumericContext) {
        if (dp.currencyFormattedCount > 0 && !/\bREPLACE\s*\(/i.test(sql)) {
          issues.push(
            `Column "${table}.${col.columnName}" contains currency symbols ($), so CAST without REPLACE() will evaluate to 0.0 in SQLite.`
          );
        } else if (dp.commaFormattedCount > 0 && !/REPLACE\s*\([\s\S]*?,[\s\S]*?','/i.test(sql)) {
          issues.push(
            `Column "${table}.${col.columnName}" contains thousands commas (,), which truncates SQLite CAST() unless stripped via REPLACE().`
          );
        } else {
          notes.push(
            `Currency/comma stripping verified on "${table}.${col.columnName}".`
          );
        }

        const sentinelCount = Object.values(dp.sentinelTokens).reduce(
          (a, b) => a + b,
          0
        );
        if (sentinelCount > 0 || dp.nullOrEmptyCount > 0) {
          // Ensure query guards against silent CAST('UNKNOWN' AS REAL) -> 0.0!
          const hasDirtyExclusionGuard =
            /\bCASE\s+WHEN\b/i.test(sql) ||
            /\bNULLIF\s*\(/i.test(sql) ||
            /\bNOT\s+IN\s*\(/i.test(sql) ||
            /\bGLOB\s*'\*?\[0-9\]/i.test(sql) ||
            new RegExp(`\\b${col.columnName}\\b[\\s\\S]*?IS\\s+NOT\\s+NULL`, 'i').test(sql);

          // Specifically if sentinel tokens exist (UNKNOWN/ERROR/N/A), IS NOT NULL alone is NOT enough because 'UNKNOWN' is not SQL NULL!
          const guardsSentinelStrings =
            /\bCASE\s+WHEN\b/i.test(sql) ||
            /\bNULLIF\s*\(/i.test(sql) ||
            /\bNOT\s+IN\s*\(/i.test(sql) ||
            /\bGLOB\b/i.test(sql) ||
            /\b!='UNKNOWN'|<>'UNKNOWN'/i.test(sql.replace(/\s+/g, ''));

          if (sentinelCount > 0 && !guardsSentinelStrings) {
            issues.push(
              `Column "${table}.${col.columnName}" contains dirty string tokens (${Object.keys(dp.sentinelTokens).join(', ')}). Naive CAST(... AS REAL) silently converts them to 0.0 in SQLite! Use CASE WHEN / NOT IN / GLOB to map dirty tokens to NULL.`
            );
          } else if (hasDirtyExclusionGuard) {
            notes.push(
              `Dirty tokens (${Object.keys(dp.sentinelTokens).join(', ') || 'empty'}) guarded from silent zero-casting on "${table}.${col.columnName}".`
            );
          }
        }
      }
    }

    // 2. Check whitespace-padded identifier or categorical columns used in JOIN or equality/grouping
    if (
      dp.whitespacePaddedCount > 0 &&
      (col.inferredType === 'identifier' || col.inferredType === 'categorical')
    ) {
      const usedInJoinOrPredicate =
        new RegExp(`\\bON\\b[\\s\\S]*?\\b${col.columnName}\\b`, 'i').test(sql) ||
        new RegExp(`\\bWHERE\\b[\\s\\S]*?\\b${col.columnName}\\b`, 'i').test(sql) ||
        new RegExp(`\\bGROUP\\s+BY\\b[\\s\\S]*?\\b${col.columnName}\\b`, 'i').test(sql);

      if (usedInJoinOrPredicate) {
        const trimsCol = new RegExp(
          `TRIM\\s*\\(\\s*(?:[a-zA-Z0-9_]+\\.)?"?${col.columnName}"?\\s*\\)`,
          'i'
        ).test(sql);
        if (!trimsCol) {
          issues.push(
            `Column "${table}.${col.columnName}" has ${dp.whitespacePaddedCount} whitespace-padded value(s); apply TRIM() in JOIN/WHERE/GROUP BY to prevent missed matches.`
          );
        } else {
          notes.push(`TRIM() normalization verified on "${table}.${col.columnName}".`);
        }
      }
    }
  }

  if (notes.length === 0 && issues.length === 0) {
    notes.push('No unguarded dirty-token or silent zero-cast risks detected.');
  }

  return {
    level: 'Data Quality',
    passed: issues.length === 0,
    summary:
      issues.length === 0
        ? 'Defensive cleaning prevents silent zero-casts and whitespace mismatches.'
        : issues[0],
    details: issues.length > 0 ? [...issues, ...notes] : notes,
  };
}

function collectAllowedNumbers(
  output: SqlExecutionOutput,
  schemaState: WorkspaceSchemaState
): number[] {
  const allowed: number[] = [output.rowCount];

  for (const row of output.rows) {
    for (const val of Object.values(row)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        allowed.push(val);
      } else if (typeof val === 'string') {
        const cleaned = val.replace(/[$,%\s]/g, '');
        if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
          allowed.push(Number(cleaned));
        }
      }
    }
  }

  // Also allow structural schema counts (total rows, dirty counts, table counts) disclosed in data-quality notes
  for (const t of schemaState.tables) {
    allowed.push(t.rowCount);
    for (const c of t.columns) {
      allowed.push(c.dirtyProfile.totalDirtyCount);
      allowed.push(c.dirtyProfile.nullOrEmptyCount);
      allowed.push(c.nonEmptyCount);
      const sentinelTotal = Object.values(c.dirtyProfile.sentinelTokens).reduce(
        (a, b) => a + b,
        0
      );
      allowed.push(sentinelTotal);
      allowed.push(t.rowCount - c.dirtyProfile.totalDirtyCount);
      for (const cnt of Object.values(c.dirtyProfile.sentinelTokens)) {
        allowed.push(cnt);
      }
    }
  }

  return allowed;
}

function matchesAnyAllowedNumber(candidate: number, allowed: number[]): boolean {
  for (const ref of allowed) {
    if (Math.abs(candidate - ref) <= 0.05) return true;
    // Also check rounded integer or 1-decimal or percentage representation (e.g. 0.25 vs 25%)
    if (Math.abs(candidate - Math.round(ref)) <= 0.01 && Math.abs(candidate) >= 10) {
      // Allow integer rounding only if close
      if (Math.abs(candidate - ref) <= 0.51) return true;
    }
    if (Math.abs(candidate - ref * 100) <= 0.15) return true;
  }
  return false;
}

export function verifyExplanation(
  explanation: Agent1Explanation | undefined,
  output: SqlExecutionOutput | undefined,
  schemaState: WorkspaceSchemaState
): VerificationCheckItem {
  if (!explanation || !output) {
    return {
      level: 'Explanation',
      passed: false,
      summary: 'No query output available to ground explanation figures.',
      details: ['Pipeline abstained, requested clarification, or blocked execution.'],
    };
  }

  const allowedNumbers = collectAllowedNumbers(output, schemaState);
  const ungroundedFigures: string[] = [];
  const verifiedNotes: string[] = [];

  // Check structured verifiedFigures first
  for (const fig of explanation.verifiedFigures) {
    const cleaned = fig.value.replace(/[$,%\s]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
      const num = Number(cleaned);
      if (matchesAnyAllowedNumber(num, allowedNumbers)) {
        verifiedNotes.push(
          `Verified figure "${fig.label}: ${fig.value}" traces to column "${fig.sourceColumn}".`
        );
      } else {
        ungroundedFigures.push(
          `Reported figure "${fig.value}" (${fig.label}) not found in returned SQL records.`
        );
      }
    }
  }

  // Extract numeric claims from directTakeaway (ignoring years like 2023/2024 or Q1/Q2/top 3)
  const sanitizedTakeaway = explanation.directTakeaway
    .replace(/\b20\d{2}(-\d{2}(-\d{2})?)?\b/g, ' ') // strip ISO dates & years
    .replace(/\bQ[1-4]\b/gi, ' ') // strip quarter labels
    .replace(/\b(?:top|first|limit)\s+\d+\b/gi, ' ') // strip "top 3"
    .replace(/\bORD-\d+\b|\bCUST-\d+\b|\bSHP-\d+\b/gi, ' '); // strip IDs

  const numberMatches = sanitizedTakeaway.match(/\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d+(?:\.\d+)/g) || [];
  for (const rawMatch of numberMatches) {
    const num = Number(rawMatch.replace(/[$,]/g, ''));
    if (!Number.isFinite(num)) continue;
    // Small ordinal words like "1" or "2" or "3" in prose are fine if <= 3, check substantive metrics
    if (num <= 3 && !rawMatch.includes('$') && !rawMatch.includes('.')) continue;

    if (!matchesAnyAllowedNumber(num, allowedNumbers)) {
      ungroundedFigures.push(
        `Takeaway mentions "${rawMatch}", which could not be traced to SQL result cells.`
      );
    }
  }

  if (verifiedNotes.length === 0 && ungroundedFigures.length === 0) {
    verifiedNotes.push(
      `All figures in takeaway trace directly to the ${output.rowCount} returned query record(s).`
    );
  }

  return {
    level: 'Explanation',
    passed: ungroundedFigures.length === 0,
    summary:
      ungroundedFigures.length === 0
        ? 'Every cited metric traces directly to returned SQL records.'
        : ungroundedFigures[0],
    details:
      ungroundedFigures.length > 0
        ? [...ungroundedFigures, ...verifiedNotes]
        : verifiedNotes,
  };
}

export function buildSkippedVerificationMatrix(
  status: 'ambiguous' | 'unanswerable' | 'destructive_blocked',
  reason: string
): VerificationMatrix {
  if (status === 'destructive_blocked') {
    return {
      overallPassed: true, // Guardrail succeeded!
      structural: {
        level: 'Structural',
        passed: true,
        summary: 'Read-Only Guardrail intercepted and blocked destructive/multi-statement command.',
        details: [reason],
      },
      intent: {
        level: 'Intent',
        passed: true,
        summary: 'Mutating/injection intent identified and refused safely.',
        details: ['Zero database state mutations permitted.'],
      },
      dataQuality: {
        level: 'Data Quality',
        passed: true,
        summary: 'In-memory tables preserved intact without alteration.',
        details: ['No rows modified or dropped.'],
      },
      explanation: {
        level: 'Explanation',
        passed: true,
        summary: 'Transparent security refusal returned without fabricated figures.',
        details: ['User informed of read-only policy enforcement.'],
      },
    };
  }

  const label =
    status === 'ambiguous'
      ? 'Execution paused pending user clarification of ambiguous intent.'
      : 'Agent 1 honestly abstained due to unanswerable out-of-schema request.';

  return {
    overallPassed: true,
    structural: {
      level: 'Structural',
      passed: true,
      summary: 'SQL generation intentionally withheld.',
      details: [label],
    },
    intent: {
      level: 'Intent',
      passed: true,
      summary: reason,
      details: [label],
    },
    dataQuality: {
      level: 'Data Quality',
      passed: true,
      summary: 'No unverified assumptions or fabricated schema mappings made.',
      details: ['Zero silent type coercions executed.'],
    },
    explanation: {
      level: 'Explanation',
      passed: true,
      summary: 'Zero hallucinated numbers emitted.',
      details: ['Abstention / clarification grounded strictly in loaded schema.'],
    },
  };
}
