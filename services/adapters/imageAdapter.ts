/**
 * 图片模型适配器
 * 处理 Gemini Image API
 */

import { ImageModelDefinition, ImageGenerateOptions, AspectRatio } from '../../types/model';
import { getApiKeyForModel, getApiBaseUrlForModel, getActiveImageModel } from '../modelRegistry';
import {
  getImageApiFormat,
  getDefaultImageEndpoint,
  resolveOpenAiImageEndpoint,
  mapAspectRatioToOpenAiImageSize,
} from '../imageModelUtils';
import { ApiKeyError } from './chatAdapter';
import { resolveComfyApiBaseUrl, resolveEndpointUrl } from '../urlUtils';

/**
 * 重试操作
 */
const retryOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 2000
): Promise<T> => {
  let lastError: Error | null = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const status = error?.status;
      // 400/401/403 错误不重试
      if (status === 400 ||
          status === 401 ||
          status === 403 ||
          error.message?.includes('400') || 
          error.message?.includes('401') || 
          error.message?.includes('403')) {
        throw error;
      }
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }
  
  throw lastError;
};

const parseHttpErrorBody = async (res: Response): Promise<string> => {
  let errorMessage = `HTTP 错误: ${res.status}`;
  try {
    const errorData = await res.json();
    errorMessage = errorData.error?.message || errorMessage;
  } catch (e) {
    const errorText = await res.text();
    if (errorText) errorMessage = errorText;
  }
  return errorMessage;
};

const buildImageApiError = (status: number, backendMessage?: string): Error => {
  const detail = backendMessage?.trim();
  const withDetail = (message: string): string => (detail ? `${message}（接口信息：${detail}）` : message);

  let message: string;
  if (status === 400) {
    message = withDetail('图片生成失败：提示词可能被风控拦截，请修改提示词后重试。');
  } else if (status === 500 || status === 503) {
    message = withDetail('图片生成失败：服务器繁忙，请稍后重试。');
  } else if (status === 429) {
    message = withDetail('图片生成失败：请求过于频繁，请稍后再试。');
  } else {
    message = withDetail(`图片生成失败：接口请求异常（HTTP ${status}）。`);
  }

  const err: any = new Error(message);
  err.status = status;
  return err;
};

const MAX_IMAGE_PROMPT_CHARS = 5000;
const OPENAI_IMAGE_QUALITY = 'medium';
const OPENAI_IMAGE_OUTPUT_FORMAT = 'png';
const OPENAI_IMAGE_OUTPUT_COMPRESSION = 100;
const COMFYUI_POLL_INTERVAL_MS = 1000;
const COMFYUI_MAX_POLLS = 180;

const truncatePromptToMaxChars = (
  input: string,
  maxChars: number
): { text: string; wasTruncated: boolean; originalLength: number } => {
  const chars = Array.from(input);
  const originalLength = chars.length;
  if (originalLength <= maxChars) {
    return { text: input, wasTruncated: false, originalLength };
  }
  return {
    text: chars.slice(0, maxChars).join(''),
    wasTruncated: true,
    originalLength,
  };
};

const dataUrlToImageFile = (dataUrl: string, filename: string): File | null => {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  try {
    const mimeType = match[1];
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], filename, { type: mimeType });
  } catch {
    return null;
  }
};

const extractImageFromOpenAiResponse = (response: any): string | null => {
  const first = response?.data?.[0];
  if (!first) return null;
  if (first.b64_json) {
    const format = first.output_format || OPENAI_IMAGE_OUTPUT_FORMAT;
    return `data:image/${format};base64,${first.b64_json}`;
  }
  if (first.url) {
    return String(first.url);
  }
  return null;
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image blob.'));
    reader.readAsDataURL(blob);
  });

const mapAspectRatioToComfySize = (aspectRatio: AspectRatio): { width: number; height: number } => {
  switch (aspectRatio) {
    case '9:16':
      return { width: 576, height: 1024 };
    case '1:1':
      return { width: 1024, height: 1024 };
    case '16:9':
    default:
      return { width: 1024, height: 576 };
  }
};

