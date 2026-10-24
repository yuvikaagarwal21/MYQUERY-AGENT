import 'dotenv/config';
import dns from 'node:dns';
import net from 'node:net';
import path from 'path';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { createServer as createViteServer } from 'vite';
import { ingestCsvFilesToSqlite } from './server/csvIngestor.ts';
import type { RawCsvFileInput } from './server/sampleData.ts';
import { runTwoAgentPipeline } from './server/agents.ts';
import { executeSandboxedQuery } from './server/sqliteSandbox.ts';
import {
  convertExcelBase64ToCsvInputs,
  convertJsonToCsvInputs,
  loadDatabaseFromUrl,
  loadSqlDumpScript,
  loadSqliteBinaryBuffer,
} from './server/universalDbLoader.ts';
import {
  appendCsvTablesToActiveDataset,
  extractSessionId,
  getActiveDatasetForSession,
  getOrInitSession,
  loadSamplePresetIntoSession,
  refreshActiveDatasetSchema,
  registerNewDatasetInSession,
  removeDatasetFromSession,
  selectDatasetInSession,
  serializeSessionWorkspaceState,
} from './server/sessionStore.ts';

dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}

const PORT = 3000;

interface UploadedFilePayload {
  fileName: string;
  textContent?: string;
  base64Data?: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  'csv',
  'tsv',
  'xlsx',
  'xls',
  'sqlite',
  'sqlite3',
  'db',
  'sql',
  'json',
]);

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) return '';
  return fileName.slice(idx + 1).trim().toLowerCase();
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'MyQuery Agent' });
  });

  // Get active session workspace & list of session-isolated datasets
  app.get('/api/workspace', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      res.json(serializeSessionWorkspaceState(session));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Unified multi-format dataset upload (.csv, .tsv, .xlsx, .xls, .sqlite, .db, .sqlite3, .sql, .json)
  app.post('/api/workspace/upload', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { files, datasetLabel, mode } = req.body as {
        files?: UploadedFilePayload[];
        datasetLabel?: string;
        mode?: 'replace' | 'append';
      };

      if (!files || !Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: 'Please select at least one dataset file to upload.' });
        return;
      }

      for (const f of files) {
        if (!f || typeof f.fileName !== 'string' || !f.fileName.trim()) {
          res.status(400).json({ error: 'Uploaded file is missing a filename.' });
          return;
        }
        const ext = getExtension(f.fileName);
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          res.status(400).json({
            error: `Unsupported file format ".${ext || 'unknown'}" (${f.fileName}). Supported formats: .csv, .tsv, .xlsx, .xls, .sqlite, .db, .sqlite3, .sql, .json.`,
          });
          return;
        }
      }

      const firstFile = files[0];
      const firstExt = getExtension(firstFile.fileName);

      // 1. Binary SQLite database (.sqlite, .sqlite3, .db)
      if (['sqlite', 'sqlite3', 'db'].includes(firstExt)) {
        if (!firstFile.base64Data) {
          res.status(400).json({
            error: `Binary content missing for SQLite file "${firstFile.fileName}".`,
          });
          return;
        }
        const runtime = await loadSqliteBinaryBuffer(
          firstFile.base64Data,
          firstFile.fileName,
          datasetLabel || firstFile.fileName
        );
        const state = registerNewDatasetInSession(session, runtime, {
          format: 'sqlite',
          fileNames: [firstFile.fileName],
          backingCsvFiles: null,
        });
        res.json(state);
        return;
      }

      // 2. SQL schema + seed script (.sql)
      if (firstExt === 'sql') {
        const sqlText =
          firstFile.textContent ??
          (firstFile.base64Data
            ? Buffer.from(firstFile.base64Data, 'base64').toString('utf-8')
            : '');
        if (!sqlText.trim()) {
          res.status(400).json({
            error: `Uploaded SQL file "${firstFile.fileName}" is empty.`,
          });
          return;
        }
        const runtime = await loadSqlDumpScript(
          sqlText,
          datasetLabel || firstFile.fileName,
          firstFile.fileName
        );
        const state = registerNewDatasetInSession(session, runtime, {
          format: 'sql',
          fileNames: [firstFile.fileName],
          backingCsvFiles: null,
        });
        res.json(state);
        return;
      }

      // 3. Collect tabular CSV inputs from CSV/TSV, Excel (.xlsx/.xls), and/or JSON files
      const collectedCsvInputs: RawCsvFileInput[] = [];
      let detectedFormat: 'csv' | 'excel' | 'json' = 'csv';

      for (const file of files) {
        const ext = getExtension(file.fileName);
        if (ext === 'xlsx' || ext === 'xls') {
          detectedFormat = 'excel';
          if (!file.base64Data) {
            res.status(400).json({
              error: `Binary data missing for Excel file "${file.fileName}".`,
            });
            return;
          }
          const sheetInputs = convertExcelBase64ToCsvInputs(
            file.base64Data,
            file.fileName
          );
          collectedCsvInputs.push(...sheetInputs);
        } else if (ext === 'json') {
          detectedFormat = 'json';
          const jsonText =
            file.textContent ??
            (file.base64Data
              ? Buffer.from(file.base64Data, 'base64').toString('utf-8')
              : '');
          const jsonInputs = convertJsonToCsvInputs(jsonText, file.fileName);
          collectedCsvInputs.push(...jsonInputs);
        } else {
          const csvText =
            file.textContent ??
            (file.base64Data
              ? Buffer.from(file.base64Data, 'base64').toString('utf-8')
              : '');
          if (!csvText.trim()) {
            res.status(400).json({
              error: `Uploaded CSV file "${file.fileName}" is empty.`,
            });
            return;
          }
          collectedCsvInputs.push({
            fileName: file.fileName,
            csvContent: csvText,
          });
        }
      }

      if (mode === 'append') {
        const state = await appendCsvTablesToActiveDataset(
          session,
          collectedCsvInputs,
          datasetLabel
        );
        res.json(state);
        return;
      }

      const label =
        datasetLabel ||
        (files.length === 1
          ? files[0].fileName
          : files.map((f) => f.fileName).join(' + '));

      const runtime = await ingestCsvFilesToSqlite(collectedCsvInputs, label, {
        format: detectedFormat,
      });
      const state = registerNewDatasetInSession(session, runtime, {
        format: detectedFormat,
        fileNames: files.map((f) => f.fileName),
        backingCsvFiles: collectedCsvInputs,
      });
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Backward-compatible CSV ingestion endpoint (session-isolated)
  app.post('/api/workspace/ingest', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { files, datasetLabel, mode } = req.body as {
        files?: RawCsvFileInput[];
        datasetLabel?: string;
        mode?: 'replace' | 'append';
      };

      if (!files || !Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: 'Please provide at least one CSV file.' });
        return;
      }

      const validFiles = files.filter(
        (f) =>
          f &&
          typeof f.fileName === 'string' &&
          typeof f.csvContent === 'string' &&
          f.csvContent.trim().length > 0
      );

      if (validFiles.length === 0) {
        res.status(400).json({ error: 'Uploaded CSV file(s) had empty content.' });
        return;
      }

      if (mode === 'append') {
        const state = await appendCsvTablesToActiveDataset(
          session,
          validFiles,
          datasetLabel
        );
        res.json(state);
        return;
      }

      const label =
        datasetLabel ||
        (validFiles.length === 1
          ? validFiles[0].fileName
          : validFiles.map((f) => f.fileName).join(' + '));

      const runtime = await ingestCsvFilesToSqlite(validFiles, label, {
        format: 'csv',
      });
      const state = registerNewDatasetInSession(session, runtime, {
        format: 'csv',
        fileNames: validFiles.map((f) => f.fileName),
        backingCsvFiles: validFiles,
      });
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/workspace/load-sqlite', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { base64Data, fileName, datasetLabel } = req.body as {
        base64Data?: string;
        fileName?: string;
        datasetLabel?: string;
      };
      if (!base64Data || !fileName) {
        res.status(400).json({
          error: 'SQLite file binary payload and fileName are required.',
        });
        return;
      }
      const nextRuntime = await loadSqliteBinaryBuffer(
        base64Data,
        fileName,
        datasetLabel
      );
      const state = registerNewDatasetInSession(session, nextRuntime, {
        format: 'sqlite',
        fileNames: [fileName],
        backingCsvFiles: null,
      });
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/workspace/load-sql-script', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { sqlScript, datasetLabel, fileName } = req.body as {
        sqlScript?: string;
        datasetLabel?: string;
        fileName?: string;
      };
      if (!sqlScript || !sqlScript.trim()) {
        res.status(400).json({
          error: 'Please provide a non-empty SQL script.',
        });
        return;
      }
      const fname = fileName || 'custom_schema.sql';
      const nextRuntime = await loadSqlDumpScript(
        sqlScript,
        datasetLabel || fname,
        fname
      );
      const state = registerNewDatasetInSession(session, nextRuntime, {
        format: 'sql',
        fileNames: [fname],
        backingCsvFiles: null,
      });
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/workspace/load-json', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { jsonContent, fileName, datasetLabel, mode } = req.body as {
        jsonContent?: string;
        fileName?: string;
        datasetLabel?: string;
        mode?: 'replace' | 'append';
      };
      if (!jsonContent || !jsonContent.trim()) {
        res.status(400).json({ error: 'Please provide JSON content.' });
        return;
      }
      const fname = fileName || 'custom_data.json';
      const csvInputs = convertJsonToCsvInputs(jsonContent, fname);
      if (mode === 'append') {
        const state = await appendCsvTablesToActiveDataset(
          session,
          csvInputs,
          datasetLabel
        );
        res.json(state);
        return;
      }
      const runtime = await ingestCsvFilesToSqlite(
        csvInputs,
        datasetLabel || fname,
        { format: 'json' }
      );
      const state = registerNewDatasetInSession(session, runtime, {
        format: 'json',
        fileNames: [fname],
        backingCsvFiles: csvInputs,
      });
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/workspace/load-url', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { url, datasetLabel } = req.body as {
        url?: string;
        datasetLabel?: string;
      };
      if (!url || !url.trim()) {
        res.status(400).json({ error: 'Please enter a valid dataset URL.' });
        return;
      }
      const { runtime, csvBackingFiles } = await loadDatabaseFromUrl(
        url,
        datasetLabel
      );
      const state = registerNewDatasetInSession(session, runtime, {
        format: runtime.schemaState.format,
        fileNames: runtime.schemaState.fileNames,
        backingCsvFiles: csvBackingFiles,
      });
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Switch between uploaded datasets in the user's session
  app.post('/api/workspace/select', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { datasetId } = req.body as { datasetId?: string };
      if (!datasetId) {
        res.status(400).json({ error: 'datasetId is required.' });
        return;
      }
      const state = selectDatasetInSession(session, datasetId);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(404).json({ error: message });
    }
  });

  // Refresh schema & statistical profile of the currently active dataset
  app.post('/api/workspace/refresh', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const state = await refreshActiveDatasetSchema(session);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Remove a dataset from the user's session
  app.delete('/api/workspace/datasets/:datasetId', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const state = removeDatasetFromSession(session, req.params.datasetId);
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(404).json({ error: message });
    }
  });

  // Load built-in sample preset into the user's session
  app.post('/api/workspace/preset', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { preset } = req.body as { preset?: 'default' | 'three-table' };
      const state = await loadSamplePresetIntoSession(
        session,
        preset === 'three-table' ? 'three-table' : 'default'
      );
      res.json(state);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Dynamic Natural-Language-to-SQL against the session's selected dataset
  app.post('/api/query', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { question, datasetId, injectFaultDemo } = req.body as {
        question?: string;
        datasetId?: string;
        injectFaultDemo?: boolean;
      };

      if (!question || typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ error: 'Please enter a natural language question.' });
        return;
      }

      const activeDataset = getActiveDatasetForSession(session, datasetId);
      const response = await runTwoAgentPipeline(
        activeDataset.runtime.db,
        activeDataset.runtime.schemaState,
        question,
        { injectFaultDemo: Boolean(injectFaultDemo) }
      );
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Read-only SQLite sandbox against the session's selected dataset
  app.post('/api/sandbox-sql', async (req, res) => {
    try {
      const session = await getOrInitSession(extractSessionId(req));
      const { sql, datasetId } = req.body as {
        sql?: string;
        datasetId?: string;
      };
      if (!sql || typeof sql !== 'string') {
        res.status(400).json({ error: 'SQL query string is required.' });
        return;
      }
      const activeDataset = getActiveDatasetForSession(session, datasetId);
      const result = executeSandboxedQuery(activeDataset.runtime.db, sql);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Explicit JSON 404 handler for any unmatched /api/* route — NEVER return HTML for API paths!
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      error: `API route "${req.method} ${req.originalUrl}" does not exist.`,
    });
  });

  // Global Express JSON Error Handler (catches malformed JSON, PayloadTooLargeError, etc.)
  app.use(
    (
      err: Error & { status?: number; statusCode?: number; type?: string },
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err.type === 'entity.too.large' || err.status === 413) {
        res.status(413).json({
          error:
            'Uploaded dataset exceeds the 50 MB request size limit. Please upload a smaller file.',
        });
        return;
      }
      if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({
          error: 'Malformed JSON request body.',
        });
        return;
      }
      const status = err.status || err.statusCode || 500;
      if (req.path.startsWith('/api/')) {
        res.status(status).json({
          error: err.message || 'Internal server error.',
        });
        return;
      }
      next(err);
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MyQuery Agent server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
