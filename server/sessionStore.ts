import crypto from 'node:crypto';
import type { Request } from 'express';
import type {
  DatasetFormatType,
  DatasetSummaryItem,
  WorkspaceSchemaState,
} from '../src/types/domain.ts';
import {
  ingestCsvFilesToSqlite,
  type IngestedWorkspaceRuntime,
} from './csvIngestor.ts';
import {
  EXTRA_SHIPMENTS_CSV,
  getDefaultDatasetFiles,
  type RawCsvFileInput,
} from './sampleData.ts';
import { introspectSqliteDatabase } from './universalDbLoader.ts';

export interface StoredDatasetEntry {
  datasetId: string;
  runtime: IngestedWorkspaceRuntime;
  backingCsvFiles: RawCsvFileInput[] | null;
  format: DatasetFormatType;
  fileNames: string[];
  uploadedAt: string;
  isDefaultSample: boolean;
}

interface UserSessionState {
  sessionId: string;
  datasets: Map<string, StoredDatasetEntry>;
  activeDatasetId: string | null;
  lastAccessedAt: number;
}

const MAX_ACTIVE_SESSIONS = 100;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_DATASETS_PER_SESSION = 15;

const sessions = new Map<string, UserSessionState>();

export function extractSessionId(req: Request): string {
  const rawHeader = req.header('X-Workspace-Session') || '';
  const cleaned = rawHeader.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleaned.length >= 8 && cleaned.length <= 64) {
    return cleaned;
  }
  return 'sess_anonymous_default';
}

function evictStaleSessions() {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
      closeSession(session);
      sessions.delete(sid);
    }
  }
  while (sessions.size > MAX_ACTIVE_SESSIONS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [sid, session] of sessions.entries()) {
      if (session.lastAccessedAt < oldestTime) {
        oldestTime = session.lastAccessedAt;
        oldestKey = sid;
      }
    }
    if (!oldestKey) break;
    const evicted = sessions.get(oldestKey);
    if (evicted) closeSession(evicted);
    sessions.delete(oldestKey);
  }
}

function closeSession(session: UserSessionState) {
  for (const entry of session.datasets.values()) {
    try {
      entry.runtime.db.close();
    } catch {
      // ignore close error
    }
  }
  session.datasets.clear();
}

function buildDatasetSummaries(session: UserSessionState): DatasetSummaryItem[] {
  const items: DatasetSummaryItem[] = [];
  for (const entry of session.datasets.values()) {
    const tables = entry.runtime.schemaState.tables;
    const totalRows = tables.reduce((acc, t) => acc + t.rowCount, 0);
    items.push({
      datasetId: entry.datasetId,
      datasetLabel: entry.runtime.schemaState.datasetLabel,
      format: entry.format,
      fileNames: entry.fileNames,
      tableCount: tables.length,
      totalRows,
      uploadedAt: entry.uploadedAt,
      isDefaultSample: entry.isDefaultSample,
    });
  }
  return items;
}

export function serializeSessionWorkspaceState(
  session: UserSessionState
): WorkspaceSchemaState {
  const summaries = buildDatasetSummaries(session);
  const activeEntry = session.activeDatasetId
    ? session.datasets.get(session.activeDatasetId)
    : undefined;

  if (!activeEntry) {
    return {
      datasetId: '',
      datasetLabel: 'No Dataset Loaded',
      format: 'csv',
      fileNames: [],
      tables: [],
      foreignKeys: [],
      ingestedAt: new Date().toISOString(),
      availableDatasets: summaries,
    };
  }

  return {
    ...activeEntry.runtime.schemaState,
    datasetId: activeEntry.datasetId,
    format: activeEntry.format,
    fileNames: activeEntry.fileNames,
    availableDatasets: summaries,
  };
}

export async function getOrInitSession(
  sessionId: string
): Promise<UserSessionState> {
  evictStaleSessions();
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const datasetId = 'ds_sample_commerce';
  const defaultFiles = getDefaultDatasetFiles();
  const runtime = await ingestCsvFilesToSqlite(
    defaultFiles,
    'Sample Commerce (customers.csv + orders.csv)',
    { datasetId, format: 'sample' }
  );

  const newSession: UserSessionState = {
    sessionId,
    datasets: new Map([
      [
        datasetId,
        {
          datasetId,
          runtime,
          backingCsvFiles: defaultFiles,
          format: 'sample',
          fileNames: defaultFiles.map((f) => f.fileName),
          uploadedAt: new Date().toISOString(),
          isDefaultSample: true,
        },
      ],
    ]),
    activeDatasetId: datasetId,
    lastAccessedAt: Date.now(),
  };

  sessions.set(sessionId, newSession);
  return newSession;
}

