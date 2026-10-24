import path from 'path';
import Papa from 'papaparse';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type {
  CategoryFrequencyItem,
  ColumnProfile,
  DatasetFormatType,
  DirtyTokenSummary,
  ForeignKeyCandidate,
  InferredSemanticType,
  NumericColumnSummary,
  TableProfile,
  WorkspaceSchemaState,
} from '../src/types/domain.ts';
import type { RawCsvFileInput } from './sampleData.ts';

let sqlJsInstancePromise: Promise<SqlJsStatic> | null = null;

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsInstancePromise) {
    sqlJsInstancePromise = initSqlJs({
      locateFile: (file: string) =>
        path.resolve(process.cwd(), 'node_modules/sql.js/dist', file),
    });
  }
  return sqlJsInstancePromise;
}

export const SENTINEL_DIRTY_TOKENS = new Set([
  'UNKNOWN',
  'ERROR',
  'N/A',
  'NA',
  'NULL',
  'NONE',
  'TBD',
  'MISSING',
  'UNDEFINED',
  'NAN',
  '-',
  '--',
]);

export function sanitizeIdentifier(raw: string, fallbackPrefix = 'col'): string {
  const withoutExt = raw
    .replace(/^\uFEFF/, '')
    .replace(/\.(csv|tsv|xlsx|xls|sqlite|sqlite3|db|sql|json)$/i, '');
  const cleaned = withoutExt
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cleaned) {
    return fallbackPrefix;
  }
  if (/^[0-9]/.test(cleaned)) {
    return `${fallbackPrefix}_${cleaned}`;
  }
  return cleaned;
}

function isValidIsoOrSlashDate(trimmed: string): boolean {
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return false;
    }
    const dt = new Date(Date.UTC(year, month - 1, day));
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  const usMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    const year = Number(usMatch[3]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return false;
    }
    const dt = new Date(Date.UTC(year, month - 1, day));
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  return false;
}

function looksDateLikeHeader(header: string): boolean {
  return /\b(date|time|created|updated|signup|shipped|ship|timestamp|day|dob|hire)\b/i.test(
    header
  );
}

function looksIdLikeHeader(header: string): boolean {
  return /\b(id|code|uuid|key|sku|num|number)\b/i.test(header);
}

function buildDefensiveExpression(
  colName: string,
  inferredType: InferredSemanticType,
  dirtyProfile: DirtyTokenSummary
): string {
  const qCol = `"${colName}"`;
  if (inferredType === 'numeric_dirty') {
    let stripExpr = `TRIM(${qCol})`;
    if (dirtyProfile.currencyFormattedCount > 0) {
      stripExpr = `REPLACE(REPLACE(REPLACE(${stripExpr}, '$', ''), '€', ''), '£', '')`;
    }
    if (dirtyProfile.commaFormattedCount > 0) {
      stripExpr = `REPLACE(${stripExpr}, ',', '')`;
    }
    if (dirtyProfile.percentFormattedCount > 0) {
      stripExpr = `REPLACE(${stripExpr}, '%', '')`;
    }
    return `CASE WHEN ${qCol} IS NULL OR UPPER(TRIM(${qCol})) IN ('', 'UNKNOWN', 'ERROR', 'N/A', 'NA', 'NULL', 'NONE', 'TBD', '-') THEN NULL ELSE CAST(TRIM(${stripExpr}) AS REAL) END`;
  }

  if (inferredType === 'numeric_clean') {
    return `CAST(${qCol} AS REAL)`;
  }

  if (inferredType === 'date_dirty') {
    return `CASE WHEN ${qCol} IS NULL OR UPPER(TRIM(${qCol})) IN ('', 'UNKNOWN', 'ERROR', 'N/A', 'TBD', 'NULL') OR TRIM(${qCol}) NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' THEN NULL ELSE TRIM(${qCol}) END`;
  }

  if (dirtyProfile.whitespacePaddedCount > 0 || dirtyProfile.totalDirtyCount > 0) {
    return `CASE WHEN ${qCol} IS NULL OR UPPER(TRIM(${qCol})) IN ('', 'UNKNOWN', 'ERROR', 'N/A', 'NULL') THEN NULL ELSE TRIM(${qCol}) END`;
  }

  return `TRIM(${qCol})`;
}

function computeNumericSummary(nums: number[]): NumericColumnSummary | undefined {
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;
  const mid = Math.floor(count / 2);
  const median =
    count % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    validCount: count,
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
  };
}

