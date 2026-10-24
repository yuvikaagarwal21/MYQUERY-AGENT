import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
  X,
} from 'lucide-react';
import type { WorkspaceSchemaState } from '../types/domain';
import { apiFetch } from '../utils/apiClient';
import { uploadDatasetFiles } from '../utils/uploadHelper';

interface DatabaseConnectorProps {
  onDatabaseLoaded: (nextState: WorkspaceSchemaState) => void;
  onClose?: () => void;
}

export function DatabaseConnector({
  onDatabaseLoaded,
  onClose,
}: DatabaseConnectorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [ingestMode, setIngestMode] = useState<'replace' | 'append'>('replace');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const names = Array.from(files).map((f) => f.name);
      const updated = await uploadDatasetFiles(files, ingestMode);
      onDatabaseLoaded(updated);
      setSuccessMsg(
        `Loaded ${names.join(', ')} (${updated.tables.length} table(s)).`
      );
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleLoadSamplePreset = async (preset: 'default' | 'three-table') => {
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const updated = await apiFetch<WorkspaceSchemaState>(
        '/api/workspace/preset',
        {
          method: 'POST',
          body: JSON.stringify({ preset }),
        }
      );
      onDatabaseLoaded(updated);
      setSuccessMsg(`Loaded preset: ${updated.datasetLabel}`);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
      <div className="p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FileSpreadsheet className="w-4 h-4 text-blue-600" />
          <span>Upload Dataset</span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setIngestMode('replace')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                ingestMode === 'replace'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              New Dataset
            </button>
            <button
              type="button"
              onClick={() => setIngestMode('append')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                ingestMode === 'append'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Append Table(s)
            </button>
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close uploader"
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="p-5 space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".csv,.tsv,.xlsx,.xls,.sqlite,.sqlite3,.db,.sql,.json,text/csv,application/json"
          onChange={(e) => handleFilesSelected(e.target.files)}
          className="hidden"
        />

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFilesSelected(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-slate-300 hover:border-blue-600 bg-slate-50/60 hover:bg-blue-50/20 rounded-xl p-8 text-center transition-colors cursor-pointer space-y-2"
        >
          <Upload className="w-6 h-6 text-blue-600 mx-auto" />
          <div className="text-sm font-semibold text-slate-900">
            {loading
              ? 'Uploading & Profiling Dataset...'
              : 'Click to select or drag & drop dataset file(s)'}
          </div>
          <div className="text-xs text-slate-500 font-mono">
            Supports .csv · .tsv · .xlsx · .xls · .sqlite · .db · .sql · .json
          </div>
        </div>

        <div className="pt-2 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-slate-500">
            <span>Sample Datasets:</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => handleLoadSamplePreset('default')}
              className="text-slate-700 hover:text-blue-700 font-medium hover:underline cursor-pointer"
            >
              Commerce (customers.csv + orders.csv)
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => handleLoadSamplePreset('three-table')}
              className="text-slate-700 hover:text-blue-700 font-medium hover:underline cursor-pointer"
            >
              Supply Chain (+ shipments.csv)
            </button>
          </div>

          {successMsg && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{successMsg}</span>
            </span>
          )}
          {errorMsg && (
            <span className="inline-flex items-center gap-1.5 text-red-700 font-medium">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{errorMsg}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