const resolveWorkflowTemplateUrls = (workflowName: string): string[] => {
  const trimmed = workflowName.trim();
  if (!trimmed) {
    throw new Error('ComfyUI 工作流名称为空，请在图片模型中配置 workflowName。');
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    return [trimmed];
  }
  const baseName = trimmed.endsWith('.json') ? trimmed.slice(0, -5) : trimmed;
  const candidates = [
    baseName,
    baseName.replace(/-/g, '_'),
    baseName.replace(/_/g, '-'),
  ];
  return Array.from(new Set(candidates)).map(name => `/workflows/${encodeURIComponent(`${name}.json`)}`);
};

const loadComfyWorkflowTemplate = async (workflowName: string): Promise<any> => {
  const urls = resolveWorkflowTemplateUrls(workflowName);
  for (const url of urls) {
    console.info('[ComfyUI Image] Loading workflow template:', url);
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) {
      console.info('[ComfyUI Image] Workflow template loaded:', url);
      return response.json();
    }
    console.warn('[ComfyUI Image] Workflow template not found:', url, response.status);
  }
  throw new Error(`ComfyUI 工作流模板加载失败：已尝试 ${urls.join('、')}`);
};

const patchComfyWorkflow = (
  workflow: any,
  options: {
    prompt: string;
    width: number;
    height: number;
    seed: number;
    steps: number;
  }
): any => {
  const patched = structuredClone(workflow);
  const nodes = patched?.prompt || patched;
  if (!nodes || typeof nodes !== 'object') {
    throw new Error('ComfyUI 工作流模板格式无效：需要 API Format JSON。');
  }

  let promptPatched = false;
  Object.values(nodes).forEach((node: any) => {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== 'object') return;
    const classType = String(node.class_type || '').toLowerCase();

    if ('text' in inputs && typeof inputs.text === 'string' && classType.includes('clip')) {
      inputs.text = options.prompt;
      promptPatched = true;
    }
    if ('prompt' in inputs && typeof inputs.prompt === 'string') {
      inputs.prompt = options.prompt;
      promptPatched = true;
    }
    if ('positive' in inputs && typeof inputs.positive === 'string') {
      inputs.positive = options.prompt;
      promptPatched = true;
    }
    if ('width' in inputs && typeof inputs.width === 'number') inputs.width = options.width;
    if ('height' in inputs && typeof inputs.height === 'number') inputs.height = options.height;
    if ('seed' in inputs && typeof inputs.seed === 'number') inputs.seed = options.seed;
    if ('noise_seed' in inputs && typeof inputs.noise_seed === 'number') inputs.noise_seed = options.seed;
    if ('steps' in inputs && typeof inputs.steps === 'number') inputs.steps = options.steps;
  });

  if (!promptPatched) {
    throw new Error('ComfyUI 工作流模板中没有找到可替换的 prompt 文本节点。');
  }

  return nodes;
};

const buildComfyViewUrl = (apiBase: string, image: any): string => {
  const params = new URLSearchParams();
  params.set('filename', String(image.filename || ''));
  if (image.subfolder) params.set('subfolder', String(image.subfolder));
  if (image.type) params.set('type', String(image.type));
  return `${apiBase}/view?${params.toString()}`;
};

