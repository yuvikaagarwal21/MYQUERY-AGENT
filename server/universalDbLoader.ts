import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { Database } from 'sql.js';
import type {
  ColumnProfile,
  DatasetFormatType,
  ForeignKeyCandidate,
  TableProfile,
} from '../src/types/domain.ts';
import {
  getSqlJs,
  ingestCsvFilesToSqlite,
  profileColumn,
  sanitizeIdentifier,
  SENTINEL_DIRTY_TOKENS,
  type IngestedWorkspaceRuntime,
} from './csvIngestor.ts';
import type { RawCsvFileInput } from './sampleData.ts';

/**
 * Introspects any populated sql.js Database instance (e.g., from a binary .sqlite/.db file
 * or a user-provided .sql DDL + INSERT script), profiling every table, column, dirty token,
 * numeric summary, category frequency, duplicate row count, primary key, and foreign key.
 */
export function introspectSqliteDatabase(
  db: Database,
  datasetLabel: string,
  sourceName: string,
  options?: {
    datasetId?: string;
    format?: DatasetFormatType;
    fileNames?: string[];
  }
): IngestedWorkspaceRuntime {
  const masterRes = db.exec(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`
  );

  if (!masterRes || masterRes.length === 0 || masterRes[0].values.length === 0) {
    throw new Error(
      'No user tables were found in the uploaded database. Make sure the file contains at least one valid table.'
    );
  }

  const tableNames = masterRes[0].values.map((row) => String(row[0]));
  const tables: TableProfile[] = [];
  const explicitForeignKeys: ForeignKeyCandidate[] = [];
  const normalizedColumnValueSets = new Map<
    string,
    { trimmedUpperSet: Set<string>; hadWhitespace: boolean }
  >();

  for (const tableName of tableNames) {
    const qTable = `"${tableName.replace(/"/g, '""')}"`;

    const countRes = db.exec(`SELECT COUNT(*) FROM ${qTable};`);
    const totalRowCount =
      countRes.length > 0 && countRes[0].values.length > 0
        ? Number(countRes[0].values[0][0])
        : 0;

    // Duplicate row count via DISTINCT count
    let duplicateRowCount = 0;
    if (totalRowCount > 0 && totalRowCount <= 50000) {
      try {
        const distinctRes = db.exec(
          `SELECT COUNT(*) FROM (SELECT DISTINCT * FROM ${qTable});`
        );
        if (distinctRes.length > 0 && distinctRes[0].values.length > 0) {
          const distinctRows = Number(distinctRes[0].values[0][0]);
          duplicateRowCount = Math.max(0, totalRowCount - distinctRows);
        }
      } catch {
        duplicateRowCount = 0;
      }
    }

    const infoRes = db.exec(`PRAGMA table_info(${qTable});`);
    if (!infoRes || infoRes.length === 0) continue;

    const pragmaCols = infoRes[0].values.map((r) => ({
      name: String(r[1]),
      declaredType: String(r[2] || 'TEXT').toUpperCase(),
      isPk: Number(r[5]) > 0,
    }));

    try {
      const fkRes = db.exec(`PRAGMA foreign_key_list(${qTable});`);
      if (fkRes && fkRes.length > 0) {
        for (const fkRow of fkRes[0].values) {
          const refTable = String(fkRow[2]);
          const fromCol = String(fkRow[3]);
          const toCol = String(fkRow[4] || fromCol);
          explicitForeignKeys.push({
            fromTable: tableName,
            fromColumn: fromCol,
            toTable: refTable,
            toColumn: toCol,
            matchRatio: 100,
            requiresTrimJoin: false,
          });
        }
      }
    } catch {
      // ignore pragma error
    }

    const sampleQueryRes = db.exec(`SELECT * FROM ${qTable} LIMIT 2000;`);
    const fetchedRows =
      sampleQueryRes.length > 0 ? sampleQueryRes[0].values : [];
    const fetchedColNames =
      sampleQueryRes.length > 0
        ? sampleQueryRes[0].columns
        : pragmaCols.map((c) => c.name);

    const columnProfiles: ColumnProfile[] = pragmaCols.map((pCol) => {
      const colIdx = fetchedColNames.indexOf(pCol.name);
      const rawValues: (string | null)[] = fetchedRows.map((rowArr) => {
        const v = colIdx >= 0 ? rowArr[colIdx] : null;
        if (v === null || v === undefined) return null;
        if (v instanceof Uint8Array) {
          return Buffer.from(v).toString('utf-8');
        }
        return String(v);
      });

      const prof = profileColumn(pCol.name, pCol.name, rawValues);
      prof.totalRows = totalRowCount;
      if (pCol.isPk) {
        prof.isCandidatePrimaryKey = true;
      }
      if (/INT/i.test(pCol.declaredType)) {
        prof.sqliteDeclaredType = 'INTEGER';
      } else if (/REAL|FLOA|DOUB|NUM|DEC/i.test(pCol.declaredType)) {
        prof.sqliteDeclaredType = 'REAL';
      } else {
        prof.sqliteDeclaredType = 'TEXT';
      }

      const nonNullStrings = rawValues.filter((v): v is string => v !== null);
      const trimmedSet = new Set(
        nonNullStrings
          .map((v) => v.trim().toUpperCase())
          .filter((v) => v.length > 0 && !SENTINEL_DIRTY_TOKENS.has(v))
      );
      normalizedColumnValueSets.set(`${tableName}.${pCol.name}`, {
        trimmedUpperSet: trimmedSet,
        hadWhitespace: prof.dirtyProfile.whitespacePaddedCount > 0,
      });

      return prof;
    });

    const sampleRows: Record<string, string | number | null>[] = fetchedRows
      .slice(0, 100)
      .map((rowArr) => {
        const rec: Record<string, string | number | null> = {};
        fetchedColNames.forEach((colName, idx) => {
          const val = rowArr[idx];
          if (val instanceof Uint8Array) {
            rec[colName] = Buffer.from(val).toString('utf-8');
          } else {
            rec[colName] = (val as string | number | null) ?? null;
          }
        });
        return rec;
      });

    const tableWarnings: string[] = [];
    if (totalRowCount === 0) {
      tableWarnings.push('Table has 0 rows.');
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
      tableName,
      sourceFileName: sourceName,
      rowCount: totalRowCount,
      duplicateRowCount,
      columns: columnProfiles,
      warnings: tableWarnings,
      sampleRows,
    });
  }

  const fkKeySet = new Set(
    explicitForeignKeys.map(
      (fk) => `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`
    )
  );
  const foreignKeys: ForeignKeyCandidate[] = [...explicitForeignKeys];

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
            childCol.columnName.toLowerCase() !==
              parentCol.columnName.toLowerCase() &&
            !childCol.columnName
              .toLowerCase()
              .endsWith(`_${parentCol.columnName.toLowerCase()}`)
          ) {
            continue;
          }
          const relKey = `${childTable.tableName}.${childCol.columnName}->${parentTable.tableName}.${parentCol.columnName}`;
          if (fkKeySet.has(relKey)) continue;

          const childInfo = normalizedColumnValueSets.get(
            `${childTable.tableName}.${childCol.columnName}`
          );
          if (!childInfo || childInfo.trimmedUpperSet.size === 0) continue;

          let matched = 0;
          for (const val of childInfo.trimmedUpperSet) {
            if (parentInfo.trimmedUpperSet.has(val)) matched++;
          }
          const matchRatio = matched / childInfo.trimmedUpperSet.size;
          if (matchRatio >= 0.7) {
            fkKeySet.add(relKey);
            foreignKeys.push({
              fromTable: childTable.tableName,
              fromColumn: childCol.columnName,
              toTable: parentTable.tableName,
              toColumn: parentCol.columnName,
              matchRatio: Number((matchRatio * 100).toFixed(1)),
              requiresTrimJoin:
                parentInfo.hadWhitespace || childInfo.hadWhitespace,
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
      format: options?.format || 'sqlite',
      fileNames: options?.fileNames || [sourceName],
      tables,
      foreignKeys,
      ingestedAt: new Date().toISOString(),
    },
  };
}