export function getActiveDatasetForSession(
  session: UserSessionState,
  requestedDatasetId?: string
): StoredDatasetEntry {
  if (requestedDatasetId) {
    const requested = session.datasets.get(requestedDatasetId);
    if (!requested) {
      throw new Error(
        `Selected dataset "${requestedDatasetId}" was not found in your current session. Please select or upload a dataset.`
      );
    }
    session.activeDatasetId = requestedDatasetId;
    return requested;
  }

  if (!session.activeDatasetId) {
    throw new Error(
      'No active dataset is loaded in your workspace. Please upload a CSV, Excel, or SQLite dataset first.'
    );
  }

  const entry = session.datasets.get(session.activeDatasetId);
  if (!entry) {
    throw new Error(
      'Active dataset is no longer available. Please select or upload a dataset.'
    );
  }
  return entry;
}

export function registerNewDatasetInSession(
  session: UserSessionState,
  runtime: IngestedWorkspaceRuntime,
  options: {
    format: DatasetFormatType;
    fileNames: string[];
    backingCsvFiles: RawCsvFileInput[] | null;
    isDefaultSample?: boolean;
    customDatasetId?: string;
  }
): WorkspaceSchemaState {
  // Enforce per-session dataset cap
  while (session.datasets.size >= MAX_DATASETS_PER_SESSION) {
    const oldestId = session.datasets.keys().next().value;
    if (!oldestId) break;
    const oldEntry = session.datasets.get(oldestId);
    if (oldEntry) {
      try {
        oldEntry.runtime.db.close();
      } catch {
        // ignore
      }
      session.datasets.delete(oldestId);
    }
  }

  const datasetId =
    options.customDatasetId ||
    runtime.schemaState.datasetId ||
    `ds_${crypto.randomUUID().slice(0, 8)}`;

  runtime.schemaState.datasetId = datasetId;
  runtime.schemaState.format = options.format;
  runtime.schemaState.fileNames = options.fileNames;

  const entry: StoredDatasetEntry = {
    datasetId,
    runtime,
    backingCsvFiles: options.backingCsvFiles,
    format: options.format,
    fileNames: options.fileNames,
    uploadedAt: new Date().toISOString(),
    isDefaultSample: Boolean(options.isDefaultSample),
  };

  session.datasets.set(datasetId, entry);
  session.activeDatasetId = datasetId;
  session.lastAccessedAt = Date.now();

  return serializeSessionWorkspaceState(session);
}

export async function appendCsvTablesToActiveDataset(
  session: UserSessionState,
  incomingFiles: RawCsvFileInput[],
  datasetLabel?: string
): Promise<WorkspaceSchemaState> {
  const active = session.activeDatasetId
    ? session.datasets.get(session.activeDatasetId)
    : undefined;

  if (!active || active.isDefaultSample) {
    // If appending when no custom dataset exists (or when on built-in sample), if active exists and is sample, merge with sample or create custom
    if (!active) {
      const label =
        datasetLabel ||
        `Dataset (${incomingFiles.map((f) => f.fileName).join(' + ')})`;
      const runtime = await ingestCsvFilesToSqlite(incomingFiles, label, {
        format: 'csv',
      });
      return registerNewDatasetInSession(session, runtime, {
        format: 'csv',
        fileNames: incomingFiles.map((f) => f.fileName),
        backingCsvFiles: incomingFiles,
      });
    }
  }

  if (active.backingCsvFiles) {
    const incomingNames = new Set(
      incomingFiles.map((f) => f.fileName.toLowerCase())
    );
    const mergedFiles = [
      ...active.backingCsvFiles.filter(
        (existing) => !incomingNames.has(existing.fileName.toLowerCase())
      ),
      ...incomingFiles,
    ];
    const nextLabel =
      datasetLabel ||
      `Dataset (${mergedFiles.map((f) => f.fileName).join(' + ')})`;
    const nextRuntime = await ingestCsvFilesToSqlite(mergedFiles, nextLabel, {
      datasetId: active.datasetId,
      format: active.format === 'sample' ? 'csv' : active.format,
    });
    try {
      active.runtime.db.close();
    } catch {
      // ignore
    }
    active.runtime = nextRuntime;
    active.backingCsvFiles = mergedFiles;
    active.fileNames = mergedFiles.map((f) => f.fileName);
    active.isDefaultSample = false;
    if (active.format === 'sample') active.format = 'csv';
    return serializeSessionWorkspaceState(session);
  }

  // Append CSV tables directly onto an existing SQLite / SQL database in place
  const tempCsvRuntime = await ingestCsvFilesToSqlite(incomingFiles, 'temp');
  try {
    for (const tbl of tempCsvRuntime.schemaState.tables) {
      active.runtime.db.run(`DROP TABLE IF EXISTS "${tbl.tableName}";`);
      const colDefs = tbl.columns
        .map((c) => `"${c.columnName}" ${c.sqliteDeclaredType}`)
        .join(', ');
      active.runtime.db.run(`CREATE TABLE "${tbl.tableName}" (${colDefs});`);
      const allRowsRes = tempCsvRuntime.db.exec(
        `SELECT * FROM "${tbl.tableName}";`
      );
      if (allRowsRes.length > 0) {
        const placeholders = tbl.columns.map(() => '?').join(', ');
        const stmt = active.runtime.db.prepare(
          `INSERT INTO "${tbl.tableName}" VALUES (${placeholders});`
        );
        active.runtime.db.run('BEGIN TRANSACTION;');
        try {
          for (const rowVals of allRowsRes[0].values) {
            stmt.run(rowVals as (string | number | null)[]);
          }
          active.runtime.db.run('COMMIT;');
        } catch (err) {
          active.runtime.db.run('ROLLBACK;');
          throw err;
        } finally {
          stmt.free();
        }
      }
    }
  } finally {
    tempCsvRuntime.db.close();
  }

  const combinedFileNames = Array.from(
    new Set([...active.fileNames, ...incomingFiles.map((f) => f.fileName)])
  );
  const refreshed = introspectSqliteDatabase(
    active.runtime.db,
    datasetLabel ||
      `${active.runtime.schemaState.datasetLabel} + ${incomingFiles.map((f) => f.fileName).join(', ')}`,
    combinedFileNames.join(', '),
    {
      datasetId: active.datasetId,
      format: active.format,
      fileNames: combinedFileNames,
    }
  );
  active.runtime = refreshed;
  active.fileNames = combinedFileNames;
  return serializeSessionWorkspaceState(session);
}