const callComfyImageApi = async (
  apiBase: string,
  workflowName: string,
  options: {
    prompt: string;
    aspectRatio: AspectRatio;
    steps: number;
  }
): Promise<string> => {
  try {
    console.info('[ComfyUI Image] Start generation:', { apiBase, workflowName });
    const workflow = await loadComfyWorkflowTemplate(workflowName);
    const { width, height } = mapAspectRatioToComfySize(options.aspectRatio);
    const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const prompt = patchComfyWorkflow(workflow, {
      prompt: options.prompt,
      width,
      height,
      seed,
      steps: options.steps,
    });
    console.info('[ComfyUI Image] Workflow patched:', { width, height, seed, steps: options.steps });

    const clientId = `bigbanana-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const promptUrl = `${apiBase}/prompt`;
    console.info('[ComfyUI Image] POST prompt:', promptUrl);
    const queueResponse = await fetch(promptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
    });

    if (!queueResponse.ok) {
      const backendMessage = await parseHttpErrorBody(queueResponse);
      throw new Error(`ComfyUI 提交工作流失败：${backendMessage}`);
    }

    const queued = await queueResponse.json();
    const promptId = queued?.prompt_id;
    if (!promptId) {
      throw new Error('ComfyUI 未返回 prompt_id。');
    }
    console.info('[ComfyUI Image] Queued prompt:', promptId);

    for (let i = 0; i < COMFYUI_MAX_POLLS; i += 1) {
      await new Promise(resolve => setTimeout(resolve, COMFYUI_POLL_INTERVAL_MS));
      const historyUrl = `${apiBase}/history/${promptId}`;
      const historyResponse = await fetch(historyUrl);
      if (!historyResponse.ok) {
        if (i % 10 === 0) console.warn('[ComfyUI Image] History polling failed:', historyUrl, historyResponse.status);
        continue;
      }
      const history = await historyResponse.json();
      const record = history?.[promptId];
      const outputs = record?.outputs;
      if (!outputs) continue;

      for (const output of Object.values(outputs) as any[]) {
        const image = output?.images?.[0];
        if (!image?.filename) continue;
        const viewUrl = buildComfyViewUrl(apiBase, image);
        console.info('[ComfyUI Image] Fetch output:', viewUrl);
        const viewResponse = await fetch(viewUrl);
        if (!viewResponse.ok) {
          const backendMessage = await parseHttpErrorBody(viewResponse);
          throw new Error(`ComfyUI 图片读取失败：${backendMessage}`);
        }
        return blobToDataUrl(await viewResponse.blob());
      }
    }

    throw new Error('ComfyUI 图片生成超时，请检查队列或工作流输出节点。');
  } catch (error) {
    console.error('[ComfyUI Image] Generation failed:', error);
    throw error;
  }
};

/**
 * 调用图片生成 API
 */
export const callImageApi = async (
  options: ImageGenerateOptions,
  model?: ImageModelDefinition
): Promise<string> => {
  // 获取当前激活的模型
  const activeModel = model || getActiveImageModel();
  if (!activeModel) {
    throw new Error('没有可用的图片模型');
  }

  const apiBase = getApiBaseUrlForModel(activeModel.id);
  const apiModel = activeModel.apiModel || activeModel.id;
  const apiFormat = getImageApiFormat(activeModel);
  const endpointTemplate = activeModel.endpoint || getDefaultImageEndpoint(apiFormat, apiModel);
  const endpoint = endpointTemplate.replace('{model}', apiModel);
  
  // 确定宽高比
  const aspectRatio = options.aspectRatio || activeModel.params.defaultAspectRatio;
  
  // 构建提示词
  let finalPrompt = options.prompt;
  
  // 如果有参考图，添加一致性指令
  if (options.referenceImages && options.referenceImages.length > 0) {
    finalPrompt = `
      ⚠️⚠️⚠️ CRITICAL REQUIREMENTS - CHARACTER CONSISTENCY ⚠️⚠️⚠️
      
      Reference Images Information:
      - The FIRST image is the Scene/Environment reference.
      - Any subsequent images are Character references (Base Look or Variation).
      
      Task:
      Generate a cinematic shot matching this prompt: "${options.prompt}".
      
      ⚠️ ABSOLUTE REQUIREMENTS (NON-NEGOTIABLE):
      1. Scene Consistency:
         - STRICTLY maintain the visual style, lighting, and environment from the scene reference.
      
      2. Character Consistency - HIGHEST PRIORITY:
         If characters are present in the prompt, they MUST be IDENTICAL to the character reference images:
         • Facial Features: Eyes (color, shape, size), nose structure, mouth shape, facial contours must be EXACTLY the same
         • Hairstyle & Hair Color: Length, color, texture, and style must be PERFECTLY matched
         • Clothing & Outfit: Style, color, material, and accessories must be IDENTICAL
         • Body Type: Height, build, proportions must remain consistent
         
      ⚠️ DO NOT create variations or interpretations of the character - STRICT REPLICATION ONLY!
      ⚠️ Character appearance consistency is THE MOST IMPORTANT requirement!
    `;
  }

  const promptLimitResult = truncatePromptToMaxChars(finalPrompt, MAX_IMAGE_PROMPT_CHARS);
  if (promptLimitResult.wasTruncated) {
    console.warn(
      `[ImagePrompt] Prompt exceeded ${MAX_IMAGE_PROMPT_CHARS} chars ` +
      `(${promptLimitResult.originalLength}). Truncated before image request.`
    );
  }
  finalPrompt = promptLimitResult.text;

  if (apiFormat === 'comfyui') {
    const comfyApiBase = resolveComfyApiBaseUrl(apiBase, activeModel.endpoint);
    const workflowName = activeModel.params.workflowName || apiModel;
    return callComfyImageApi(comfyApiBase, workflowName, {
      prompt: finalPrompt,
      aspectRatio,
      steps: activeModel.params.steps || 20,
    });
  }

  // 获取 API 配置（ComfyUI 本地工作流不需要 API Key）
  const apiKey = getApiKeyForModel(activeModel.id);
  if (!apiKey) {
    throw new ApiKeyError('API Key 缺失，请在设置中配置 API Key');
  }

  if (apiFormat === 'openai') {
    const hasReferenceImages = Boolean(options.referenceImages?.length);
    const resolvedEndpoint = resolveOpenAiImageEndpoint(endpoint, hasReferenceImages);
    const openAiSize = mapAspectRatioToOpenAiImageSize(aspectRatio);

    const response = await retryOperation(async () => {
      let res: Response;
      if (hasReferenceImages) {
        const files = (options.referenceImages || [])
          .map((img, index) => dataUrlToImageFile(img, `reference-${index + 1}.png`))
          .filter((file): file is File => Boolean(file));

        if (files.length === 0) {
          throw new Error('图片生成失败：参考图格式无效，请上传图片后重试。');
        }

        const formData = new FormData();
        formData.append('model', apiModel);
        formData.append('prompt', finalPrompt);
        formData.append('size', openAiSize);
        formData.append('quality', OPENAI_IMAGE_QUALITY);
        formData.append('output_format', OPENAI_IMAGE_OUTPUT_FORMAT);
        formData.append('output_compression', String(OPENAI_IMAGE_OUTPUT_COMPRESSION));
        formData.append('n', '1');
        files.forEach(file => formData.append('image[]', file));

        res = await fetch(resolveEndpointUrl(apiBase, resolvedEndpoint), {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': '*/*',
          },
          body: formData,
        });
      } else {
        const requestBody = {
          model: apiModel,
          prompt: finalPrompt,
          size: openAiSize,
          quality: OPENAI_IMAGE_QUALITY,
          output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
          output_compression: OPENAI_IMAGE_OUTPUT_COMPRESSION,
          n: 1,
        };

        res = await fetch(resolveEndpointUrl(apiBase, resolvedEndpoint), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Accept': '*/*',
          },
          body: JSON.stringify(requestBody),
        });
      }

      if (!res.ok) {
        const backendMessage = await parseHttpErrorBody(res);
        throw buildImageApiError(res.status, backendMessage);
      }

      return await res.json();
    });

    const imageData = extractImageFromOpenAiResponse(response);
    if (imageData) {
      return imageData;
    }

    throw new Error('图片生成失败：OpenAI Images 未返回有效图片数据。');
  }

  // Gemini generateContent protocol
  const parts: any[] = [{ text: finalPrompt }];
  if (options.referenceImages) {
    options.referenceImages.forEach((imgUrl) => {
      const match = imgUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    });
  }

  const requestBody: any = {
    contents: [{
      role: 'user',
      parts: parts,
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio,
      },
    },
  };

  const response = await retryOperation(async () => {
    const res = await fetch(resolveEndpointUrl(apiBase, endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': '*/*',
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const backendMessage = await parseHttpErrorBody(res);
      throw buildImageApiError(res.status, backendMessage);
    }

    return await res.json();
  });

  const candidates = response.candidates || [];
  if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts) {
    for (const part of candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }

  const hasSafetyBlock =
    !!response?.promptFeedback?.blockReason ||
    candidates.some((candidate: any) => {
      const finishReason = String(candidate?.finishReason || '').toUpperCase();
      return finishReason.includes('SAFETY') || finishReason.includes('BLOCK');
    });

  if (hasSafetyBlock) {
    throw new Error('图片生成失败：提示词可能被风控拦截，请修改提示词后重试。');
  }

  throw new Error('图片生成失败：未返回有效图片数据，请重试或调整提示词。');
};

/**
 * 检查宽高比是否支持
 */
export const isAspectRatioSupported = (
  aspectRatio: AspectRatio,
  model?: ImageModelDefinition
): boolean => {
  const activeModel = model || getActiveImageModel();
  if (!activeModel) return false;
  
  return activeModel.params.supportedAspectRatios.includes(aspectRatio);
};
