import type { WorkspaceSchemaState } from '../types/domain';
import { apiFetch } from './apiClient';

const MAX_FILE_SIZE_BYTES = 45 * 1024 * 1024; // 45 MB per file
const BINARY_EXTENSIONS = new Set([
  'sqlite',
  'sqlite3',
  'db',
  'xlsx',
  'xls',
]);
const ALLOWED_EXTENSIONS = new Set([
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).trim().toLowerCase() : '';
}

export async function uploadDatasetFiles(
  fileList: FileList | File[],
  mode: 'replace' | 'append' = 'replace',
  datasetLabel?: string
): Promise<WorkspaceSchemaState> {
  const files = Array.from(fileList);
  if (files.length === 0) {
    throw new Error('Please select at least one file to upload.');
  }

  const payloads: {
    fileName: string;
    textContent?: string;
    base64Data?: string;
  }[] = [];

  for (const file of files) {
    if (file.size === 0) {
      throw new Error(
        `File "${file.name}" is empty (0 bytes). Please upload a valid non-empty dataset.`
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File "${file.name}" exceeds the 45 MB upload limit (${(
          file.size /
          (1024 * 1024)
        ).toFixed(1)} MB).`
      );
    }

    const ext = getFileExtension(file.name);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported file "${file.name}". Supported formats: .csv, .tsv, .xlsx, .xls, .sqlite, .db, .sqlite3, .sql, .json.`
      );
    }

    if (BINARY_EXTENSIONS.has(ext)) {
      const buf = await file.arrayBuffer();
      payloads.push({
        fileName: file.name,
        base64Data: arrayBufferToBase64(buf),
      });
    } else {
      const text = await file.text();
      if (!text.trim()) {
        throw new Error(`File "${file.name}" contains no readable text content.`);
      }
      payloads.push({
        fileName: file.name,
        textContent: text,
      });
    }
  }

  return apiFetch<WorkspaceSchemaState>('/api/workspace/upload', {
    method: 'POST',
    body: JSON.stringify({
      files: payloads,
      mode,
      datasetLabel: datasetLabel?.trim() || undefined,
    }),
  });
}
