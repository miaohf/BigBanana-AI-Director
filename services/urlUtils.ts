export const isAbsoluteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(String(value || '').trim());

export const normalizeBaseUrl = (value: string): string => String(value || '').trim().replace(/\/+$/, '');

const isPrivateHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  if (/^127\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)) return true;
  return false;
};

/** ComfyUI 常用本地端口，不应作为云端 API 提供商 Base URL */
export const isComfyUiServiceBaseUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(normalizeBaseUrl(baseUrl));
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return isPrivateHostname(parsed.hostname) && (port === '8188' || port === '8189');
  } catch {
    return false;
  }
};

const isFrontendDevServerUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(normalizeBaseUrl(baseUrl));
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (!isPrivateHostname(parsed.hostname)) return false;
    return ['5173', '4173'].includes(port);
  } catch {
    return false;
  }
};

/**
 * 校验全局「远程 API Base URL」（对话/云端视频/远程图片等）。
 * 与 ComfyUI 地址分离；允许自建网关、局域网地址，以及与当前页面同源的反向代理（如 :3000）。
 * @returns 错误说明；null 表示可用
 */
export const validateRemoteApiBaseUrl = (baseUrl: string): string | null => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized || !isAbsoluteHttpUrl(normalized)) {
    return 'API Base URL 格式不正确，请填写完整的 http:// 或 https:// 地址';
  }

  if (isComfyUiServiceBaseUrl(normalized)) {
    return 'ComfyUI 地址（8188/8189）请填在 ComfyUI 模型的 API 地址字段';
  }

  if (isFrontendDevServerUrl(normalized)) {
    return 'Vite 预览端口（5173/4173）不能作为 API 地址，请填写 LLM 代理的实际服务地址';
  }

  return null;
};

/** 远程 API 提供商 Base URL 是否有效 */
export const isValidCloudApiBaseUrl = (baseUrl: string): boolean =>
  validateRemoteApiBaseUrl(baseUrl) === null;

export const resolveEndpointUrl = (baseUrl: string, endpoint: string): string => {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (isAbsoluteHttpUrl(normalizedEndpoint)) {
    return normalizeBaseUrl(normalizedEndpoint);
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedEndpoint) {
    return normalizedBase;
  }

  if (!normalizedBase) {
    throw new Error('API Base URL 未配置，请在对应模型的卡片中填写 API Base URL。');
  }

  return `${normalizedBase}${normalizedEndpoint.startsWith('/') ? normalizedEndpoint : `/${normalizedEndpoint}`}`;
};

export const resolveModelBaseUrl = (providerBaseUrl: string, modelEndpoint?: string): string => {
  const endpoint = String(modelEndpoint || '').trim();
  return isAbsoluteHttpUrl(endpoint) ? normalizeBaseUrl(endpoint) : normalizeBaseUrl(providerBaseUrl);
};

export const resolveComfyApiBaseUrl = (providerBaseUrl: string, modelEndpoint?: string): string =>
  resolveModelBaseUrl(providerBaseUrl, modelEndpoint)
    .replace(/\/prompt$/i, '')
    .replace(/\/history\/?$/i, '')
    .replace(/\/view$/i, '')
    .replace(/\/upload\/image$/i, '');

const COMFYUI_PROXY_PREFIX = '/api/comfyui-proxy';
const COMFYUI_BASE_QUERY_KEY = '__comfy_base';

export const shouldUseComfyProxy = (apiBase: string): boolean => {
  if (typeof window === 'undefined') return false;

  const normalized = normalizeBaseUrl(apiBase);
  if (!normalized) return false;

  if (!isAbsoluteHttpUrl(normalized)) {
    return normalized.startsWith(COMFYUI_PROXY_PREFIX);
  }

  try {
    const parsed = new URL(normalized);
    if (isPrivateHostname(parsed.hostname)) return true;
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
};

export const buildComfyApiUrl = (apiBase: string, apiPath: string): string => {
  const base = normalizeBaseUrl(apiBase);
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;

  if (!shouldUseComfyProxy(base)) {
    return `${base}${normalizedPath}`;
  }

  const [pathname, search = ''] = normalizedPath.split('?');
  const params = new URLSearchParams(search);
  params.set(COMFYUI_BASE_QUERY_KEY, base);
  const queryString = params.toString();
  return `${COMFYUI_PROXY_PREFIX}${pathname}${queryString ? `?${queryString}` : ''}`;
};
