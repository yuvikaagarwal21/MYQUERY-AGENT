/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { TopNav, type ActiveTab } from './components/TopNav';
import { QueryWorkspace } from './components/QueryWorkspace';
import { DataProfilerView } from './components/DataProfilerView';
import { ColabDeliverableView } from './components/ColabDeliverableView';
import { buildColabIpynbJsonString } from './data/colabNotebook';
import type { QueryHistoryEntry, WorkspaceSchemaState } from './types/domain';
import { apiFetch } from './utils/apiClient';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');
  const [schemaState, setSchemaState] = useState<WorkspaceSchemaState | null>(
    null
  );
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);

  const loadWorkspace = useCallback(async () => {
    setBootLoading(true);
    setBootError(null);
    try {
      const data = await apiFetch<WorkspaceSchemaState>('/api/workspace');
      setSchemaState(data);
    } catch (err: unknown) {
      setBootError(
        err instanceof Error
          ? err.message
          : 'Failed to load workspace metadata from server.'
      );
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const handleDownloadNotebook = () => {
    const jsonString = buildColabIpynbJsonString();
    const blob = new Blob([jsonString], {
      type: 'application/x-ipynb+json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'MyQuery_Agent_Text_to_SQL_Qwen2_5.ipynb';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleAddHistory = (entry: QueryHistoryEntry) => {
    setQueryHistory((prev) => [entry, ...prev.slice(0, 24)]);
  };

  const handleClearHistory = () => {
    setQueryHistory([]);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onDownloadNotebook={handleDownloadNotebook}
      />

      <main className="flex-1 w-full max-w-[1360px] mx-auto px-4 sm:px-6 py-8">
        {bootError && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs text-red-800">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{bootError}</span>
            </div>
            <button
              type="button"
              onClick={loadWorkspace}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold text-red-800 bg-white border border-red-300 rounded-lg hover:bg-red-100/50 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Connection</span>
            </button>
          </div>
        )}

        {activeTab === 'workspace' && (
          <QueryWorkspace
            schemaState={schemaState}
            bootLoading={bootLoading}
            onSchemaUpdated={(next) => setSchemaState(next)}
            onNavigateToProfiler={() => setActiveTab('profiler')}
            queryHistory={queryHistory}
            onAddHistory={handleAddHistory}
            onClearHistory={handleClearHistory}
          />
        )}

        {activeTab === 'profiler' && (
          <DataProfilerView
            schemaState={schemaState}
            onSchemaUpdated={(next) => setSchemaState(next)}
          />
        )}

        {activeTab === 'colab' && (
          <ColabDeliverableView onDownloadNotebook={handleDownloadNotebook} />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white mt-16">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>MyQuery Agent</div>
          <div className="flex flex-wrap items-center gap-5">
            <button
              type="button"
              onClick={() => setActiveTab('profiler')}
              className="hover:text-slate-900 transition-colors cursor-pointer"
            >
              Data Profiler
            </button>
            <button
              type="button"
              onClick={handleDownloadNotebook}
              className="font-medium text-slate-800 hover:text-blue-700 transition-colors cursor-pointer"
            >
              Download Colab .ipynb
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
