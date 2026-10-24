const SESSION_STORAGE_KEY = 'myquery_agent_session_id';

export function getWorkspaceSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) {
      return existing;
    }
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `sess_${crypto.randomUUID().replace(/-/g, '')}`
        : `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, generated);
    return generated;
  } catch {
    return 'sess_fallback_local';
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('X-Workspace-Session', getWorkspaceSessionId());
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
    });
  } catch (networkErr: unknown) {
    const detail =
      networkErr instanceof Error ? networkErr.message : String(networkErr);
    throw new Error(
      `Unable to reach the MyQuery Agent server (${detail}). Please check that the server is running and try again.`
    );
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const rawBody = await response.text();
  const trimmedBody = rawBody.trim();

  // Guard against HTML responses (e.g., <!doctype html> from 404/502/504 proxies) before JSON.parse
  const looksLikeHtml =
    contentType.includes('text/html') ||
    trimmedBody.startsWith('<!doctype') ||
    trimmedBody.startsWith('<!DOCTYPE') ||
    trimmedBody.startsWith('<html');

  if (looksLikeHtml) {
    if (response.status === 413) {
      throw new Error(
        'Uploaded file is too large (HTTP 413). Please upload a dataset smaller than 45 MB.'
      );
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new Error(
        `The server timed out or was temporarily unavailable (HTTP ${response.status}). Please retry your request.`
      );
    }
    if (response.status === 404) {
      throw new Error(
        `API endpoint "${path}" was not found (HTTP 404).`
      );
    }
    throw new Error(
      `Server returned an unexpected HTML response instead of JSON (HTTP ${response.status}) on "${path}".`
    );
  }

  if (!trimmedBody) {
    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status}.`);
    }
    throw new Error(`Server returned an empty response from "${path}".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedBody);
  } catch {
    throw new Error(
      `Invalid JSON response received from "${path}" (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    const errObj = parsed as { error?: string; message?: string };
    throw new Error(
      errObj?.error ||
        errObj?.message ||
        `Request failed with HTTP ${response.status}.`
    );
  }

  return parsed as T;
}