/**
 * Loads a binary SQLite (.sqlite, .db, .sqlite3) buffer into sql.js and profiles all tables.
 */
export async function loadSqliteBinaryBuffer(
  base64Data: string,
  fileName: string,
  datasetLabel?: string,
  datasetId?: string
): Promise<IngestedWorkspaceRuntime> {
  const cleanBase64 = (base64Data || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanBase64) {
    throw new Error(`Uploaded SQLite file "${fileName}" is empty.`);
  }
  const binaryBuffer = Buffer.from(cleanBase64, 'base64');
  if (binaryBuffer.length < 16) {
    throw new Error(
      `Uploaded file "${fileName}" is too small or corrupted to be a valid SQLite database.`
    );
  }
  const magicHeader = binaryBuffer.subarray(0, 15).toString('utf-8');
  if (magicHeader !== 'SQLite format 3') {
    throw new Error(
      `Invalid SQLite file "${fileName}": file header does not match SQLite format 3.`
    );
  }

  const SQL = await getSqlJs();
  const uint8 = new Uint8Array(binaryBuffer);
  const db = new SQL.Database(uint8);

  try {
    return introspectSqliteDatabase(
      db,
      datasetLabel || `SQLite (${fileName})`,
      fileName,
      {
        datasetId,
        format: 'sqlite',
        fileNames: [fileName],
      }
    );
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Parses an Excel workbook (.xlsx, .xls) from base64 into CSV table inputs (one per non-empty sheet).
 */
export function convertExcelBase64ToCsvInputs(
  base64Data: string,
  fileName: string
): RawCsvFileInput[] {
  const cleanBase64 = (base64Data || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanBase64) {
    throw new Error(`Uploaded Excel file "${fileName}" is empty.`);
  }
  const buffer = Buffer.from(cleanBase64, 'base64');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new Error(
      `Failed to parse Excel workbook "${fileName}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error(`Excel workbook "${fileName}" contains no sheets.`);
  }

  const baseFileStem = sanitizeIdentifier(
    fileName.replace(/\.(xlsx|xls)$/i, ''),
    'workbook'
  );
  const csvInputs: RawCsvFileInput[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csvText = XLSX.utils
      .sheet_to_csv(sheet, { blankrows: false, dateNF: 'yyyy-mm-dd' })
      .trim();
    if (!csvText) continue;

    // Verify sheet has at least one header column
    const parsedCheck = Papa.parse(csvText, { header: true, preview: 2 });
    if (!parsedCheck.meta.fields || parsedCheck.meta.fields.length === 0) {
      continue;
    }

    const tableName =
      workbook.SheetNames.length === 1
        ? `${baseFileStem}.csv`
        : `${sanitizeIdentifier(sheetName, baseFileStem)}.csv`;

    csvInputs.push({
      fileName: tableName,
      csvContent: csvText,
    });
  }

  if (csvInputs.length === 0) {
    throw new Error(
      `Excel workbook "${fileName}" has no non-empty data worksheets.`
    );
  }

  return csvInputs;
}

/**
 * Executes a SQL schema + seed script (CREATE TABLE ...; INSERT INTO ...;) into a fresh
 * in-memory SQLite database and profiles all resulting tables.
 */
export async function loadSqlDumpScript(
  sqlScript: string,
  datasetLabel = 'Custom SQL Database',
  sourceFileName = 'schema.sql',
  datasetId?: string
): Promise<IngestedWorkspaceRuntime> {
  if (!sqlScript.trim()) {
    throw new Error('SQL script is empty.');
  }

  const SQL = await getSqlJs();
  const db = new SQL.Database();

  try {
    db.run(sqlScript);
    return introspectSqliteDatabase(db, datasetLabel, sourceFileName, {
      datasetId,
      format: 'sql',
      fileNames: [sourceFileName],
    });
  } catch (err) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to execute SQL setup script: ${message}`);
  }
}

/**
 * Converts a JSON string (either an array of row objects OR a map of { tableName: rowArray })
 * into CSV inputs.
 */
export function convertJsonToCsvInputs(
  jsonText: string,
  defaultFileName = 'data.json'
): RawCsvFileInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Invalid JSON syntax in "${defaultFileName}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const tableBase = sanitizeIdentifier(
    defaultFileName.replace(/\.json$/i, ''),
    'custom_table'
  );

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(`JSON array in "${defaultFileName}" is empty (0 records).`);
    }
    const csv = Papa.unparse(parsed as Record<string, unknown>[]);
    return [{ fileName: `${tableBase}.csv`, csvContent: csv }];
  }

  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>);
    const csvInputs: RawCsvFileInput[] = [];
    for (const [key, val] of entries) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        const csv = Papa.unparse(val as Record<string, unknown>[]);
        csvInputs.push({
          fileName: `${sanitizeIdentifier(key, 'table')}.csv`,
          csvContent: csv,
        });
      }
    }
    if (csvInputs.length > 0) {
      return csvInputs;
    }
  }

  throw new Error(
    'JSON must be either an array of row objects ([{...}]) or an object mapping table names to non-empty row arrays ({"users": [{...}]}).'
  );
}

