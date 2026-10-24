import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileText,
} from 'lucide-react';
import {
  buildColabIpynbJsonString,
  COLAB_NOTEBOOK_CELLS,
  type NotebookCellPreview,
} from '../data/colabNotebook';

interface ColabDeliverableViewProps {
  onDownloadNotebook: () => void;
}

type StageFilter = 'All' | NotebookCellPreview['stage'];

export function ColabDeliverableView({
  onDownloadNotebook,
}: ColabDeliverableViewProps) {
  const [stageFilter, setStageFilter] = useState<StageFilter>('All');
  const [collapsedIds, setCollapsedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredCells = COLAB_NOTEBOOK_CELLS.filter((cell) =>
    stageFilter === 'All' ? true : cell.stage === stageFilter
  );

  const handleCopyCell = async (id: string, source: string) => {
    try {
      await navigator.clipboard.writeText(source);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleCopyFullJson = async () => {
    try {
      await navigator.clipboard.writeText(buildColabIpynbJsonString());
      setCopiedId('full-ipynb');
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore
    }
  };

  const toggleCell = (id: string) => {
    setCollapsedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const setAllCollapsed = (collapsed: boolean) => {
    const next: Record<string, boolean> = {};
    for (const c of COLAB_NOTEBOOK_CELLS) {
      next[c.id] = collapsed;
    }
    setCollapsedIds(next);
  };

  return (
    <div className="space-y-8">
      {/* Header & Download Actions */}
      <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
          Colab Notebook (.ipynb)
        </h1>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleCopyFullJson}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedId === 'full-ipynb' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>Copied .ipynb JSON</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Raw .ipynb JSON</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onDownloadNotebook}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download MyQuery_Agent_Colab.ipynb</span>
          </button>
        </div>
      </section>

      {/* Colab Runtime Specification Strip */}
      <section className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 text-xs">
        <div className="p-5 space-y-1">
          <div className="text-slate-500 font-medium">Local Open-Weight LLM</div>
          <div className="font-mono font-semibold text-slate-900 text-sm">
            Qwen/Qwen2.5-3B-Instruct
          </div>
          <div className="text-slate-500">
            Hugging Face Transformers · FP16 T4 / FP32 CPU
          </div>
        </div>
        <div className="p-5 space-y-1">
          <div className="text-slate-500 font-medium">Data & Execution Stack</div>
          <div className="font-mono font-semibold text-slate-900 text-sm">
            pandas + sqlite3 (:memory:)
          </div>
          <div className="text-slate-500">
            Read-only sandbox & 3-attempt repair loop
          </div>
        </div>
        <div className="p-5 space-y-1">
          <div className="text-slate-500 font-medium">External Paid APIs</div>
          <div className="font-mono font-semibold text-emerald-700 text-sm tabular-nums">
            0 Keys Required
          </div>
          <div className="text-slate-500">
            Runs 100% locally inside Colab runtime
          </div>
        </div>
        <div className="p-5 space-y-1">
          <div className="text-slate-500 font-medium">Notebook Structure</div>
          <div className="font-mono font-semibold text-slate-900 text-sm tabular-nums">
            {COLAB_NOTEBOOK_CELLS.length} Executable Cells
          </div>
          <div className="text-slate-500">
            nbformat v4.5 · Includes 12-case benchmark
          </div>
        </div>
      </section>

      {/* Stage Filter & Cell Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {(
            [
              'All',
              'Setup & Model',
              'Ingestion & Sandbox',
              'Two-Agent Pipeline',
              'Verification & Benchmark',
            ] as StageFilter[]
          ).map((stage) => (
            <button
              key={stage}
              type="button"
              onClick={() => setStageFilter(stage)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                stageFilter === stage
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {stage === 'All'
                ? `All Cells (${COLAB_NOTEBOOK_CELLS.length})`
                : stage}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 text-xs font-medium text-slate-600">
          <button
            type="button"
            onClick={() => setAllCollapsed(false)}
            className="hover:text-slate-900 cursor-pointer"
          >
            Expand All
          </button>
          <span aria-hidden="true" className="text-slate-300">
            ·
          </span>
          <button
            type="button"
            onClick={() => setAllCollapsed(true)}
            className="hover:text-slate-900 cursor-pointer"
          >
            Collapse All
          </button>
        </div>
      </div>

      {/* Cell-by-Cell Interactive Preview */}
      <div className="space-y-5">
        {filteredCells.map((cell) => {
          const isCollapsed = Boolean(collapsedIds[cell.id]);
          const isCopied = copiedId === cell.id;

          return (
            <article
              key={cell.id}
              className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200 overflow-hidden"
            >
              <div className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 bg-slate-50/60">
                <button
                  type="button"
                  onClick={() => toggleCell(cell.id)}
                  className="flex items-center gap-2.5 text-left cursor-pointer min-w-0"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  <span className="font-mono text-xs font-semibold text-slate-500 tabular-nums shrink-0">
                    [{cell.cellNumber}]
                  </span>
                  {cell.cellType === 'code' ? (
                    <Code2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  )}
                  <span className="text-sm font-semibold text-slate-900 truncate">
                    {cell.title}
                  </span>
                </button>

                <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0">
                  <span>
                    {cell.stage} · {cell.cellType}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyCell(cell.id, cell.source)}
                    className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-blue-700 transition-colors cursor-pointer"
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Cell</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {!isCollapsed && (
                <div className="p-5 space-y-3">
                  <p className="text-xs text-slate-600">{cell.description}</p>
                  {cell.cellType === 'markdown' ? (
                    <pre className="bg-slate-50 border border-slate-200 text-slate-800 rounded-lg p-4 text-xs font-sans whitespace-pre-wrap leading-relaxed">
                      {cell.source}
                    </pre>
                  ) : (
                    <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto leading-relaxed">
                      <code>{cell.source}</code>
                    </pre>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
