/**
 * 配音生成服务
 * 默认通过 Chat Completions 的 audio 输出能力生成配音，
 * 同时兼容自定义 endpoint 指向 /v1/audio/speech 的场景。
 */

import { AudioOutputFormat } from '../../types/model';
import {
  retryOperation,
  checkApiKey,
  getApiBase,
  resolveModel,
  resolveRequestModel,
  parseHttpError,
  ApiKeyError,
} from './apiCore';
import { isAbsoluteHttpUrl, resolveEndpointUrl } from '../urlUtils';

export type DubbingMode = 'narration' | 'dialogue';

export interface GenerateDubbingAudioOptions {
  text: string;
  model?: string;
  mode?: DubbingMode;
  language?: string;
  voice?: string;
  format?: AudioOutputFormat;
  temperature?: number;
  timeoutMs?: number;
}

export interface GenerateDubbingAudioResult {
  audioDataUrl: string;
  transcript: string;
  usedModel: string;
  usedVoice: string;
  usedFormat: AudioOutputFormat;
}

const DEFAULT_AUDIO_MODEL = 'gpt-audio-1.5';
const DEFAULT_TIMEOUT_MS = 180000;

const getMimeType = (format: AudioOutputFormat): string => {
  if (format === 'mp3') return 'audio/mpeg';
  return 'audio/wav';
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string) || '');
    reader.onerror = () => reject(new Error('配音结果读取失败'));
    reader.readAsDataURL(blob);
  });

const buildPromptText = (text: string, mode: DubbingMode, language: string): string => {
  const styleInstruction =
    mode === 'narration'
      ? `请使用自然、克制的${language}旁白语气朗读以下内容，保持节奏稳定，不要添加额外文本。`
      : `请使用有情绪但不过度夸张的${language}对白语气朗读以下内容，保持语义清晰，不要添加额外文本。`;
  return `${styleInstruction}\n\n${text}`;
};

const extractTextFromMessageContent = (content: any): string => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const callSpeechEndpoint = async (
  apiBase: string,
  endpoint: string,
  apiKey: string,
  model: string,
  promptText: string,
  voice: string,
  format: AudioOutputFormat,
  timeoutMs: number
): Promise<string> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestUrl = resolveEndpointUrl(apiBase, endpoint);
    const response = await retryOperation(async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const res = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          voice,
          input: promptText,
          response_format: format,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw await parseHttpError(res);
      }

      return res;
    });

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const base64Audio = payload?.audio || payload?.data || '';
      if (!base64Audio) {
        throw new Error('配音接口未返回音频数据');
      }
      return `data:${getMimeType(format)};base64,${base64Audio}`;
    }

    const audioBlob = await response.blob();
    return blobToDataUrl(audioBlob);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`配音请求超时 (${Math.floor(timeoutMs / 1000)} 秒)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * 生成配音音频
 */
export const generateDubbingAudio = async (
  options: GenerateDubbingAudioOptions
): Promise<GenerateDubbingAudioResult> => {
  const rawText = String(options.text || '').trim();
  if (!rawText) {
    throw new Error('配音文本不能为空');
  }

  const requestedModel = options.model || DEFAULT_AUDIO_MODEL;
  const resolvedAudioModel = resolveModel('audio', requestedModel);
  const usedModel =
    resolveRequestModel('audio', requestedModel) ||
    resolvedAudioModel?.apiModel ||
    resolvedAudioModel?.id ||
    DEFAULT_AUDIO_MODEL;

  const params = (resolvedAudioModel?.params || {}) as any;
  const usedVoice = (options.voice || params.defaultVoice || 'alloy').trim() || 'alloy';
  const usedFormat = (options.format || params.outputFormat || 'wav') as AudioOutputFormat;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const mode = options.mode || 'narration';
  const language = options.language || '中文';
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.6;
  const endpoint = resolvedAudioModel?.endpoint || '/v1/chat/completions';

  let apiKey = '';
  try {
    apiKey = checkApiKey('audio', requestedModel);
  } catch (error) {
    if (!(isAbsoluteHttpUrl(endpoint) && error instanceof ApiKeyError)) {
      throw error;
    }
  }
  const apiBase = getApiBase('audio', requestedModel);
  const promptText = buildPromptText(rawText, mode, language);

  if (endpoint.includes('/audio/speech')) {
    const audioDataUrl = await callSpeechEndpoint(
      apiBase,
      endpoint,
      apiKey,
      usedModel,
      promptText,
      usedVoice,
      usedFormat,
      timeoutMs
    );

    return {
      audioDataUrl,
      transcript: rawText,
      usedModel,
      usedVoice,
      usedFormat,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestUrl = resolveEndpointUrl(apiBase, endpoint);
    const response = await retryOperation(async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const res = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: usedModel,
          modalities: ['text', 'audio'],
          audio: {
            voice: usedVoice,
            format: usedFormat,
          },
          messages: [
            {
              role: 'user',
              content: promptText,
            },
          ],
          temperature,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw await parseHttpError(res);
      }
      return res;
    });

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    const audioPayload = message?.audio;
    const audioBase64 = audioPayload?.data;
    const transcript =
      audioPayload?.transcript ||
      extractTextFromMessageContent(message?.content) ||
      rawText;

    if (!audioBase64) {
      throw new Error('模型未返回音频数据，请检查当前模型是否支持音频输出');
    }

    return {
      audioDataUrl: `data:${getMimeType(usedFormat)};base64,${audioBase64}`,
      transcript,
      usedModel,
      usedVoice,
      usedFormat,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`配音请求超时 (${Math.floor(timeoutMs / 1000)} 秒)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

