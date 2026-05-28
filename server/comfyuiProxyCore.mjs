const CORS_ORIGIN = process.env.COMFYUI_PROXY_CORS_ORIGIN || '*';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.COMFYUI_PROXY_TIMEOUT_MS || '300000', 10);

const isPrivateHostname = (hostname) => {
  const lower = String(hostname || '').toLowerCase();
  if (!lower) return false;
  if (lower === 'localhost' || lower === '::1') return true;
  if (/^127\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)) return true;
  return false;
};

const isAllowedComfyTarget = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return isPrivateHostname(parsed.hostname);
  } catch {
    return false;
  }
};

const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const writeJson = (res, statusCode, payload) => {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const readRequestBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks);
};

const passthroughResponseHeaders = new Set([
  'content-type',
  'content-length',
  'cache-control',
]);

export const createComfyuiProxyHandler = (options = {}) => {
  const proxyPrefix = options.proxyPrefix || '/api/comfyui-proxy';

  return async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      const requestUrl = new URL(req.url || '', 'http://localhost');
      const comfyBase = requestUrl.searchParams.get('__comfy_base');
      if (!comfyBase || !isAllowedComfyTarget(comfyBase)) {
        writeJson(res, 400, {
          error: 'Invalid or missing __comfy_base. Only local/private ComfyUI hosts are allowed.',
        });
        return;
      }

      let pathAndQuery = requestUrl.pathname;
      if (pathAndQuery.startsWith(proxyPrefix)) {
        pathAndQuery = pathAndQuery.slice(proxyPrefix.length) || '/';
      }

      const forwardParams = new URLSearchParams(requestUrl.searchParams);
      forwardParams.delete('__comfy_base');
      const queryString = forwardParams.toString();
      const targetUrl = `${String(comfyBase).trim().replace(/\/+$/, '')}${pathAndQuery}${queryString ? `?${queryString}` : ''}`;

      const headers = {};
      const contentType = req.headers['content-type'];
      if (contentType) {
        headers['Content-Type'] = contentType;
      }

      const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await readRequestBody(req);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let upstream;
      try {
        upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timeoutId);
      }

      res.statusCode = upstream.status;
      passthroughResponseHeaders.forEach((key) => {
        const value = upstream.headers.get(key);
        if (value) {
          res.setHeader(key, value);
        }
      });

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    } catch (error) {
      writeJson(res, 502, {
        error: 'ComfyUI proxy failed.',
        detail: error?.message || String(error),
      });
    }
  };
};
