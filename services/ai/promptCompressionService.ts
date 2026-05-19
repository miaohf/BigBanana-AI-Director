import { chatCompletion, getActiveChatModelName } from './apiCore';

export type PromptCompressionMode = 'image' | 'video' | 'generic';

export interface PromptCompressionOptions {
  text: string;
  maxChars: number;
  mode?: PromptCompressionMode;
  model?: string;
  timeoutMs?: number;
}

export interface PromptCompressionResult {
  text: string;
  compressed: boolean;
  model: string;
  reason: 'within-limit' | 'compressed' | 'no-improvement' | 'empty-output' | 'error';
  originalLength: number;
  finalLength: number;
}

const countChars = (input: string): number => Array.from(String(input || '')).length;

const normalizeOutput = (input: string): string =>
  String(input || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const buildCompressionPrompt = (
  text: string,
  maxChars: number,
  mode: PromptCompressionMode
): string => {
  const modeHint = mode === 'image'
    ? 'image generation'
    : mode === 'video'
      ? 'video generation'
      : 'content generation';

  return `Compress the following ${modeHint} prompt to <= ${maxChars} characters.

Hard requirements:
1. Preserve all critical constraints and prohibitions (especially MUST/DO NOT/FORBIDDEN rules).
2. Preserve ordering and numbering if present (for example 1-9 storyboard panel order).
3. Remove redundancy and verbose phrasing first.
4. Keep it directly actionable for a generation model.
5. Output only the compressed prompt text, no explanations.

Prompt to compress:
${text}`;
};

export const compressPromptWithLLM = async (
  options: PromptCompressionOptions
): Promise<PromptCompressionResult> => {
  const originalText = String(options.text || '');
  const originalLength = countChars(originalText);
  const maxChars = Math.max(200, Math.floor(options.maxChars || 0));
  const mode: PromptCompressionMode = options.mode || 'generic';
  const model = options.model || getActiveChatModelName();

  if (originalLength <= maxChars) {
    return {
      text: originalText,
      compressed: false,
      model,
      reason: 'within-limit',
      originalLength,
      finalLength: originalLength,
    };
  }

  try {
    const compressionPrompt = buildCompressionPrompt(originalText, maxChars, mode);
    const response = await chatCompletion(
      compressionPrompt,
      model,
      0.2,
      2048,
      undefined,
      options.timeoutMs ?? 60000
    );
    const candidate = normalizeOutput(response);
    const candidateLength = countChars(candidate);

    if (!candidate) {
      return {
        text: originalText,
        compressed: false,
        model,
        reason: 'empty-output',
        originalLength,
        finalLength: originalLength,
      };
    }

    if (candidateLength < originalLength) {
      return {
        text: candidate,
        compressed: true,
        model,
        reason: 'compressed',
        originalLength,
        finalLength: candidateLength,
      };
    }

    return {
      text: originalText,
      compressed: false,
      model,
      reason: 'no-improvement',
      originalLength,
      finalLength: originalLength,
    };
  } catch {
    return {
      text: originalText,
      compressed: false,
      model,
      reason: 'error',
      originalLength,
      finalLength: originalLength,
    };
  }
};