export function profileColumn(
  columnName: string,
  sourceHeader: string,
  rawValues: (string | null | undefined)[]
): ColumnProfile {
  const totalRows = rawValues.length;
  let nullOrEmptyCount = 0;
  let whitespacePaddedCount = 0;
  let currencyFormattedCount = 0;
  let commaFormattedCount = 0;
  let percentFormattedCount = 0;
  let invalidDateCount = 0;
  const sentinelTokens: Record<string, number> = {};

  const sampleCleanSet = new Set<string>();
  const sampleDirtySet = new Set<string>();
  const normalizedNonDirtyValues: string[] = [];
  const parsedCleanNumbers: number[] = [];
  const categoryCounter = new Map<string, { display: string; count: number }>();

  let numericCandidateCount = 0;
  let plainNumericCount = 0;
  let validDateCount = 0;

  const headerLooksDate = looksDateLikeHeader(sourceHeader);
  const headerLooksId = looksIdLikeHeader(sourceHeader);

  for (const rawVal of rawValues) {
    if (rawVal === null || rawVal === undefined || rawVal === '') {
      nullOrEmptyCount++;
      sampleDirtySet.add('EMPTY/NULL');
      continue;
    }

    const strVal = String(rawVal);
    const trimmed = strVal.trim();

    if (trimmed === '') {
      nullOrEmptyCount++;
      whitespacePaddedCount++;
      sampleDirtySet.add(JSON.stringify(strVal));
      continue;
    }

    const hasPadding = strVal !== trimmed;
    if (hasPadding) {
      whitespacePaddedCount++;
      sampleDirtySet.add(`"${strVal}"`);
    }

    const upper = trimmed.toUpperCase();
    if (SENTINEL_DIRTY_TOKENS.has(upper)) {
      sentinelTokens[upper] = (sentinelTokens[upper] || 0) + 1;
      sampleDirtySet.add(trimmed);
      continue;
    }

    const hasCurrency = /^[$€£]\s*-?\d|-\s*[$€£]\s*\d/.test(trimmed);
    const strippedNumeric = trimmed
      .replace(/[$€£%\s]/g, '')
      .replace(/,/g, '');
    const isNumericAfterStrip =
      strippedNumeric.length > 0 && /^-?\d+(\.\d+)?$/.test(strippedNumeric);
    const isPlainNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);

    if (isNumericAfterStrip) {
      numericCandidateCount++;
      const parsedNum = Number(strippedNumeric);
      if (Number.isFinite(parsedNum)) {
        parsedCleanNumbers.push(parsedNum);
      }
      if (isPlainNumeric && !hasPadding) {
        plainNumericCount++;
      } else {
        if (hasCurrency || /[$€£]/.test(trimmed)) {
          currencyFormattedCount++;
          sampleDirtySet.add(strVal);
        }
        if (trimmed.includes(',')) {
          commaFormattedCount++;
          sampleDirtySet.add(strVal);
        }
        if (trimmed.includes('%')) {
          percentFormattedCount++;
          sampleDirtySet.add(strVal);
        }
      }
    }

    if (isValidIsoOrSlashDate(trimmed)) {
      validDateCount++;
    } else if (headerLooksDate) {
      invalidDateCount++;
      sampleDirtySet.add(trimmed);
    }

    normalizedNonDirtyValues.push(trimmed);
    const catKey = upper;
    const prevCat = categoryCounter.get(catKey);
    if (prevCat) {
      prevCat.count++;
    } else {
      categoryCounter.set(catKey, { display: trimmed, count: 1 });
    }

    if (!hasPadding && sampleCleanSet.size < 5) {
      sampleCleanSet.add(trimmed);
    }
  }

  for (const v of normalizedNonDirtyValues) {
    if (sampleCleanSet.size >= 5) break;
    sampleCleanSet.add(v);
  }

  const sentinelSum = Object.values(sentinelTokens).reduce((a, b) => a + b, 0);
  const nonSentinelCount = totalRows - nullOrEmptyCount - sentinelSum;

  let inferredType: InferredSemanticType = 'text';
  if (
    nonSentinelCount > 0 &&
    !headerLooksId &&
    numericCandidateCount / nonSentinelCount >= 0.8
  ) {
    const hasDirtyFormatting =
      currencyFormattedCount > 0 ||
      commaFormattedCount > 0 ||
      percentFormattedCount > 0 ||
      sentinelSum > 0 ||
      whitespacePaddedCount > 0 ||
      plainNumericCount < nonSentinelCount;
    inferredType = hasDirtyFormatting ? 'numeric_dirty' : 'numeric_clean';
  } else if (
    nonSentinelCount > 0 &&
    numericCandidateCount === nonSentinelCount &&
    plainNumericCount === nonSentinelCount &&
    headerLooksId &&
    new Set(normalizedNonDirtyValues).size === totalRows
  ) {
    // Pure integer primary key IDs (1, 2, 3...)
    inferredType = 'identifier';
  } else if (
    (headerLooksDate && nonSentinelCount > 0 && validDateCount / nonSentinelCount >= 0.4) ||
    (nonSentinelCount > 0 && validDateCount / nonSentinelCount >= 0.7)
  ) {
    const hasDirtyDates =
      invalidDateCount > 0 || sentinelSum > 0 || whitespacePaddedCount > 0;
    inferredType = hasDirtyDates ? 'date_dirty' : 'date_clean';
  } else {
    const distinctNormalized = categoryCounter.size;
    if (
      headerLooksId ||
      (distinctNormalized === nonSentinelCount &&
        nonSentinelCount >= 4 &&
        /[-_0-9]/.test(normalizedNonDirtyValues[0] || ''))
    ) {
      inferredType = 'identifier';
    } else if (
      nonSentinelCount > 0 &&
      distinctNormalized <= Math.max(10, Math.floor(nonSentinelCount * 0.6))
    ) {
      inferredType = 'categorical';
    } else {
      inferredType = 'text';
    }
  }

  let dirtyRowCounter = 0;
  for (const rawVal of rawValues) {
    if (rawVal === null || rawVal === undefined || rawVal === '') {
      dirtyRowCounter++;
      continue;
    }
    const strVal = String(rawVal);
    const trimmed = strVal.trim();
    const upper = trimmed.toUpperCase();
    if (
      trimmed === '' ||
      strVal !== trimmed ||
      SENTINEL_DIRTY_TOKENS.has(upper) ||
      (inferredType === 'numeric_dirty' && !/^-?\d+(\.\d+)?$/.test(strVal)) ||
      (inferredType === 'date_dirty' && !/^\d{4}-\d{2}-\d{2}$/.test(strVal))
    ) {
      dirtyRowCounter++;
    }
  }

  const distinctSet = new Set(
    normalizedNonDirtyValues.map((v) => v.trim().toUpperCase())
  );

  const isCandidatePrimaryKey =
    totalRows > 0 &&
    nullOrEmptyCount === 0 &&
    sentinelSum === 0 &&
    distinctSet.size === totalRows &&
    (inferredType === 'identifier' || headerLooksId);

  const nullRate =
    totalRows > 0 ? Number(((nullOrEmptyCount / totalRows) * 100).toFixed(1)) : 0;
  const dirtyRate =
    totalRows > 0 ? Number(((dirtyRowCounter / totalRows) * 100).toFixed(1)) : 0;

  const dirtyProfile: DirtyTokenSummary = {
    nullOrEmptyCount,
    sentinelTokens,
    whitespacePaddedCount,
    currencyFormattedCount,
    commaFormattedCount,
    percentFormattedCount,
    invalidDateCount,
    totalDirtyCount: dirtyRowCounter,
    dirtyRate,
  };

  // Numeric stats for numeric columns
  const numericStats =
    inferredType === 'numeric_clean' || inferredType === 'numeric_dirty'
      ? computeNumericSummary(parsedCleanNumbers)
      : undefined;

  // Category frequencies for categorical/text columns
  let topCategories: CategoryFrequencyItem[] | undefined;
  if (
    (inferredType === 'categorical' || inferredType === 'text') &&
    nonSentinelCount > 0
  ) {
    topCategories = Array.from(categoryCounter.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map((item) => ({
        value: item.display,
        count: item.count,
        percentage: Number(((item.count / totalRows) * 100).toFixed(1)),
      }));
  }

  // Generate column data-quality warnings
  const warnings: string[] = [];
  if (nullOrEmptyCount > 0) {
    warnings.push(`${nullOrEmptyCount} missing/empty value(s) (${nullRate}%)`);
  }
  if (sentinelSum > 0) {
    const tokSummary = Object.entries(sentinelTokens)
      .map(([k, c]) => `${k}×${c}`)
      .join(', ');
    warnings.push(`Sentinel dirty tokens detected: ${tokSummary}`);
  }
  if (currencyFormattedCount > 0 || commaFormattedCount > 0) {
    warnings.push(
      'Formatted numeric strings ($/commas) require REPLACE() before CAST AS REAL'
    );
  }
  if (whitespacePaddedCount > 0) {
    warnings.push(
      `${whitespacePaddedCount} value(s) have leading/trailing whitespace; use TRIM()`
    );
  }
  if (invalidDateCount > 0) {
    warnings.push(`${invalidDateCount} malformed date string(s) detected`);
  }

  const sqliteDeclaredType: 'TEXT' | 'REAL' | 'INTEGER' =
    inferredType === 'numeric_clean' ? 'REAL' : 'TEXT';

  return {
    columnName,
    sourceHeader,
    sqliteDeclaredType,
    inferredType,
    totalRows,
    nonEmptyCount: totalRows - nullOrEmptyCount,
    nullRate,
    distinctCount: distinctSet.size,
    isCandidatePrimaryKey,
    sampleCleanValues: Array.from(sampleCleanSet).slice(0, 4),
    sampleDirtyValues: Array.from(sampleDirtySet).slice(0, 5),
    dirtyProfile,
    numericStats,
    topCategories,
    warnings,
    defensiveSqlExpression: buildDefensiveExpression(
      columnName,
      inferredType,
      dirtyProfile
    ),
  };
}