export function selectDatasetInSession(
  session: UserSessionState,
  datasetId: string
): WorkspaceSchemaState {
  const target = session.datasets.get(datasetId);
  if (!target) {
    throw new Error(`Dataset "${datasetId}" does not exist in your session.`);
  }
  session.activeDatasetId = datasetId;
  session.lastAccessedAt = Date.now();
  return serializeSessionWorkspaceState(session);
}

export async function refreshActiveDatasetSchema(
  session: UserSessionState
): Promise<WorkspaceSchemaState> {
  const active = getActiveDatasetForSession(session);
  if (active.backingCsvFiles) {
    const rebuilt = await ingestCsvFilesToSqlite(
      active.backingCsvFiles,
      active.runtime.schemaState.datasetLabel,
      {
        datasetId: active.datasetId,
        format: active.format,
      }
    );
    try {
      active.runtime.db.close();
    } catch {
      // ignore
    }
    active.runtime = rebuilt;
    return serializeSessionWorkspaceState(session);
  }

  const reIntrospected = introspectSqliteDatabase(
    active.runtime.db,
    active.runtime.schemaState.datasetLabel,
    active.fileNames.join(', ') || 'database.sqlite',
    {
      datasetId: active.datasetId,
      format: active.format,
      fileNames: active.fileNames,
    }
  );
  active.runtime = reIntrospected;
  return serializeSessionWorkspaceState(session);
}

export function removeDatasetFromSession(
  session: UserSessionState,
  datasetId: string
): WorkspaceSchemaState {
  const target = session.datasets.get(datasetId);
  if (!target) {
    throw new Error(`Dataset "${datasetId}" was not found in your session.`);
  }

  try {
    target.runtime.db.close();
  } catch {
    // ignore
  }
  session.datasets.delete(datasetId);

  if (session.activeDatasetId === datasetId) {
    // Pick most recently added remaining dataset, if any
    const remainingIds = Array.from(session.datasets.keys());
    session.activeDatasetId =
      remainingIds.length > 0 ? remainingIds[remainingIds.length - 1] : null;
  }

  session.lastAccessedAt = Date.now();
  return serializeSessionWorkspaceState(session);
}

export async function loadSamplePresetIntoSession(
  session: UserSessionState,
  preset: 'default' | 'three-table'
): Promise<WorkspaceSchemaState> {
  if (preset === 'three-table') {
    const files = [
      ...getDefaultDatasetFiles(),
      { fileName: 'shipments.csv', csvContent: EXTRA_SHIPMENTS_CSV },
    ];
    const datasetId = 'ds_sample_supply_chain';
    const existing = session.datasets.get(datasetId);
    if (existing) {
      try {
        existing.runtime.db.close();
      } catch {
        // ignore
      }
    }
    const runtime = await ingestCsvFilesToSqlite(
      files,
      'Sample Supply Chain (customers + orders + shipments)',
      { datasetId, format: 'sample' }
    );
    return registerNewDatasetInSession(session, runtime, {
      format: 'sample',
      fileNames: files.map((f) => f.fileName),
      backingCsvFiles: files,
      isDefaultSample: true,
      customDatasetId: datasetId,
    });
  }

  const files = getDefaultDatasetFiles();
  const datasetId = 'ds_sample_commerce';
  const existing = session.datasets.get(datasetId);
  if (existing) {
    try {
      existing.runtime.db.close();
    } catch {
      // ignore
    }
  }
  const runtime = await ingestCsvFilesToSqlite(
    files,
    'Sample Commerce (customers.csv + orders.csv)',
    { datasetId, format: 'sample' }
  );
  return registerNewDatasetInSession(session, runtime, {
    format: 'sample',
    fileNames: files.map((f) => f.fileName),
    backingCsvFiles: files,
    isDefaultSample: true,
    customDatasetId: datasetId,
  });
}
