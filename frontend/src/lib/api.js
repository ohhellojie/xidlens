const metaContent = (name, fallback = '') =>
  document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || fallback;

export const LOCAL_TOKEN = metaContent('local-token', '');
export const APP_VERSION = metaContent('app-version', '2.0.0');

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (LOCAL_TOKEN) headers.set('X-Local-Token', LOCAL_TOKEN);
  const res = await fetch(path, { ...options, headers });
  const ctype = res.headers.get('content-type') || '';
  const data = ctype.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof data === 'object' && data?.error ? data.error : `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function postJson(path, body) {
  return apiRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function waitForLog(caseId, { signal, retry = false } = {}) {
  const path = `/api/log/meta?id=${encodeURIComponent(caseId)}`;
  let meta = await apiRequest(path + (retry ? '&retry=1' : ''), { signal });
  while (meta.state === 'indexing') {
    await new Promise((resolve) => setTimeout(resolve, 250));
    meta = await apiRequest(path, { signal });
  }
  if (meta.state !== 'ready') throw new Error(meta.message || '原日志读取失败');
  return meta;
}

export function uploadWithProgress(url, blobOrFile, onProgress, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    if (LOCAL_TOKEN) xhr.setRequestHeader('X-Local-Token', LOCAL_TOKEN);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      let parsed = {};
      try { parsed = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed);
      else reject(new Error(parsed.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('网络连接中断'));
    xhr.onabort = () => reject(new Error('已取消'));
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    xhr.send(blobOrFile);
  });
}

export async function saveTextFile(filename, content, mime = 'text/plain;charset=utf-8') {
  if (window.pywebview) {
    if (!window.pywebview.api?.save_text) throw new Error('保存窗口尚未就绪，请重试');
    return window.pywebview.api.save_text(filename, content);
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