export interface IngestedWorkspaceRuntime {
  db: Database;
  schemaState: WorkspaceSchemaState;
}

export async function ingestCsvFilesToSqlite(
  files: RawCsvFileInput[],
  datasetLabel = 'Uploaded CSV Dataset',
  options?: {
    datasetId?: string;
    format?: DatasetFormatType;
  }
): Promise<IngestedWorkspaceRuntime> {
  if (!files || files.length === 0) {
    throw new Error('No dataset files were provided for ingestion.');
  }

  const SQL = await getSqlJs();
  const db = new SQL.Database();

  try {
    const tables: TableProfile[] = [];
    const usedTableNames = new Set<string>();
    const normalizedColumnValueSets = new Map<
      string,
      { rawValues: string[]; trimmedUpperSet: Set<string>; hadWhitespace: boolean }
    >();

    for (const file of files) {
      const cleanCsvText = (file.csvContent || '').replace(/^\uFEFF/, '').trim();
      if (!cleanCsvText) {
        throw new Error(`Uploaded file "${file.fileName}" is empty.`);
      }

      let baseTableName = sanitizeIdentifier(file.fileName, 'table');
      let suffix = 2;
      while (usedTableNames.has(baseTableName)) {
        baseTableName = `${sanitizeIdentifier(file.fileName, 'table')}_${suffix++}`;
      }
      usedTableNames.add(baseTableName);

      const parsed = Papa.parse<Record<string, string>>(cleanCsvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
      });

      const sourceHeaders = (parsed.meta.fields || []).filter(
        (h) => typeof h === 'string' && h.trim().length > 0
      );
      if (sourceHeaders.length === 0) {
        throw new Error(
          `Could not detect valid column headers in "${file.fileName}". Please check that the file is a valid CSV/TSV.`
        );
      }

      const usedColNames = new Set<string>();
      const colMapping: { sourceHeader: string; columnName: string }[] = [];

      for (const srcHeader of sourceHeaders) {
        let colName = sanitizeIdentifier(srcHeader, 'col');
        let colSuffix = 2;
        while (usedColNames.has(colName)) {
          colName = `${sanitizeIdentifier(srcHeader, 'col')}_${colSuffix++}`;
        }
        usedColNames.add(colName);
        colMapping.push({ sourceHeader: srcHeader, columnName: colName });
      }

      const rowsData = parsed.data;
      const columnProfiles: ColumnProfile[] = [];

      for (const { sourceHeader, columnName } of colMapping) {
        const colRawValues = rowsData.map((r) => {
          const val = r[sourceHeader];
          return val === undefined || val === '' ? null : val;
        });
        const profile = profileColumn(columnName, sourceHeader, colRawValues);
        columnProfiles.push(profile);

        const nonNullStrings = colRawValues.filter((v): v is string => v !== null);
        const trimmedSet = new Set(
          nonNullStrings
            .map((v) => v.trim().toUpperCase())
            .filter((v) => v.length > 0 && !SENTINEL_DIRTY_TOKENS.has(v))
        );
        normalizedColumnValueSets.set(`${baseTableName}.${columnName}`, {
          rawValues: nonNullStrings,
          trimmedUpperSet: trimmedSet,
          hadWhitespace: profile.dirtyProfile.whitespacePaddedCount > 0,
        });
      }

      const colDefs = columnProfiles
        .map((c) => `"${c.columnName}" ${c.sqliteDeclaredType}`)
        .join(', ');
      db.run(`CREATE TABLE "${baseTableName}" (${colDefs});`);

      const placeholders = columnProfiles.map(() => '?').join(', ');
      const insertStmt = db.prepare(
        `INSERT INTO "${baseTableName}" VALUES (${placeholders});`
      );

      const sampleRows: Record<string, string | number | null>[] = [];
      const rowFingerprints = new Set<string>();
      let duplicateRowCount = 0;

      db.run('BEGIN TRANSACTION;');
      try {
        for (let i = 0; i < rowsData.length; i++) {
          const rowObj = rowsData[i];
          const bindRow: (string | number | null)[] = [];
          const sampleRecord: Record<string, string | number | null> = {};

          for (const colProf of columnProfiles) {
            const rawCell = rowObj[colProf.sourceHeader];
            if (rawCell === undefined || rawCell === '') {
              bindRow.push(null);
              sampleRecord[colProf.columnName] = null;
            } else if (colProf.sqliteDeclaredType === 'REAL') {
              const num = Number(rawCell.trim());
              const val = Number.isNaN(num) ? rawCell : num;
              bindRow.push(val);
              sampleRecord[colProf.columnName] = val;
            } else {
              bindRow.push(rawCell);
              sampleRecord[colProf.columnName] = rawCell;
            }
          }

          const fingerprint = JSON.stringify(bindRow);
          if (rowFingerprints.has(fingerprint)) {
            duplicateRowCount++;
          } else {
            rowFingerprints.add(fingerprint);
          }

          insertStmt.run(bindRow);
          if (sampleRows.length < 100) {
            sampleRows.push(sampleRecord);
          }
        }
        db.run('COMMIT;');
      } catch (txErr) {
        db.run('ROLLBACK;');
        throw txErr;
      } finally {
        insertStmt.free();
      }

      const tableWarnings: string[] = [];
      if (rowsData.length === 0) {
        tableWarnings.push('Table contains headers only (0 data rows).');
      }
      if (duplicateRowCount > 0) {
        tableWarnings.push(
          `${duplicateRowCount} exact duplicate row(s) detected in table.`
        );
      }
      const dirtyColCount = columnProfiles.filter(
        (c) => c.dirtyProfile.totalDirtyCount > 0
      ).length;
      if (dirtyColCount > 0) {
        tableWarnings.push(
          `${dirtyColCount} of ${columnProfiles.length} column(s) contain missing, formatted, or sentinel values.`
        );
      }

      tables.push({
        tableName: baseTableName,
        sourceFileName: file.fileName,
        rowCount: rowsData.length,
        duplicateRowCount,
        columns: columnProfiles,
        warnings: tableWarnings,
        sampleRows,
      });
    }

    if (tables.length === 0) {
      throw new Error('No valid tables could be parsed from the uploaded file(s).');
    }

    // Discover candidate Foreign Key relationships across tables
    const foreignKeys: ForeignKeyCandidate[] = [];
    for (const parentTable of tables) {
      for (const parentCol of parentTable.columns) {
        if (!parentCol.isCandidatePrimaryKey) continue;
        const parentInfo = normalizedColumnValueSets.get(
          `${parentTable.tableName}.${parentCol.columnName}`
        );
        if (!parentInfo || parentInfo.trimmedUpperSet.size === 0) continue;

        for (const childTable of tables) {
          if (childTable.tableName === parentTable.tableName) continue;
          for (const childCol of childTable.columns) {
            if (
              childCol.inferredType !== 'identifier' &&
              childCol.columnName !== parentCol.columnName &&
              !childCol.columnName.endsWith(`_${parentCol.columnName}`)
            ) {
              continue;
            }
            const childInfo = normalizedColumnValueSets.get(
              `${childTable.tableName}.${childCol.columnName}`
            );
            if (!childInfo || childInfo.trimmedUpperSet.size === 0) continue;

            let matched = 0;
            for (const val of childInfo.trimmedUpperSet) {
              if (parentInfo.trimmedUpperSet.has(val)) {
                matched++;
              }
            }
            const matchRatio = matched / childInfo.trimmedUpperSet.size;
            if (matchRatio >= 0.7) {
              foreignKeys.push({
                fromTable: childTable.tableName,
                fromColumn: childCol.columnName,
                toTable: parentTable.tableName,
                toColumn: parentCol.columnName,
                matchRatio: Number((matchRatio * 100).toFixed(1)),
                requiresTrimJoin: parentInfo.hadWhitespace || childInfo.hadWhitespace,
              });
            }
          }
        }
      }
    }

    return {
      db,
      schemaState: {
        datasetId: options?.datasetId || `ds_${Date.now().toString(36)}`,
        datasetLabel,
        format: options?.format || 'csv',
        fileNames: files.map((f) => f.fileName),
        tables,
        foreignKeys,
        ingestedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
