/**
 * 视频模型适配器
 * 处理同步（chat/completions）和异步（/v1/videos）视频 API
 */

import { VideoModelDefinition, VideoGenerateOptions, AspectRatio, VideoDuration } from '../../types/model';
import { getApiKeyForModel, getApiBaseUrlForModel, getActiveVideoModel } from '../modelRegistry';
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
      if (error.message?.includes('400') || 
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

/**
 * 调整图片尺寸
 */
const resizeImageToSize = async (base64Data: string, targetWidth: number, targetHeight: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建 canvas 上下文'));
        return;
      }
      const scale = Math.max(targetWidth / img.width, targetHeight / img.height);
      const scaledWidth = img.width * scale;
      const scaledHeight = img.height * scale;
      const offsetX = (targetWidth - scaledWidth) / 2;
      const offsetY = (targetHeight - scaledHeight) / 2;
      ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);
      const result = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      resolve(result);
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = `data:image/png;base64,${base64Data}`;
  });
};

const convertVideoUrlToBase64 = async (videoUrl: string): Promise<string> => {
  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(`视频下载失败: ${response.status}`);
  }
  const videoBlob = await response.blob();
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onloadend = () => {
      const result = reader.result as string;
      if (result && result.startsWith('data:')) {
        resolve(result);
      } else {
        reject(new Error('视频转换失败'));
      }
    };
    reader.onerror = () => reject(new Error('视频读取失败'));
    reader.readAsDataURL(videoBlob);
  });
};

/**
 * 根据宽高比获取尺寸
 */
const getSizeFromAspectRatio = (aspectRatio: AspectRatio): { width: number; height: number; size: string } => {
  const sizeMap: Record<AspectRatio, { width: number; height: number; size: string }> = {
    '16:9': { width: 1280, height: 720, size: '1280x720' },
    '9:16': { width: 720, height: 1280, size: '720x1280' },
    '1:1': { width: 720, height: 720, size: '720x720' },
  };
  return sizeMap[aspectRatio];
};

const SORA_COMPATIBLE_VIDEO_MODELS = new Set([
  'sora-2',
  'doubao-seedance-1-5-pro',
]);

const isSoraCompatibleVideoModel = (modelName: string): boolean =>
  SORA_COMPATIBLE_VIDEO_MODELS.has((modelName || '').trim().toLowerCase());

const COMFYUI_POLL_INTERVAL_MS = 2000;
const COMFYUI_MAX_POLLS = 600;

const parseHttpErrorBody = async (res: Response): Promise<string> => {
  let errorMessage = `HTTP 错误: ${res.status}`;
  try {
    const errorData = await res.json();
    errorMessage = errorData.error?.message || errorData.message || errorMessage;
  } catch {
    try {
      const errorText = await res.text();
      if (errorText) errorMessage = errorText;
    } catch {
      // ignore
    }
  }
  return errorMessage;
};

const dataUrlToBlob = (dataUrl: string): Blob => {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error('ComfyUI 视频工作流参考图格式无效。');
  }
  const mimeType = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const resolveWorkflowTemplateUrl = (workflowName: string): string => {
  const trimmed = workflowName.trim();
  if (!trimmed) {
    throw new Error('ComfyUI 视频工作流名称为空，请在视频模型中配置 workflowName。');
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    return trimmed;
  }
  const filename = trimmed.endsWith('.json') ? trimmed : `${trimmed}.json`;
  return `/workflows/${encodeURIComponent(filename)}`;
};

const loadComfyWorkflowTemplate = async (workflowName: string): Promise<any> => {
  const url = resolveWorkflowTemplateUrl(workflowName);
  console.info('[ComfyUI Video] Loading workflow template:', url);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`ComfyUI 视频工作流模板加载失败：${url}（HTTP ${response.status}）`);
  }
  console.info('[ComfyUI Video] Workflow template loaded:', url);
  return response.json();
};

const uploadComfyImage = async (apiBase: string, imageDataUrl: string, filename: string): Promise<string> => {
  const formData = new FormData();
  formData.append('image', dataUrlToBlob(imageDataUrl), filename);
  formData.append('overwrite', 'true');
  const uploadUrl = `${apiBase}/upload/image`;
  console.info('[ComfyUI Video] Upload reference image:', uploadUrl, filename);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const detail = await parseHttpErrorBody(response);
    throw new Error(`ComfyUI 参考图上传失败：${detail}`);
  }
  const result = await response.json();
  return result?.name || filename;
};

