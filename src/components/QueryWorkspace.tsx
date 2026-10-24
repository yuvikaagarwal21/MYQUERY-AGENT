import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Download,
  FileSpreadsheet,
  HelpCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Upload,
  Wrench,
  XCircle,
} from 'lucide-react';
import type {
  PipelineQueryResponse,
  QueryHistoryEntry,
  SqlExecutionOutput,
  TableProfile,
  VerificationCheckItem,
  WorkspaceSchemaState,
} from '../types/domain';
import { apiFetch } from '../utils/apiClient';
import { uploadDatasetFiles } from '../utils/uploadHelper';

interface QueryWorkspaceProps {
  schemaState: WorkspaceSchemaState | null;
  bootLoading?: boolean;
  onSchemaUpdated: (nextState: WorkspaceSchemaState) => void;
  onNavigateToProfiler: () => void;
  queryHistory: QueryHistoryEntry[];
  onAddHistory: (entry: QueryHistoryEntry) => void;
  onClearHistory: () => void;
}

function downloadOutputAsCsv(output: SqlExecutionOutput) {
  const escapeCsvCell = (val: string | number | null): string => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerLine = output.columns.map((c) => escapeCsvCell(c)).join(',');
  const rowLines = output.rows.map((row) =>
    output.columns.map((col) => escapeCsvCell(row[col] ?? null)).join(',')
  );
  const csvString = [headerLine, ...rowLines].join('\n');

  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'query_output.csv';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildDynamicExampleQuestions(
  schemaState: WorkspaceSchemaState | null
): string[] {
  if (!schemaState || schemaState.tables.length === 0) return [];
  const examples: string[] = [];
  const primaryTable: TableProfile = schemaState.tables[0];
  const allCols = schemaState.tables.flatMap((t) => t.columns);

  const hasPerformanceLike = allCols.some((c) =>
    /perf|rating|kpi|score|eval|target|quota|productiv/i.test(
      `${c.columnName} ${c.sourceHeader}`
    )
  );
  const hasCompLike = allCols.some((c) =>
    /sal|pay|comp|wage|bonus|income/i.test(`${c.columnName} ${c.sourceHeader}`)
  );
  const hasProfitLike = allCols.some((c) =>
    /profit|margin|roi/i.test(`${c.columnName} ${c.sourceHeader}`)
  );
  const hasSalesOrCostLike = allCols.some((c) =>
    /sales|revenue|cost|spend|units/i.test(`${c.columnName} ${c.sourceHeader}`)
  );

  if (hasPerformanceLike && hasCompLike) {
    examples.push('Who deserves a raise?');
    examples.push('Which records are underpaid relative to their performance?');
  } else if (hasPerformanceLike) {
    examples.push('Who should be considered for promotion or recognition?');
    examples.push('Show records with performance below the dataset average.');
  } else if (hasProfitLike && hasSalesOrCostLike) {
    examples.push(
      'Which items or categories generate the highest profit relative to cost?'
    );
    examples.push(
      'Which items should be reviewed or discontinued based on sales and profitability?'
    );
  }

  const numCol = primaryTable.columns.find(
    (c) =>
      c.inferredType === 'numeric_clean' || c.inferredType === 'numeric_dirty'
  );
  const catCol = primaryTable.columns.find(
    (c) => c.inferredType === 'categorical' || c.inferredType === 'text'
  );
  const missingCol = primaryTable.columns.find(
    (c) =>
      c.dirtyProfile.totalDirtyCount > 0 || c.dirtyProfile.nullOrEmptyCount > 0
  );

  if (numCol && catCol) {
    examples.push(
      `Group ${primaryTable.tableName} by ${catCol.columnName} and calculate total and average ${numCol.columnName}.`
    );
  }
  if (numCol) {
    examples.push(
      `Show the top 5 records in ${primaryTable.tableName} ordered by highest ${numCol.columnName}.`
    );
  } else {
    examples.push(
      `How many total records are in ${primaryTable.tableName}, and show the first 10 rows?`
    );
  }

  if (schemaState.foreignKeys.length > 0) {
    const fk = schemaState.foreignKeys[0];
    examples.push(
      `Join ${fk.fromTable} and ${fk.toTable} on ${fk.fromColumn} and summarize counts per ${fk.toTable}.`
    );
  } else if (missingCol) {
    examples.push(
      `How many rows in ${primaryTable.tableName} have missing or invalid values in ${missingCol.columnName}?`
    );
  }

  return examples.slice(0, 3);
}

export function QueryWorkspace({
  schemaState,
  bootLoading,
  onSchemaUpdated,
  onNavigateToProfiler,
  queryHistory,
  onAddHistory,
  onClearHistory,
}: QueryWorkspaceProps) {
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const appendInputRef = useRef<HTMLInputElement | null>(null);

  const [uploading, setUploading] = useState(false);
  const [managingDataset, setManagingDataset] = useState(false);
  const [uploadStatusMsg, setUploadStatusMsg] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineQueryResponse | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);
  const [selectedDbTableIdx, setSelectedDbTableIdx] = useState(0);
  const [previewViewMode, setPreviewViewMode] = useState<'rows' | 'schema'>(
    'rows'
  );
  const [showAgentDetails, setShowAgentDetails] = useState(false);

  // Reset table index and clear stale query results if active datasetId changes externally
  useEffect(() => {
    setSelectedDbTableIdx(0);
    if (
      result &&
      schemaState?.datasetId &&
      result.datasetId &&
      result.datasetId !== schemaState.datasetId
    ) {
      setResult(null);
    }
  }, [schemaState?.datasetId, result]);

  const dynamicExamples = useMemo(
    () => buildDynamicExampleQuestions(schemaState),
    [schemaState]
  );

  const handleFileUpload = async (
    fileList: FileList | null,
    mode: 'replace' | 'append'
  ) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setErrorMsg(null);
    setUploadStatusMsg(null);

    try {
      const names = Array.from(fileList).map((f) => f.name);
      const updated = await uploadDatasetFiles(fileList, mode);
      onSchemaUpdated(updated);
      setSelectedDbTableIdx(0);
      setResult(null);
      setUploadStatusMsg(
        `Processed ${names.join(', ')} — ${updated.tables.length} table(s) ready`
      );
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
      if (appendInputRef.current) appendInputRef.current.value = '';
    }
  };

  const handleSelectDataset = async (datasetId: string) => {
    if (!datasetId || datasetId === schemaState?.datasetId) return;
    setManagingDataset(true);
    setErrorMsg(null);
    setUploadStatusMsg(null);
    try {
      const updated = await apiFetch<WorkspaceSchemaState>(
        '/api/workspace/select',
        {
          method: 'POST',
          body: JSON.stringify({ datasetId }),
        }
      );
      onSchemaUpdated(updated);
      setSelectedDbTableIdx(0);
      setResult(null);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setManagingDataset(false);
    }
  };

  const handleRefreshSchema = async () => {
    setManagingDataset(true);
    setErrorMsg(null);
    try {
      const updated = await apiFetch<WorkspaceSchemaState>(
        '/api/workspace/refresh',
        { method: 'POST' }
      );
      onSchemaUpdated(updated);
      setUploadStatusMsg(`Refreshed schema for "${updated.datasetLabel}"`);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setManagingDataset(false);
    }
  };

  const handleRemoveDataset = async (datasetId: string) => {
    setManagingDataset(true);
    setErrorMsg(null);
    setUploadStatusMsg(null);
    try {
      const updated = await apiFetch<WorkspaceSchemaState>(
        `/api/workspace/datasets/${encodeURIComponent(datasetId)}`,
        { method: 'DELETE' }
      );
      onSchemaUpdated(updated);
      setSelectedDbTableIdx(0);
      setResult(null);
      setUploadStatusMsg('Dataset removed from workspace.');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setManagingDataset(false);
    }
  };

  const handleLoadSampleCsvs = async () => {
    setManagingDataset(true);
    setErrorMsg(null);
    setUploadStatusMsg(null);
    try {
      const updated = await apiFetch<WorkspaceSchemaState>(
        '/api/workspace/preset',
        {
          method: 'POST',
          body: JSON.stringify({ preset: 'default' }),
        }
      );
      onSchemaUpdated(updated);
      setSelectedDbTableIdx(0);
      setResult(null);
      setUploadStatusMsg('Loaded sample CSV dataset (customers.csv + orders.csv)');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setManagingDataset(false);
    }
  };

  const runQuestion = async (overrideQuestion?: string) => {
    const q = (overrideQuestion ?? question).trim();
    if (!q) {
      setErrorMsg('Please enter a question in natural language.');
      return;
    }
    if (!schemaState || schemaState.tables.length === 0) {
      setErrorMsg('Please upload or select a dataset before running a query.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const data = await apiFetch<PipelineQueryResponse>('/api/query', {
        method: 'POST',
        body: JSON.stringify({
          question: q,
          datasetId: schemaState.datasetId,
        }),
      });

      setResult(data);
      onAddHistory({
        id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        datasetId: schemaState.datasetId,
        datasetLabel: schemaState.datasetLabel,
        question: q,
        response: data,
      });
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runQuestion();
  };

  const handleClearQuestionAndResults = () => {
    setQuestion('');
    setResult(null);
    setErrorMsg(null);
  };

  const handleCopySql = async (sqlText: string) => {
    try {
      await navigator.clipboard.writeText(sqlText);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 1800);
    } catch {
      // ignore clipboard error
    }
  };

  const loadedTables = schemaState?.tables || [];
  const availableDatasets = schemaState?.availableDatasets || [];
  const activeDbTable =
    loadedTables[
      Math.min(selectedDbTableIdx, Math.max(0, loadedTables.length - 1))
    ] || null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      {/* LEFT PANEL: Dataset Upload & Selection + Question Input + History */}
      <div className="lg:col-span-5 space-y-6">
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200"
        >
          {/* STEP 1: UPLOAD & SELECT DATASET */}
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-900">
                1. Upload or Select Dataset
              </span>

              {loadedTables.length > 0 && (
                <div className="flex items-center gap-3 text-xs">
                  <button
                    type="button"
                    disabled={uploading || managingDataset || loading}
                    onClick={() => appendInputRef.current?.click()}
                    className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline cursor-pointer disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Table</span>
                  </button>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <button
                    type="button"
                    disabled={uploading || managingDataset || loading}
                    onClick={handleRefreshSchema}
                    title="Refresh schema and statistics"
                    className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${managingDataset ? 'animate-spin' : ''}`}
                    />
                    <span>Refresh</span>
                  </button>
                </div>
              )}
            </div>

            {/* Hidden File Inputs */}
            <input
              ref={replaceInputRef}
              type="file"
              multiple
              accept=".csv,.tsv,.xlsx,.xls,.sqlite,.sqlite3,.db,.sql,.json,text/csv,application/json"
              onChange={(e) => handleFileUpload(e.target.files, 'replace')}
              className="hidden"
            />
            <input
              ref={appendInputRef}
              type="file"
              multiple
              accept=".csv,.tsv,.xlsx,.xls,.json,text/csv,application/json"
              onChange={(e) => handleFileUpload(e.target.files, 'append')}
              className="hidden"
            />

            {/* Drag & Drop Upload Control */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFileUpload(e.dataTransfer.files, 'replace');
              }}
              onClick={() => replaceInputRef.current?.click()}
              className="border-2 border-dashed border-slate-300 hover:border-blue-600 bg-slate-50/70 hover:bg-blue-50/25 rounded-xl p-6 text-center transition-colors cursor-pointer space-y-1.5"
            >
              <Upload className="w-6 h-6 text-blue-600 mx-auto" />
              <div className="text-sm font-semibold text-slate-900">
                {uploading
                  ? 'Uploading & Profiling Dataset...'
                  : 'Click or drag & drop dataset file(s)'}
              </div>
              <div className="text-xs text-slate-500 font-mono">
                CSV · Excel (.xlsx/.xls) · SQLite (.sqlite/.db) · SQL · JSON
              </div>
            </div>

            {uploadStatusMsg && (
              <div className="text-xs text-emerald-700 font-medium flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>{uploadStatusMsg}</span>
              </div>
            )}

            {/* Dataset Switcher & Removal List */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  {availableDatasets.length > 0
                    ? `Datasets in Session (${availableDatasets.length}):`
                    : 'No dataset currently loaded'}
                </span>
                <button
                  type="button"
                  disabled={uploading || managingDataset || loading}
                  onClick={handleLoadSampleCsvs}
                  className="hover:text-slate-900 underline cursor-pointer disabled:opacity-50"
                >
                  Load sample CSVs
                </button>
              </div>

              {bootLoading && availableDatasets.length === 0 ? (
                <div className="h-12 bg-slate-100 rounded-lg animate-pulse" />
              ) : availableDatasets.length > 0 ? (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-slate-50/40 max-h-48 overflow-y-auto">
                  {availableDatasets.map((ds) => {
                    const isSelected = ds.datasetId === schemaState?.datasetId;
                    return (
                      <div
                        key={ds.datasetId}
                        className={`px-3 py-2.5 flex items-center justify-between gap-2 text-xs transition-colors ${
                          isSelected
                            ? 'bg-blue-50/70 text-slate-900'
                            : 'hover:bg-slate-100/70 text-slate-700'
                        }`}
                      >
                        <button
                          type="button"
                          disabled={managingDataset || loading}
                          onClick={() => handleSelectDataset(ds.datasetId)}
                          className="flex-1 min-w-0 text-left flex items-center gap-2 cursor-pointer"
                        >
                          <FileSpreadsheet
                            className={`w-3.5 h-3.5 shrink-0 ${
                              isSelected ? 'text-blue-700' : 'text-slate-400'
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="font-semibold truncate">
                              {ds.datasetLabel}
                            </div>
                            <div className="text-[11px] font-mono text-slate-500 truncate">
                              {ds.format.toUpperCase()} · {ds.tableCount} table
                              {ds.tableCount === 1 ? '' : 's'} ·{' '}
                              {ds.totalRows.toLocaleString()} rows
                            </div>
                          </div>
                        </button>

                        <button
                          type="button"
                          disabled={managingDataset || loading}
                          onClick={() => handleRemoveDataset(ds.datasetId)}
                          title={`Remove ${ds.datasetLabel}`}
                          aria-label={`Remove ${ds.datasetLabel}`}
                          className="p-1.5 text-slate-400 hover:text-red-600 rounded transition-colors cursor-pointer disabled:opacity-40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          {/* STEP 2: ENTER QUESTION */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="user-question-input"
                className="text-sm font-semibold text-slate-900"
              >
                2. Ask a Question
              </label>

              {(question || result || errorMsg) && (
                <button
                  type="button"
                  onClick={handleClearQuestionAndResults}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Clear Question & Results</span>
                </button>
              )}
            </div>

            <textarea
              id="user-question-input"
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                loadedTables.length > 0
                  ? `Ask any question about ${loadedTables
                      .map((t) => t.tableName)
                      .join(', ')}...`
                  : 'Upload a dataset first, then ask a question...'
              }
              className="w-full rounded-lg border border-slate-300 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-blue-600 focus:outline-none transition-colors resize-y"
            />

            {/* Dynamic Schema-Aware Example Prompts */}
            {dynamicExamples.length > 0 && (
              <div className="space-y-1.5 pt-0.5">
                <div className="text-[11px] font-medium text-slate-500">
                  Schema-based example questions:
                </div>
                <div className="space-y-1">
                  {dynamicExamples.map((ex, idx) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={loading}
                      onClick={() => {
                        setQuestion(ex);
                        runQuestion(ex);
                      }}
                      className="w-full text-left text-xs text-slate-600 hover:text-blue-700 py-1 px-2 rounded hover:bg-slate-50 transition-colors truncate block cursor-pointer"
                      title={ex}
                    >
                      → {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* GENERATE CTA */}
          <div className="p-5 bg-slate-50/70 rounded-b-xl">
            <button
              type="submit"
              disabled={
                loading ||
                uploading ||
                managingDataset ||
                loadedTables.length === 0 ||
                !question.trim()
              }
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Play className="w-4 h-4" />
              <span>
                {loading
                  ? 'Generating SQL & Executing...'
                  : 'Generate SQL & Show Output'}
              </span>
            </button>
          </div>
        </form>

        {/* SESSION QUERY HISTORY */}
        {queryHistory.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="px-5 py-3.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                <Clock className="w-3.5 h-3.5 text-slate-500" />
                <span>Session Query History ({queryHistory.length})</span>
              </div>
              <button
                type="button"
                onClick={onClearHistory}
                className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
              >
                Clear History
              </button>
            </div>

            <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
              {queryHistory.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setQuestion(item.question);
                    setErrorMsg(null);
                    setResult(item.response);
                  }}
                  className="w-full px-5 py-3 text-left hover:bg-slate-50 transition-colors space-y-1 cursor-pointer"
                >
                  <div className="text-xs font-medium text-slate-900 line-clamp-1">
                    {item.question}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 font-mono">
                    <span className="truncate">{item.datasetLabel}</span>
                    <span className="shrink-0">
                      {item.response.status} · {item.timestamp}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* RIGHT PANEL: Generated SQL + Query Output + Dataset Preview & Schema */}
      <div className="lg:col-span-7 space-y-6">
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="text-xs text-red-800 leading-relaxed">
                {errorMsg}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-medium text-red-700 hover:underline shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {loading && (
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="p-5 space-y-3">
              <div className="text-xs font-medium text-blue-700">
                Inspecting "{schemaState?.datasetLabel}" schema, generating SQL,
                and executing read-only query...
              </div>
              <div className="h-20 w-full bg-slate-900/90 rounded-lg animate-pulse" />
            </div>
            <div className="p-5 space-y-3">
              <div className="h-4 w-44 bg-slate-200 rounded animate-pulse" />
              <div className="h-28 w-full bg-slate-100 rounded-lg animate-pulse" />
            </div>
          </div>
        )}

        {/* 1. GENERATED SQL + QUERY OUTPUT TABLE */}
        {!loading && result && (
          <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2.5 text-sm font-semibold text-slate-900">
                  <span>Generated SQL</span>
                  <StatusInline status={result.status} />
                  {result.datasetLabel && (
                    <span className="text-xs font-normal text-slate-500">
                      · {result.datasetLabel}
                    </span>
                  )}
                </div>

                {result.finalSql && (
                  <button
                    type="button"
                    onClick={() => handleCopySql(result.finalSql!)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    {copiedSql ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy SQL</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {result.finalSql && (
                <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto leading-relaxed">
                  <code>{result.finalSql}</code>
                </pre>
              )}

              {/* Execution or Generation Error Detail */}
              {result.status === 'execution_failed' && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3.5 text-xs text-red-800 space-y-1">
                  <div className="font-semibold">
                    {result.errorCategory === 'generation_error'
                      ? 'SQL Generation Error'
                      : 'Database Execution Error'}
                  </div>
                  <div>{result.errorMessage}</div>
                </div>
              )}

              {/* Ambiguous Clarification Options */}
              {result.status === 'ambiguous' && (
                <div className="space-y-3 pt-1">
                  <p className="text-sm text-slate-700">
                    {result.agent1Decomposition.clarificationPrompt}
                  </p>
                  {result.agent1Decomposition.clarificationOptions &&
                    result.agent1Decomposition.clarificationOptions.length > 0 && (
                      <div className="space-y-1.5">
                        {result.agent1Decomposition.clarificationOptions.map(
                          (opt, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setQuestion(opt);
                                runQuestion(opt);
                              }}
                              className="w-full text-left px-3.5 py-2 rounded-lg border border-slate-200 hover:border-blue-600 hover:bg-blue-50/40 text-xs font-medium text-slate-800 flex items-center justify-between gap-3 transition-colors cursor-pointer"
                            >
                              <span>{opt}</span>
                              <ArrowRight className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                            </button>
                          )
                        )}
                      </div>
                    )}
                </div>
              )}

              {/* Unanswerable Question Explanation + Suggested Schema Alternatives */}
              {result.status === 'unanswerable' && (
                <div className="space-y-3 pt-1">
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {result.agent1Decomposition.abstentionReason ||
                      result.agent1Decomposition.reasoning}
                  </p>
                  {result.agent1Decomposition.suggestedAlternatives &&
                    result.agent1Decomposition.suggestedAlternatives.length >
                      0 && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold text-slate-700">
                          Questions supported by this dataset:
                        </div>
                        {result.agent1Decomposition.suggestedAlternatives.map(
                          (alt, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setQuestion(alt);
                                runQuestion(alt);
                              }}
                              className="w-full text-left px-3.5 py-2 rounded-lg border border-slate-200 hover:border-blue-600 hover:bg-blue-50/40 text-xs font-medium text-slate-800 flex items-center justify-between gap-3 transition-colors cursor-pointer"
                            >
                              <span>{alt}</span>
                              <ArrowRight className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                            </button>
                          )
                        )}
                      </div>
                    )}
                </div>
              )}

              {/* Destructive Blocked Explanation */}
              {result.status === 'destructive_blocked' && !result.finalSql && (
                <p className="text-sm text-red-700 leading-relaxed">
                  {result.agent1Decomposition.abstentionReason ||
                    result.agent1Decomposition.reasoning}
                </p>
              )}
            </div>

            {/* Query Output Table & Natural Language Explanation */}
            {result.executionOutput && (
              <div className="p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold text-slate-900">
                      Query Results
                    </h2>
                    <span className="text-xs font-mono tabular-nums text-slate-500">
                      {result.executionOutput.truncated
                        ? `Showing first ${result.executionOutput.rowCount.toLocaleString()} of ${(
                            result.executionOutput.totalMatchedRows ||
                            result.executionOutput.rowCount
                          ).toLocaleString()} rows`
                        : `${result.executionOutput.rowCount.toLocaleString()} row(s)`}{' '}
                      · {result.executionOutput.executionLatencyMs}ms
                    </span>
                  </div>

                  {result.executionOutput.rows.length > 0 && (
                    <button
                      type="button"
                      onClick={() => downloadOutputAsCsv(result.executionOutput!)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download Output CSV</span>
                    </button>
                  )}
                </div>

                {/* Responsible Sensitive-Decision Framing Notice */}
                {result.agent1Explanation?.sensitiveDecisionDisclaimer &&
                  result.agent1Explanation.sensitiveDecisionDisclaimer.trim()
                    .length > 0 && (
                    <div className="bg-amber-50/70 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-950 leading-relaxed">
                      <span className="font-semibold">Decision Context: </span>
                      {result.agent1Explanation.sensitiveDecisionDisclaimer}
                    </div>
                  )}

                {/* Natural-Language Takeaway, Analytical Criteria & Record Evidence */}
                {result.agent1Explanation?.directTakeaway && (
                  <div className="space-y-2.5">
                    <p className="text-sm text-slate-800 leading-relaxed">
                      {result.agent1Explanation.directTakeaway}
                    </p>
                    {result.agent1Explanation.analyticalCriteriaUsed && (
                      <p className="text-xs text-slate-600 leading-relaxed">
                        <span className="font-semibold text-slate-700">
                          Analytical criteria:{' '}
                        </span>
                        {result.agent1Explanation.analyticalCriteriaUsed}
                      </p>
                    )}
                    {result.agent1Decomposition.semanticMappings &&
                      result.agent1Decomposition.semanticMappings.length > 0 && (
                        <div className="text-xs text-slate-500 font-mono">
                          Evaluated indicators:{' '}
                          {result.agent1Decomposition.semanticMappings
                            .map(
                              (m) =>
                                `"${m.userConcept}" → ${m.matchedTable}.${m.matchedColumn}`
                            )
                            .join(' · ')}
                        </div>
                      )}
                    {result.agent1Explanation.recordReasoning &&
                      result.agent1Explanation.recordReasoning.length > 0 && (
                        <div className="pt-1 space-y-1 text-xs text-slate-700">
                          <div className="font-semibold text-slate-800">
                            Why these records appear
                          </div>
                          {result.agent1Explanation.recordReasoning.map(
                            (reason, idx) => (
                              <div key={idx} className="leading-relaxed">
                                · {reason}
                              </div>
                            )
                          )}
                        </div>
                      )}
                  </div>
                )}

                {result.executionOutput.rows.length === 0 ? (
                  <div className="text-xs text-slate-500 py-3 border border-slate-200 rounded-lg px-4 bg-slate-50/50">
                    Query executed successfully and returned 0 matching rows.
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-96">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          {result.executionOutput.columns.map((col) => (
                            <th
                              key={col}
                              className="px-3.5 py-2.5 font-mono font-semibold whitespace-nowrap"
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {result.executionOutput.rows.map((row, rIdx) => (
                          <tr
                            key={rIdx}
                            className="hover:bg-slate-50/80 transition-colors"
                          >
                            {result.executionOutput!.columns.map((col) => {
                              const cellVal = row[col];
                              const isNumeric = typeof cellVal === 'number';
                              return (
                                <td
                                  key={col}
                                  className={`px-3.5 py-2.5 whitespace-nowrap ${
                                    isNumeric
                                      ? 'font-mono tabular-nums text-right font-medium text-slate-900'
                                      : 'text-slate-700'
                                  }`}
                                >
                                  {cellVal === null
                                    ? 'NULL'
                                    : typeof cellVal === 'number'
                                      ? cellVal.toLocaleString(undefined, {
                                          maximumFractionDigits: 2,
                                        })
                                      : String(cellVal)}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Missing Context, Assumptions, Limitations & Data Quality Disclosures */}
                {result.agent1Explanation &&
                  ((result.agent1Explanation.missingInformation &&
                    result.agent1Explanation.missingInformation.length > 0) ||
                    (result.agent1Explanation.assumptionsAndLimitations &&
                      result.agent1Explanation.assumptionsAndLimitations
                        .length > 0) ||
                    result.agent1Explanation.dataQualityDisclosures.length >
                      0) && (
                    <div className="pt-3 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600">
                      {result.agent1Explanation.missingInformation &&
                        result.agent1Explanation.missingInformation.length >
                          0 && (
                          <div className="space-y-1">
                            <div className="font-semibold text-slate-700">
                              Missing Context & Unobserved Factors
                            </div>
                            {result.agent1Explanation.missingInformation.map(
                              (item, idx) => (
                                <div key={idx} className="leading-relaxed">
                                  · {item}
                                </div>
                              )
                            )}
                          </div>
                        )}
                      {((result.agent1Explanation.assumptionsAndLimitations &&
                        result.agent1Explanation.assumptionsAndLimitations
                          .length > 0) ||
                        result.agent1Explanation.dataQualityDisclosures.length >
                          0) && (
                        <div className="space-y-2">
                          {result.agent1Explanation.assumptionsAndLimitations &&
                            result.agent1Explanation.assumptionsAndLimitations
                              .length > 0 && (
                              <div className="space-y-1">
                                <div className="font-semibold text-slate-700">
                                  Assumptions & Limitations
                                </div>
                                {result.agent1Explanation.assumptionsAndLimitations.map(
                                  (item, idx) => (
                                    <div key={idx} className="leading-relaxed">
                                      · {item}
                                    </div>
                                  )
                                )}
                              </div>
                            )}
                          {result.agent1Explanation.dataQualityDisclosures
                            .length > 0 && (
                            <div className="space-y-0.5 text-slate-500">
                              {result.agent1Explanation.dataQualityDisclosures.map(
                                (note, idx) => (
                                  <div key={idx}>Data note: {note}</div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
              </div>
            )}

            {/* Collapsible Verification Details */}
            <div className="px-5 py-3 bg-slate-50/60 rounded-b-xl">
              <button
                type="button"
                onClick={() => setShowAgentDetails((prev) => !prev)}
                className="w-full flex items-center justify-between text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5">
                  {showAgentDetails ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  <span>
                    Verification Details (
                    {result.verificationMatrix.overallPassed
                      ? 'All Passed'
                      : 'Review'}
                    {result.autoRepairsCount > 0
                      ? ` · ${result.autoRepairsCount} Auto-Repair`
                      : ''}
                    )
                  </span>
                </span>
                <span className="font-mono tabular-nums text-slate-400">
                  {result.totalLatencyMs}ms
                </span>
              </button>

              {showAgentDetails && (
                <div className="pt-4 pb-2 space-y-4 border-t border-slate-200 mt-3 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <VerificationCell item={result.verificationMatrix.structural} />
                    <VerificationCell item={result.verificationMatrix.intent} />
                    <VerificationCell item={result.verificationMatrix.dataQuality} />
                    <VerificationCell item={result.verificationMatrix.explanation} />
                  </div>

                  {result.repairAttempts.length > 1 && (
                    <div className="space-y-2 pt-2 border-t border-slate-200">
                      <div className="font-semibold text-slate-900">
                        Bounded Self-Repair Trace ({result.repairAttempts.length})
                      </div>
                      {result.repairAttempts.map((att) => (
                        <div key={att.attemptNumber} className="space-y-1">
                          <div className="flex items-center gap-2">
                            {att.succeeded ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Wrench className="w-3.5 h-3.5 text-amber-600" />
                            )}
                            <span className="font-medium text-slate-800">
                              Attempt {att.attemptNumber}
                            </span>
                            {att.errorMessage && (
                              <span className="text-red-700 truncate">
                                — {att.errorMessage}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* 2. DATASET PREVIEW & DETECTED SCHEMA */}
        {loadedTables.length > 0 && activeDbTable ? (
          <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="p-5 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-blue-600 shrink-0" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {schemaState?.datasetLabel} ({loadedTables.length} table
                    {loadedTables.length === 1 ? '' : 's'})
                  </h2>
                </div>
                <div className="text-xs text-slate-500 font-mono">
                  Source: {activeDbTable.sourceFileName} ·{' '}
                  {activeDbTable.rowCount.toLocaleString()} rows ·{' '}
                  {activeDbTable.columns.length} columns
                  {activeDbTable.duplicateRowCount > 0
                    ? ` · ${activeDbTable.duplicateRowCount} duplicate row(s)`
                    : ''}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Table Switcher */}
                {loadedTables.length > 1 && (
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                    {loadedTables.map((tbl, idx) => (
                      <button
                        key={tbl.tableName}
                        type="button"
                        onClick={() => setSelectedDbTableIdx(idx)}
                        className={`px-3 py-1 text-xs font-mono rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                          idx === selectedDbTableIdx
                            ? 'bg-white text-slate-900 shadow-xs font-semibold'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tbl.tableName} ({tbl.rowCount})
                      </button>
                    ))}
                  </div>
                )}

                {/* Rows vs Detected Schema Toggle */}
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setPreviewViewMode('rows')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                      previewViewMode === 'rows'
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Preview Rows
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewViewMode('schema')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                      previewViewMode === 'schema'
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Detected Schema
                  </button>
                </div>

                <button
                  type="button"
                  onClick={onNavigateToProfiler}
                  className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap cursor-pointer"
                >
                  Full Profiler
                </button>
              </div>
            </div>

            {previewViewMode === 'rows' ? (
              activeDbTable.sampleRows.length === 0 ? (
                <div className="p-6 text-xs text-slate-500">
                  Table "{activeDbTable.tableName}" contains 0 rows.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        {activeDbTable.columns.map((col) => (
                          <th
                            key={col.columnName}
                            className="px-3.5 py-2.5 font-mono font-semibold whitespace-nowrap"
                          >
                            <span>{col.columnName}</span>
                            <span className="ml-1.5 text-[10px] font-normal text-slate-400">
                              {col.inferredType}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {activeDbTable.sampleRows.map((row, rIdx) => (
                        <tr
                          key={rIdx}
                          className="hover:bg-slate-50/70 transition-colors"
                        >
                          {activeDbTable.columns.map((col) => {
                            const val = row[col.columnName];
                            return (
                              <td
                                key={col.columnName}
                                className="px-3.5 py-2 font-mono text-slate-700 whitespace-nowrap"
                              >
                                {val === null ? (
                                  <span className="text-slate-400">NULL</span>
                                ) : (
                                  String(val)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <th className="px-4 py-2.5 font-semibold">Column</th>
                      <th className="px-4 py-2.5 font-semibold">Original Header</th>
                      <th className="px-4 py-2.5 font-semibold">SQLite / Semantic</th>
                      <th className="px-4 py-2.5 font-semibold text-right">
                        Distinct
                      </th>
                      <th className="px-4 py-2.5 font-semibold text-right">
                        Missing %
                      </th>
                      <th className="px-4 py-2.5 font-semibold">Sample Values</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeDbTable.columns.map((col) => (
                      <tr key={col.columnName} className="hover:bg-slate-50/70">
                        <td className="px-4 py-2.5 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {col.columnName}
                          {col.isCandidatePrimaryKey ? ' (PK)' : ''}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                          {col.sourceHeader}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-700 whitespace-nowrap">
                          {col.sqliteDeclaredType} · {col.inferredType}
                        </td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-700">
                          {col.distinctCount}
                        </td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-700">
                          {col.nullRate}%
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-500 max-w-xs truncate">
                          {col.sampleCleanValues.join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : (
          !bootLoading && (
            <section className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
              <Database className="w-7 h-7 text-slate-400 mx-auto" />
              <div className="text-sm font-semibold text-slate-900">
                No Dataset Selected
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Upload a CSV, Excel workbook (.xlsx), SQLite database (.sqlite /
                .db), SQL file, or JSON dataset on the left — or load the sample
                CSVs to start querying.
              </p>
            </section>
          )
        )}
      </div>
    </div>
  );
}

function StatusInline({
  status,
}: {
  status: PipelineQueryResponse['status'];
}) {
  if (status === 'answerable') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>Executed & Verified</span>
      </span>
    );
  }
  if (status === 'ambiguous') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
        <HelpCircle className="w-3.5 h-3.5 shrink-0" />
        <span>Clarification Needed</span>
      </span>
    );
  }
  if (status === 'unanswerable') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>Cannot Answer from Dataset</span>
      </span>
    );
  }
  if (status === 'execution_failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        <span>Execution Failed</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
      <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
      <span>Blocked (Read-Only)</span>
    </span>
  );
}

function VerificationCell({ item }: { item: VerificationCheckItem }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-800">{item.level}</span>
        <span
          className={
            item.passed
              ? 'text-emerald-700 font-medium'
              : 'text-red-700 font-medium'
          }
        >
          {item.passed ? 'Passed' : 'Failed'}
        </span>
      </div>
      <p className="text-slate-600">{item.summary}</p>
    </div>
  );
}
