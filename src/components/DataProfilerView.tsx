import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';
import type {
  ColumnProfile,
  InferredSemanticType,
  WorkspaceSchemaState,
} from '../types/domain';
import { apiFetch } from '../utils/apiClient';
import { DatabaseConnector } from './DatabaseConnector';

interface DataProfilerViewProps {
  schemaState: WorkspaceSchemaState | null;
  onSchemaUpdated: (nextState: WorkspaceSchemaState) => void;
}

function formatReadableType(type: InferredSemanticType): string {
  switch (type) {
    case 'identifier':
      return 'ID';
    case 'numeric_clean':
    case 'numeric_dirty':
      return 'Number';
    case 'date_clean':
    case 'date_dirty':
      return 'Date';
    case 'categorical':
      return 'Category';
    case 'text':
    default:
      return 'Text';
  }
}

function formatColumnSummary(col: ColumnProfile): string {
  if (col.numericStats) {
    const { min, mean, max } = col.numericStats;
    return `Min ${min.toLocaleString()} · Avg ${mean.toLocaleString()} · Max ${max.toLocaleString()}`;
  }
  if (col.topCategories && col.topCategories.length > 0) {
    return col.topCategories
      .slice(0, 3)
      .map((c) => `${c.value} (${c.percentage}%)`)
      .join(' · ');
  }
  if (col.sampleCleanValues.length > 0) {
    return `Examples: ${col.sampleCleanValues.slice(0, 3).join(', ')}`;
  }
  return 'No non-empty values';
}