const patchComfyVideoWorkflow = (
  workflow: any,
  options: {
    prompt: string;
    width: number;
    height: number;
    seed: number;
    steps: number;
    duration: number;
    startImageName?: string;
    endImageName?: string;
  }
): any => {
  const patched = structuredClone(workflow);
  const nodes = patched?.prompt || patched;
  if (!nodes || typeof nodes !== 'object') {
    throw new Error('ComfyUI 视频工作流模板格式无效：需要 API Format JSON。');
  }

  let promptPatched = false;
  let firstImagePatched = false;
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
    if ('duration' in inputs && typeof inputs.duration === 'number') inputs.duration = options.duration;
    if ('seconds' in inputs && typeof inputs.seconds === 'number') inputs.seconds = options.duration;

    if (options.startImageName && 'image' in inputs && typeof inputs.image === 'string') {
      inputs.image = firstImagePatched && options.endImageName ? options.endImageName : options.startImageName;
      firstImagePatched = true;
    }
  });

  if (!promptPatched) {
    throw new Error('ComfyUI 视频工作流模板中没有找到可替换的 prompt 文本节点。');
  }

  return nodes;
};

const buildComfyViewUrl = (apiBase: string, file: any): string => {
  const params = new URLSearchParams();
  params.set('filename', String(file.filename || ''));
  if (file.subfolder) params.set('subfolder', String(file.subfolder));
  if (file.type) params.set('type', String(file.type));
  return `${apiBase}/view?${params.toString()}`;
};

