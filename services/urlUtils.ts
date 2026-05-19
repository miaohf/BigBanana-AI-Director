export const isAbsoluteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(String(value || '').trim());

export const normalizeBaseUrl = (value: string): string => String(value || '').trim().replace(/\/+$/, '');

export const resolveEndpointUrl = (baseUrl: string, endpoint: string): string => {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (isAbsoluteHttpUrl(normalizedEndpoint)) {
    return normalizeBaseUrl(normalizedEndpoint);
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedEndpoint) {
    return normalizedBase;
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
