export const DEFAULT_CHAT_VERIFY_MODEL = 'gpt-5.4';

const CHAT_MODEL_ID_ALIASES: Record<string, string> = {
  'gpt-41': 'gpt-5.4',
};

export const normalizeChatModelId = (modelId?: string): string | undefined => {
  if (!modelId) return modelId;

  const trimmedModelId = modelId.trim();
  return CHAT_MODEL_ID_ALIASES[trimmedModelId.toLowerCase()] || trimmedModelId;
};