const callComfyVideoApi = async (
  options: VideoGenerateOptions,
  model: VideoModelDefinition,
  apiBase: string
): Promise<string> => {
  try {
    const aspectRatio = options.aspectRatio || model.params.defaultAspectRatio;
    const duration = Number(options.duration || model.params.defaultDuration || 5);
    const { width, height } = getSizeFromAspectRatio(aspectRatio);
    const workflowName = model.params.workflowName || model.apiModel || model.id;
    console.info('[ComfyUI Video] Start generation:', { apiBase, workflowName });
    const workflow = await loadComfyWorkflowTemplate(workflowName);
    const startImageName = options.startImage
      ? await uploadComfyImage(apiBase, options.startImage, `bigbanana-start-${Date.now()}.png`)
      : undefined;
    const endImageName = options.endImage
      ? await uploadComfyImage(apiBase, options.endImage, `bigbanana-end-${Date.now()}.png`)
      : undefined;
    const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const prompt = patchComfyVideoWorkflow(workflow, {
      prompt: options.prompt,
      width,
      height,
      seed,
      steps: model.params.steps || 20,
      duration,
      startImageName,
      endImageName,
    });
    console.info('[ComfyUI Video] Workflow patched:', { width, height, seed, steps: model.params.steps || 20, duration });

    const clientId = `bigbanana-video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const promptUrl = `${apiBase}/prompt`;
    console.info('[ComfyUI Video] POST prompt:', promptUrl);
    const queueResponse = await fetch(promptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
    });
    if (!queueResponse.ok) {
      const detail = await parseHttpErrorBody(queueResponse);
      throw new Error(`ComfyUI 提交视频工作流失败：${detail}`);
    }

    const queued = await queueResponse.json();
    const promptId = queued?.prompt_id;
    if (!promptId) {
      throw new Error('ComfyUI 未返回 prompt_id。');
    }
    console.info('[ComfyUI Video] Queued prompt:', promptId);

    for (let i = 0; i < COMFYUI_MAX_POLLS; i += 1) {
      await new Promise(resolve => setTimeout(resolve, COMFYUI_POLL_INTERVAL_MS));
      const historyUrl = `${apiBase}/history/${promptId}`;
      const historyResponse = await fetch(historyUrl);
      if (!historyResponse.ok) {
        if (i % 10 === 0) console.warn('[ComfyUI Video] History polling failed:', historyUrl, historyResponse.status);
        continue;
      }
      const history = await historyResponse.json();
      const outputs = history?.[promptId]?.outputs;
      if (!outputs) continue;

      for (const output of Object.values(outputs) as any[]) {
        const file = output?.videos?.[0] || output?.gifs?.[0] || output?.images?.[0];
        if (!file?.filename) continue;
        const viewUrl = buildComfyViewUrl(apiBase, file);
        console.info('[ComfyUI Video] Fetch output:', viewUrl);
        const viewResponse = await fetch(viewUrl);
        if (!viewResponse.ok) {
          const detail = await parseHttpErrorBody(viewResponse);
          throw new Error(`ComfyUI 视频读取失败：${detail}`);
        }
        const videoBlob = await viewResponse.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            if (result && result.startsWith('data:')) resolve(result);
            else reject(new Error('ComfyUI 视频转换失败'));
          };
          reader.onerror = () => reject(new Error('ComfyUI 视频读取失败'));
          reader.readAsDataURL(videoBlob);
        });
      }
    }

    throw new Error('ComfyUI 视频生成超时，请检查队列或工作流输出节点。');
  } catch (error) {
    console.error('[ComfyUI Video] Generation failed:', error);
    throw error;
  }
};

/**
 * 调用同步 chat/completions 视频 API
 */
const callSyncChatVideoApi = async (
  options: VideoGenerateOptions,
  model: VideoModelDefinition,
  apiKey: string,
  apiBase: string
): Promise<string> => {
  const modelName = model.apiModel || model.id;
  
  // 清理图片数据
  const cleanStart = options.startImage?.replace(/^data:image\/(png|jpeg|jpg);base64,/, '') || '';
  const cleanEnd = options.endImage?.replace(/^data:image\/(png|jpeg|jpg);base64,/, '') || '';

  // 构建消息
  const messages: any[] = [{ role: 'user', content: options.prompt }];

  if (cleanStart) {
    messages[0].content = [
      { type: 'text', text: options.prompt },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${cleanStart}` } },
    ];
  }

  if (cleanEnd && Array.isArray(messages[0].content)) {
    messages[0].content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${cleanEnd}` },
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200000); // 20 分钟

  try {
    const response = await retryOperation(async () => {
      const res = await fetch(resolveEndpointUrl(apiBase, model.endpoint || '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages,
          stream: false,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        if (res.status === 400) {
          throw new Error('提示词可能包含不安全或违规内容，未能处理。请修改后重试。');
        }
        if (res.status === 500) {
          throw new Error('当前请求较多，暂时未能处理成功，请稍后重试。');
        }
        
        let errorMessage = `HTTP 错误: ${res.status}`;
        try {
          const errorData = await res.json();
          errorMessage = errorData.error?.message || errorMessage;
        } catch (e) {
          const errorText = await res.text();
          if (errorText) errorMessage = errorText;
        }
        throw new Error(errorMessage);
      }

      return res;
    });

    clearTimeout(timeoutId);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // 提取视频 URL
    const urlMatch = content.match(/https?:\/\/[^\s\])"]+\.mp4[^\s\])"']*/i) ||
                    content.match(/https?:\/\/[^\s\])"]+/i);
    
    if (!urlMatch) {
      throw new Error('视频生成失败：未能从响应中提取视频 URL');
    }

    const videoUrl = urlMatch[0];

    // 下载并转换为 base64
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new Error(`视频下载失败: ${videoResponse.status}`);
    }

    const videoBlob = await videoResponse.blob();
    const reader = new FileReader();
    
    return new Promise((resolve, reject) => {
      reader.onloadend = () => {
        const result = reader.result as string;
        if (result && result.startsWith('data:')) {
          resolve(result);
        } else {
          reject(new Error('视频转换失败'));
        }
      };
      reader.onerror = () => reject(new Error('视频读取失败'));
      reader.readAsDataURL(videoBlob);
    });
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('视频生成超时 (20分钟)');
    }
    throw error;
  }
};

/**
 * 调用 Sora API（异步模式）
 */
const callSoraApi = async (
  options: VideoGenerateOptions,
  model: VideoModelDefinition,
  apiKey: string,
  apiBase: string
): Promise<string> => {
  const aspectRatio = options.aspectRatio || model.params.defaultAspectRatio;
  const duration = options.duration || model.params.defaultDuration;
  const apiModel = model.apiModel || model.id;
  const references = [options.startImage, options.endImage].filter(Boolean) as string[];
  const resolvedModel = apiModel || 'sora-2';
  const isSoraCompatibleModel = isSoraCompatibleVideoModel(resolvedModel);
  const useReferenceArray = resolvedModel.toLowerCase().startsWith('veo_3_1-fast');
  const videosUrl = resolveEndpointUrl(apiBase, model.endpoint || '/v1/videos');

  if (isSoraCompatibleModel && references.length >= 2) {
    console.warn('⚠️ Capability routing: sora-2 only supports start-frame reference. End-frame reference will be ignored.');
    references.splice(1);
  }

  if (isSoraCompatibleModel && references.length >= 2) {
    throw new Error('Sora-2 不支持首尾帧模式，请只传一张参考图。');
  }
  
  const { width, height, size } = getSizeFromAspectRatio(aspectRatio);

  console.log(`🎬 使用异步模式生成视频 (${resolvedModel}, ${aspectRatio}, ${duration}秒)...`);

  // 创建任务
  const formData = new FormData();
  formData.append('model', resolvedModel);
  formData.append('prompt', options.prompt);
  formData.append('seconds', String(duration));
  formData.append('size', size);

  const appendReference = async (base64: string, filename: string, fieldName: string) => {
    const cleanBase64 = base64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const resizedBase64 = await resizeImageToSize(cleanBase64, width, height);
    const byteCharacters = atob(resizedBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'image/png' });
    formData.append(fieldName, blob, filename);
  };

  // 添加参考图片（veo_3_1-fast 支持首尾帧数组；单图时使用 input_reference）
  if (useReferenceArray && references.length >= 2) {
    const limited = references.slice(0, 2);
    await appendReference(limited[0], 'reference-start.png', 'input_reference[]');
    await appendReference(limited[1], 'reference-end.png', 'input_reference[]');
  } else if (references.length >= 1) {
    await appendReference(references[0], 'reference.png', 'input_reference');
  }

  // 创建任务请求
  const createResponse = await fetch(videosUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!createResponse.ok) {
    if (createResponse.status === 400) {
      throw new Error('提示词可能包含不安全或违规内容，未能处理。请修改后重试。');
    }
    if (createResponse.status === 500) {
      throw new Error('当前请求较多，暂时未能处理成功，请稍后重试。');
    }
    
    let errorMessage = `创建任务失败: HTTP ${createResponse.status}`;
    try {
      const errorData = await createResponse.json();
      errorMessage = errorData.error?.message || errorMessage;
    } catch (e) {
      const errorText = await createResponse.text();
      if (errorText) errorMessage = errorText;
    }
    throw new Error(errorMessage);
  }

  const createData = await createResponse.json();
  const taskId = createData.id || createData.task_id;
  
  if (!taskId) {
    throw new Error('创建视频任务失败：未返回任务 ID');
  }

  console.log('📋 Sora-2 任务已创建，任务 ID:', taskId);

  // 轮询状态
  const maxPollingTime = 1200000; // 20 分钟
  const pollingInterval = 5000;
  const startTime = Date.now();
  
  let videoId: string | null = null;
  let videoUrlFromStatus: string | null = null;

  while (Date.now() - startTime < maxPollingTime) {
    await new Promise(resolve => setTimeout(resolve, pollingInterval));
    
    const statusResponse = await fetch(`${videosUrl}/${taskId}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!statusResponse.ok) {
      console.warn('⚠️ 查询任务状态失败，继续重试...');
      continue;
    }

    const statusData = await statusResponse.json();
    const status = statusData.status;

    console.log('🔄 Sora-2 任务状态:', status, '进度:', statusData.progress);

    if (status === 'completed' || status === 'succeeded') {
      videoUrlFromStatus = statusData.video_url || statusData.videoUrl || null;
      if (statusData.id && statusData.id.startsWith('video_')) {
        videoId = statusData.id;
      } else {
        videoId = statusData.output_video || statusData.video_id || statusData.outputs?.[0]?.id || statusData.id;
      }
      if (!videoId && statusData.outputs && statusData.outputs.length > 0) {
        videoId = statusData.outputs[0];
      }
      console.log('✅ 任务完成，视频 ID:', videoId);
      break;
    } else if (status === 'failed' || status === 'error') {
      throw new Error(`视频生成失败: ${statusData.error || statusData.message || '未知错误'}`);
    }
  }

  if (!videoId && !videoUrlFromStatus) {
    throw new Error('视频生成超时 (20分钟) 或未返回视频 ID');
  }

  if (videoUrlFromStatus) {
    const videoBase64 = await convertVideoUrlToBase64(videoUrlFromStatus);
    console.log('✅ 视频下载完成并转换为 base64');
    return videoBase64;
  }

  // 下载视频
  const maxDownloadRetries = 5;
  const downloadTimeout = 600000;

  for (let attempt = 1; attempt <= maxDownloadRetries; attempt++) {
    try {
      console.log(`📥 尝试下载视频 (第${attempt}/${maxDownloadRetries}次)...`);
      
      const downloadController = new AbortController();
      const downloadTimeoutId = setTimeout(() => downloadController.abort(), downloadTimeout);
      
      const downloadResponse = await fetch(`${videosUrl}/${videoId}/content`, {
        method: 'GET',
        headers: {
          'Accept': '*/*',
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: downloadController.signal,
      });
      
      clearTimeout(downloadTimeoutId);
      
      if (!downloadResponse.ok) {
        if (downloadResponse.status >= 500 && attempt < maxDownloadRetries) {
          console.warn(`⚠️ 下载失败 HTTP ${downloadResponse.status}，${5 * attempt}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          continue;
        }
        throw new Error(`视频下载失败: HTTP ${downloadResponse.status}`);
      }
      
      const videoBlob = await downloadResponse.blob();
      
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          if (result && result.startsWith('data:')) {
            console.log('✅ 视频下载完成并转换为 base64');
            resolve(result);
          } else {
            reject(new Error('视频转换失败'));
          }
        };
        reader.onerror = () => reject(new Error('视频读取失败'));
        reader.readAsDataURL(videoBlob);
      });
    } catch (error: any) {
      if (attempt === maxDownloadRetries) {
        throw error;
      }
      console.warn(`⚠️ 下载出错: ${error.message}，重试中...`);
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }

  throw new Error('视频下载失败：已达到最大重试次数');
};

/**
 * 调用视频生成 API
 */
export const callVideoApi = async (
  options: VideoGenerateOptions,
  model?: VideoModelDefinition
): Promise<string> => {
  // 获取当前激活的模型
  const activeModel = model || getActiveVideoModel();
  if (!activeModel) {
    throw new Error('没有可用的视频模型');
  }

  const apiBase = getApiBaseUrlForModel(activeModel.id);

  if (activeModel.params.mode === 'comfyui') {
    return callComfyVideoApi(options, activeModel, resolveComfyApiBaseUrl(apiBase, activeModel.endpoint));
  }

  // 获取 API 配置
  const apiKey = getApiKeyForModel(activeModel.id);
  if (!apiKey) {
    throw new ApiKeyError('API Key 缺失，请在设置中配置 API Key');
  }

  // 根据模式选择不同的 API
  if (activeModel.params.mode === 'async') {
    return callSoraApi(options, activeModel, apiKey, apiBase);
  } else {
    return callSyncChatVideoApi(options, activeModel, apiKey, apiBase);
  }
};

/**
 * 检查宽高比是否支持
 */
export const isAspectRatioSupported = (
  aspectRatio: AspectRatio,
  model?: VideoModelDefinition
): boolean => {
  const activeModel = model || getActiveVideoModel();
  if (!activeModel) return false;
  
  return activeModel.params.supportedAspectRatios.includes(aspectRatio);
};

/**
 * 检查时长是否支持
 */
export const isDurationSupported = (
  duration: VideoDuration,
  model?: VideoModelDefinition
): boolean => {
  const activeModel = model || getActiveVideoModel();
  if (!activeModel) return false;
  
  return activeModel.params.supportedDurations.includes(duration);
};