/**
 * Fetches a public dataset URL (.sqlite, .db, .sql, .json, .csv, .tsv) and loads it into SQLite.
 */
export async function loadDatabaseFromUrl(
  rawUrl: string,
  customLabel?: string
): Promise<{
  runtime: IngestedWorkspaceRuntime;
  csvBackingFiles: RawCsvFileInput[] | null;
}> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error('Please enter a valid http:// or https:// URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const response = await fetch(parsedUrl.toString());
  if (!response.ok) {
    throw new Error(
      `Remote server returned HTTP ${response.status} (${response.statusText}).`
    );
  }

  const pathPart =
    parsedUrl.pathname.split('/').filter(Boolean).pop() || 'remote_data';
  const lowerPath = pathPart.toLowerCase();
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (
    lowerPath.endsWith('.sqlite') ||
    lowerPath.endsWith('.sqlite3') ||
    lowerPath.endsWith('.db') ||
    contentType.includes('application/x-sqlite3') ||
    contentType.includes('application/vnd.sqlite3')
  ) {
    const arrayBuf = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');
    const runtime = await loadSqliteBinaryBuffer(
      base64,
      pathPart,
      customLabel || `Remote SQLite (${pathPart})`
    );
    return { runtime, csvBackingFiles: null };
  }

  const textBody = await response.text();
  if (!textBody.trim()) {
    throw new Error('Fetched URL returned an empty body.');
  }

  if (
    lowerPath.endsWith('.sql') ||
    /^\s*(--|\/\*|CREATE\s+TABLE|BEGIN\s+TRANSACTION)/i.test(textBody)
  ) {
    const runtime = await loadSqlDumpScript(
      textBody,
      customLabel || `Remote SQL Database (${pathPart})`,
      pathPart
    );
    return { runtime, csvBackingFiles: null };
  }

  if (
    lowerPath.endsWith('.json') ||
    contentType.includes('application/json') ||
    /^\s*[\[{]/.test(textBody)
  ) {
    const csvFiles = convertJsonToCsvInputs(textBody, pathPart);
    const runtime = await ingestCsvFilesToSqlite(
      csvFiles,
      customLabel || `Remote JSON Database (${pathPart})`,
      { format: 'json' }
    );
    return { runtime, csvBackingFiles: csvFiles };
  }

  const fileName = lowerPath.endsWith('.csv') ? pathPart : `${pathPart}.csv`;
  const csvFiles: RawCsvFileInput[] = [{ fileName, csvContent: textBody }];
  const runtime = await ingestCsvFilesToSqlite(
    csvFiles,
    customLabel || `Remote CSV Database (${pathPart})`,
    { format: 'csv' }
  );
  return { runtime, csvBackingFiles: csvFiles };
}
