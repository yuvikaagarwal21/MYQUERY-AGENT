import type { Database } from 'sql.js';
import type { SqlExecutionOutput } from '../src/types/domain.ts';

export interface SandboxValidationResult {
  allowed: boolean;
  sanitizedSql: string;
  violationReason?: string;
}

const MAX_RESULT_ROWS = 1000;

const FORBIDDEN_KEYWORDS_REGEX =
  /\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|REPLACE\s+INTO|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK)\b/i;

function stripSqlCommentsAndLiteralsForInspection(sql: string): string {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ');
  return withoutComments.replace(/'(?:''|[^'])*'/g, "''");
}

export function validateReadOnlySql(rawSql: string): SandboxValidationResult {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    return {
      allowed: false,
      sanitizedSql: '',
      violationReason: 'Empty SQL statement rejected.',
    };
  }

  const unfenced = trimmed
    .replace(/^```(?:sql|sqlite)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const inspected = stripSqlCommentsAndLiteralsForInspection(unfenced).trim();

  const withoutTrailingSemi = inspected.replace(/;+\s*$/, '').trim();
  if (withoutTrailingSemi.includes(';')) {
    return {
      allowed: false,
      sanitizedSql: unfenced,
      violationReason:
        'Multi-statement SQL rejected by Read-Only Sandbox (semicolon statement chaining detected).',
    };
  }

  const forbiddenMatch = FORBIDDEN_KEYWORDS_REGEX.exec(withoutTrailingSemi);
  if (forbiddenMatch) {
    return {
      allowed: false,
      sanitizedSql: unfenced,
      violationReason: `Destructive or mutating command "${forbiddenMatch[1].toUpperCase()}" blocked by Read-Only SQLite Sandbox.`,
    };
  }

  if (!/^(SELECT|WITH)\b/i.test(withoutTrailingSemi)) {
    return {
      allowed: false,
      sanitizedSql: unfenced,
      violationReason:
        'Only read-only SELECT or WITH (CTE) queries are permitted in the SQLite sandbox.',
    };
  }

  return {
    allowed: true,
    sanitizedSql: unfenced.replace(/;+\s*$/, ''),
  };
}

export function detectDestructivePromptIntent(userQuestion: string): {
  isDestructive: boolean;
  reason?: string;
} {
  if (
    /;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE)\b/i.test(userQuestion) ||
    /\bDROP\s+TABLE\b/i.test(userQuestion) ||
    /\bTRUNCATE\s+TABLE\b/i.test(userQuestion)
  ) {
    return {
      isDestructive: true,
      reason:
        'SQL injection / destructive DDL payload detected in prompt and blocked before execution.',
    };
  }

  if (
    /^\s*(delete|drop|erase|wipe|truncate|update|insert\s+into|overwrite)\b/i.test(
      userQuestion.trim()
    ) &&
    !/^\s*update\s+me\b/i.test(userQuestion.trim())
  ) {
    return {
      isDestructive: true,
      reason:
        'Mutating operation requested (DELETE/UPDATE/DROP). Sandbox strictly enforces read-only analytical queries.',
    };
  }

  return { isDestructive: false };
}

export function executeSandboxedQuery(
  db: Database,
  rawSql: string
):
  | { ok: true; sanitizedSql: string; output: SqlExecutionOutput }
  | {
      ok: false;
      sanitizedSql: string;
      errorType: 'security_blocked' | 'sqlite_error';
      errorMessage: string;
      latencyMs: number;
    } {
  const start = performance.now();
  const validation = validateReadOnlySql(rawSql);
  if (!validation.allowed) {
    return {
      ok: false,
      sanitizedSql: validation.sanitizedSql,
      errorType: 'security_blocked',
      errorMessage: validation.violationReason || 'Blocked by read-only guardrail.',
      latencyMs: Math.max(1, Math.round(performance.now() - start)),
    };
  }

  try {
    const execResults = db.exec(validation.sanitizedSql);
    const elapsed = Math.max(1, Math.round(performance.now() - start));

    if (!execResults || execResults.length === 0) {
      let columns: string[] = [];
      try {
        const stmt = db.prepare(validation.sanitizedSql);
        columns = stmt.getColumnNames();
        stmt.free();
      } catch {
        columns = [];
      }
      return {
        ok: true,
        sanitizedSql: validation.sanitizedSql,
        output: {
          columns,
          rows: [],
          rowCount: 0,
          totalMatchedRows: 0,
          truncated: false,
          executionLatencyMs: elapsed,
        },
      };
    }

    const firstResult = execResults[0];
    const columns = firstResult.columns;
    const totalMatchedRows = firstResult.values.length;
    const truncated = totalMatchedRows > MAX_RESULT_ROWS;
    const slicedValues = truncated
      ? firstResult.values.slice(0, MAX_RESULT_ROWS)
      : firstResult.values;

    const rows: Record<string, string | number | null>[] = slicedValues.map(
      (rowArr) => {
        const record: Record<string, string | number | null> = {};
        columns.forEach((col, idx) => {
          const val = rowArr[idx];
          if (val instanceof Uint8Array) {
            record[col] = Buffer.from(val).toString('utf-8');
          } else {
            record[col] = (val as string | number | null) ?? null;
          }
        });
        return record;
      }
    );

    return {
      ok: true,
      sanitizedSql: validation.sanitizedSql,
      output: {
        columns,
        rows,
        rowCount: rows.length,
        totalMatchedRows,
        truncated,
        executionLatencyMs: elapsed,
      },
    };
  } catch (err: unknown) {
    const elapsed = Math.max(1, Math.round(performance.now() - start));
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      sanitizedSql: validation.sanitizedSql,
      errorType: 'sqlite_error',
      errorMessage: message,
      latencyMs: elapsed,
    };
  }
}