export function DataProfilerView({
  schemaState,
  onSchemaUpdated,
}: DataProfilerViewProps) {
  const [selectedTableIndex, setSelectedTableIndex] = useState(0);
  const [activeSubTab, setActiveSubTab] = useState<'columns' | 'rows'>(
    'columns'
  );
  const [showUploader, setShowUploader] = useState(false);
  const [rowSearch, setRowSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const tables = schemaState?.tables || [];
  const safeTableIdx = Math.min(
    selectedTableIndex,
    Math.max(0, tables.length - 1)
  );
  const activeTable = tables[safeTableIdx] || null;

  useEffect(() => {
    setSelectedTableIndex(0);
    setRowSearch('');
  }, [schemaState?.datasetId]);

  const handleRefreshProfiler = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const updated = await apiFetch<WorkspaceSchemaState>(
        '/api/workspace/refresh',
        { method: 'POST' }
      );
      onSchemaUpdated(updated);
    } catch (err: unknown) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const filteredSampleRows =
    activeTable?.sampleRows.filter((row) => {
      if (!rowSearch.trim()) return true;
      const needle = rowSearch.trim().toLowerCase();
      return Object.values(row).some((val) =>
        String(val ?? 'NULL')
          .toLowerCase()
          .includes(needle)
      );
    }) || [];

  const totalMissingCells = activeTable
    ? activeTable.columns.reduce(
        (acc, c) => acc + c.dirtyProfile.nullOrEmptyCount,
        0
      )
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
        <div className="space-y-1">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
            Data Profiler
          </h1>
          {schemaState && schemaState.tables.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-800">
                {schemaState.datasetLabel}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {schemaState.tables.length} table
                {schemaState.tables.length === 1 ? '' : 's'}
              </span>
              {schemaState.foreignKeys.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Linked:{' '}
                    {schemaState.foreignKeys
                      .map(
                        (fk) =>
                          `${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`
                      )
                      .join(', ')}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowUploader((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{showUploader ? 'Hide Upload' : 'Upload Dataset'}</span>
          </button>

          {schemaState && schemaState.tables.length > 0 && (
            <button
              type="button"
              disabled={refreshing}
              onClick={handleRefreshProfiler}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
              />
              <span>Refresh</span>
            </button>
          )}
        </div>
      </section>

      {refreshError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-800">
          {refreshError}
        </div>
      )}

      {showUploader && (
        <DatabaseConnector
          onClose={() => setShowUploader(false)}
          onDatabaseLoaded={(updated) => {
            onSchemaUpdated(updated);
            setSelectedTableIndex(0);
            setShowUploader(false);
          }}
        />
      )}

      {!activeTable ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-600">
          No dataset loaded. Click <strong>Upload Dataset</strong> above to
          inspect your tables and columns.
        </div>
      ) : (
        <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
          {/* Table Selector & View Switcher */}
          <div className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 overflow-x-auto">
              {tables.length > 1 ? (
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {tables.map((tbl, idx) => (
                    <button
                      key={tbl.tableName}
                      type="button"
                      onClick={() => setSelectedTableIndex(idx)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        idx === safeTableIdx
                          ? 'bg-white text-slate-900 shadow-xs font-semibold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <span className="font-mono">{tbl.tableName}</span>{' '}
                      <span className="text-slate-400 font-mono tabular-nums">
                        ({tbl.rowCount})
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-sm font-semibold text-slate-900 font-mono">
                  {activeTable.tableName}
                </div>
              )}
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setActiveSubTab('columns')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  activeSubTab === 'columns'
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Columns ({activeTable.columns.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('rows')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  activeSubTab === 'rows'
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sample Rows ({activeTable.sampleRows.length})
              </button>
            </div>
          </div>

          {/* 4 Key Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 bg-slate-50/40">
            <div className="p-4">
              <div className="text-xs text-slate-500">Rows</div>
              <div className="mt-0.5 text-lg font-bold font-mono tabular-nums text-slate-900">
                {activeTable.rowCount.toLocaleString()}
              </div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Columns</div>
              <div className="mt-0.5 text-lg font-bold font-mono tabular-nums text-slate-900">
                {activeTable.columns.length}
              </div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Duplicate Rows</div>
              <div
                className={`mt-0.5 text-lg font-bold font-mono tabular-nums ${
                  activeTable.duplicateRowCount > 0
                    ? 'text-amber-700'
                    : 'text-slate-900'
                }`}
              >
                {activeTable.duplicateRowCount.toLocaleString()}
              </div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Missing Values</div>
              <div
                className={`mt-0.5 text-lg font-bold font-mono tabular-nums ${
                  totalMissingCells > 0 ? 'text-amber-700' : 'text-slate-900'
                }`}
              >
                {totalMissingCells.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Simple Quality Notice */}
          {activeTable.warnings && activeTable.warnings.length > 0 && (
            <div className="px-5 py-3 bg-amber-50/40 flex items-center gap-2 text-xs text-amber-900">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>{activeTable.warnings.join(' · ')}</span>
            </div>
          )}

          {/* Sub-Tab 1: Clean Column Summary Table */}
          {activeSubTab === 'columns' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="px-5 py-3 font-semibold whitespace-nowrap">
                      Column
                    </th>
                    <th className="px-5 py-3 font-semibold whitespace-nowrap">
                      Type
                    </th>
                    <th className="px-5 py-3 font-semibold text-right whitespace-nowrap">
                      Unique
                    </th>
                    <th className="px-5 py-3 font-semibold text-right whitespace-nowrap">
                      Missing
                    </th>
                    <th className="px-5 py-3 font-semibold">
                      Summary / Examples
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {activeTable.columns.map((col) => (
                    <tr
                      key={col.columnName}
                      className="hover:bg-slate-50/70 transition-colors"
                    >
                      <td className="px-5 py-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        <span>{col.columnName}</span>
                        {col.isCandidatePrimaryKey && (
                          <span className="ml-2 font-sans font-normal text-[11px] text-blue-700">
                            Primary Key
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-600 whitespace-nowrap">
                        {formatReadableType(col.inferredType)}
                      </td>
                      <td className="px-5 py-3 font-mono tabular-nums text-right text-slate-700 whitespace-nowrap">
                        {col.distinctCount.toLocaleString()}
                      </td>
                      <td
                        className={`px-5 py-3 font-mono tabular-nums text-right whitespace-nowrap ${
                          col.dirtyProfile.nullOrEmptyCount > 0
                            ? 'text-amber-700 font-medium'
                            : 'text-slate-500'
                        }`}
                      >
                        {col.dirtyProfile.nullOrEmptyCount === 0
                          ? '0'
                          : `${col.dirtyProfile.nullOrEmptyCount} (${col.nullRate}%)`}
                      </td>
                      <td className="px-5 py-3 text-slate-600 font-mono tabular-nums">
                        {formatColumnSummary(col)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Sub-Tab 2: Sample Rows Preview */}
          {activeSubTab === 'rows' && (
            <div className="p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  Showing {filteredSampleRows.length} sample row
                  {filteredSampleRows.length === 1 ? '' : 's'} from{' '}
                  <span className="font-mono text-slate-800">
                    {activeTable.tableName}
                  </span>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={rowSearch}
                    onChange={(e) => setRowSearch(e.target.value)}
                    placeholder="Filter sample rows..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-96">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      {activeTable.columns.map((c) => (
                        <th
                          key={c.columnName}
                          className="px-4 py-2.5 font-mono font-semibold whitespace-nowrap"
                        >
                          {c.columnName}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredSampleRows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/70">
                        {activeTable.columns.map((c) => {
                          const raw = row[c.columnName];
                          const isEmpty = raw === null || String(raw).trim() === '';
                          return (
                            <td
                              key={c.columnName}
                              className={`px-4 py-2 font-mono tabular-nums whitespace-nowrap ${
                                isEmpty ? 'text-slate-400 italic' : 'text-slate-700'
                              }`}
                            >
                              {raw === null || String(raw) === ''
                                ? '—'
                                : String(raw)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
