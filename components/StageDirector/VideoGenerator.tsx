import React, { useState, useEffect } from 'react';
import { Video, Loader2, Edit2 } from 'lucide-react';
import { Shot, AspectRatio, VideoDuration } from '../../types';
import { VideoSettingsPanel } from '../AspectRatioSelector';
import { resolveVideoModelRouting } from './utils';
import {
  getDefaultAspectRatio,
  getDefaultVideoDuration,
  getVideoModels,
  getActiveVideoModel,
  getProviderById,
} from '../../services/modelRegistry';
import { VideoModelDefinition } from '../../types/model';
import { useResolvedVideoUrl } from '../../hooks/useResolvedVideoUrl';

interface VideoGeneratorProps {
  shot: Shot;
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  onGenerate: (aspectRatio: AspectRatio, duration: VideoDuration, modelId: string) => void;
  onEditPrompt: () => void;
  onModelChange?: (modelId: string) => void;
}

const VideoGenerator: React.FC<VideoGeneratorProps> = ({
  shot,
  hasStartFrame,
  hasEndFrame,
  onGenerate,
  onEditPrompt,
  onModelChange,
}) => {
  const normalizeModelId = (modelId?: string) => {
    if (!modelId) return modelId;
    const normalized = modelId.toLowerCase();
    if (normalized === 'veo_3_1-fast-4k') return 'veo_3_1-fast';
    if (
      normalized === 'veo' ||
      normalized === 'veo-r2v' ||
      normalized === 'veo_3_1' ||
      normalized.startsWith('veo_3_0_r2v')
    ) {
      return 'veo_3_1-fast';
    }
    return modelId;
  };

  const resolveVeoFastQuality = (modelId?: string): 'standard' | '4k' => {
    if (!modelId) return 'standard';
    return modelId.toLowerCase() === 'veo_3_1-fast-4k' ? '4k' : 'standard';
  };

  const videoModels = getVideoModels().filter((m) => m.isEnabled);
  const activeVideoModel = getActiveVideoModel();

  const resolveInitialModelId = (): string => {
    if (activeVideoModel?.id && videoModels.some((m) => m.id === activeVideoModel.id)) {
      return activeVideoModel.id;
    }
    const perShot = normalizeModelId(shot.videoModel);
    if (perShot && videoModels.some((m) => m.id === perShot)) return perShot;
    return videoModels[0]?.id || 'sora-2';
  };

  const [selectedModelId, setSelectedModelId] = useState<string>(resolveInitialModelId);
  const [veoFastQuality, setVeoFastQuality] = useState<'standard' | '4k'>(
    resolveVeoFastQuality(shot.videoModel)
  );
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(() => getDefaultAspectRatio());
  const [duration, setDuration] = useState<VideoDuration>(() => getDefaultVideoDuration());

  const selectedModel = videoModels.find((m) => m.id === selectedModelId) as VideoModelDefinition | undefined;
  const selectedProvider = selectedModel ? getProviderById(selectedModel.providerId) : undefined;
  const requiresDedicatedApiKey = selectedModel?.providerId === 'volcengine';
  const hasDedicatedApiKey = Boolean(
    (selectedModel?.apiKey && selectedModel.apiKey.trim()) ||
      (selectedProvider?.apiKey && selectedProvider.apiKey.trim())
  );
  const isMissingVolcengineApiKey = Boolean(requiresDedicatedApiKey && !hasDedicatedApiKey);
  const modelType: 'sora' | 'veo' = selectedModel?.params.mode === 'async' ? 'sora' : 'veo';
  const effectiveModelId =
    selectedModelId === 'veo_3_1-fast'
      ? veoFastQuality === '4k'
        ? 'veo_3_1-fast-4K'
        : 'veo_3_1-fast'
      : selectedModelId;
  const modelRouting = resolveVideoModelRouting(effectiveModelId || selectedModelId || 'sora-2');
  const routingLabel =
    modelRouting.family === 'sora'
      ? 'Sora'
      : modelRouting.family === 'doubao-task'
        ? 'Doubao Task'
        : modelRouting.family === 'veo-fast'
          ? 'Veo Fast'
          : modelRouting.family === 'comfyui-ltx'
            ? 'ComfyUI LTX'
            : 'Unknown';

  const getRecommendedModeLabel = (modelId: string): string => {
    const routing = resolveVideoModelRouting(modelId);
    if (routing.family === 'sora' || routing.family === 'doubao-task') {
      return '推荐网格分镜';
    }
    if (routing.family === 'veo-fast') {
      return '网格/首尾帧';
    }
    return '按镜头选择';
  };

  const isGenerating = shot.interval?.status === 'generating';
  const hasVideo = !!shot.interval?.videoUrl;
  const resolvedVideoSrc = useResolvedVideoUrl(shot.interval?.videoUrl);

  useEffect(() => {
    if (!selectedModel) return;

    if (!selectedModel.params.supportedAspectRatios.includes(aspectRatio)) {
      setAspectRatio(selectedModel.params.defaultAspectRatio);
    }
    if (!selectedModel.params.supportedDurations.includes(duration)) {
      setDuration(selectedModel.params.defaultDuration);
    }
  }, [selectedModelId]);

  useEffect(() => {
    if (activeVideoModel?.id && videoModels.some((m) => m.id === activeVideoModel.id)) {
      setSelectedModelId(activeVideoModel.id);
      onModelChange?.(activeVideoModel.id);
      return;
    }
    const perShot = normalizeModelId(shot.videoModel);
    if (perShot && videoModels.some((m) => m.id === perShot)) {
      setSelectedModelId(perShot);
      setVeoFastQuality(resolveVeoFastQuality(shot.videoModel));
    }
  }, [shot.id, shot.videoModel, activeVideoModel?.id, videoModels.map((m) => m.id).join('|')]);

  const handleGenerate = () => {
    onGenerate(aspectRatio, duration, effectiveModelId);
  };

  const handleVeoFastQualityChange = (quality: 'standard' | '4k') => {
    setVeoFastQuality(quality);
    if (selectedModelId === 'veo_3_1-fast') {
      const modelId = quality === '4k' ? 'veo_3_1-fast-4K' : 'veo_3_1-fast';
      onModelChange?.(modelId);
    }
  };

  const canGenerate = hasStartFrame && !isMissingVolcengineApiKey;

  return (
    <div className="bg-[var(--bg-surface)] rounded-xl p-5 border border-[var(--border-primary)] space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-[var(--text-primary)] uppercase tracking-widest flex items-center gap-2">
          <Video className="w-3 h-3 text-[var(--accent)]" />
          视频生成
          <button
            onClick={onEditPrompt}
            className="p-1 text-[var(--warning-text)] hover:text-[var(--text-primary)] transition-colors"
            title="预览/编辑视频提示词"
          >
            <Edit2 className="w-3 h-3" />
          </button>
        </h4>
        {shot.interval?.status === 'completed' && (
          <span className="text-[10px] text-[var(--success)] font-mono flex items-center gap-1">● READY</span>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest block">
          选择视频模型
        </label>
        <select
          value={selectedModelId}
          onChange={(e) => {
            const newModelId = e.target.value;
            setSelectedModelId(newModelId);
            const resolvedModelId =
              newModelId === 'veo_3_1-fast'
                ? veoFastQuality === '4k'
                  ? 'veo_3_1-fast-4K'
                  : 'veo_3_1-fast'
                : newModelId;
            onModelChange?.(resolvedModelId);
          }}
          className="w-full bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-secondary)] rounded-lg px-3 py-2 text-xs outline-none focus:border-[var(--accent)] transition-colors"
          disabled={isGenerating}
        >
          {videoModels.map((model) => {
            const vm = model as VideoModelDefinition;
            const modeLabel = vm.params.mode === 'comfyui'
              ? 'ComfyUI'
              : vm.params.mode === 'async'
                ? '异步'
                : '同步';
            const recommendationLabel = getRecommendedModeLabel(model.id);
            return (
              <option key={model.id} value={model.id}>
                {model.name}（{modeLabel} · {recommendationLabel}）
              </option>
            );
          })}
        </select>
        {selectedModel && (
          <p className="text-[9px] text-[var(--text-muted)] font-mono">
            ✦ {selectedModel.name}:
            {selectedModel.params.mode === 'comfyui'
              ? ` ComfyUI 工作流，支持 ${selectedModel.params.supportedAspectRatios.join('/')}，可选 ${selectedModel.params.supportedDurations.join('/')}秒${
                  selectedModel.params.supportsEndFrame ? '，支持首尾帧' : ''
                }${
                  selectedModel.params.supportsAudio ? '，可注入镜头配音' : ''
                }`
              : selectedModel.params.mode === 'async'
              ? ` 支持 ${selectedModel.params.supportedAspectRatios.join('/')}，可选 ${selectedModel.params.supportedDurations.join('/')}秒`
              : ` 同步模式，支持 ${selectedModel.params.supportedAspectRatios.join('/')}`}
            {` ｜${getRecommendedModeLabel(effectiveModelId || selectedModel.id)}`}
          </p>
        )}
        {isMissingVolcengineApiKey && (
          <div className="rounded-lg border border-[var(--error-border)] bg-[var(--error-bg)] px-3 py-2">
            <p className="text-[10px] text-[var(--error-text)] font-bold">当前模型需要火山引擎专用 API Key</p>
            <p className="text-[9px] text-[var(--error-text)]/90 mt-1">
              未检测到该模型或 Volcengine 提供商的 Key。此模型不会使用 AntSK 全局 Key，请先到模型配置里设置后再生成。
            </p>
          </div>
        )}
        <div className="bg-[var(--bg-base)] border border-[var(--border-secondary)] rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-tertiary)]">模型能力卡</span>
            <span className="text-[10px] font-mono text-[var(--text-secondary)]">{routingLabel}</span>
          </div>
          {[
            { key: 'start-only', label: '首帧支持', enabled: modelRouting.supportsStartFrame },
            {
              key: 'start-end',
              label: '首尾帧支持',
              enabled: modelRouting.supportsStartFrame && modelRouting.supportsEndFrame,
            },
            {
              key: 'nine-grid-priority',
              label: '九宫格优先',
              enabled: modelRouting.prefersNineGridStoryboard,
            },
          ].map((capability) => (
            <div key={capability.key} className="flex items-center justify-between text-[10px]">
              <span className="text-[var(--text-secondary)]">{capability.label}</span>
              <span
                className={`px-2 py-0.5 rounded border font-mono ${
                  capability.enabled
                    ? 'text-[var(--success)] border-[var(--success)]/40 bg-[var(--success)]/10'
                    : 'text-[var(--text-muted)] border-[var(--border-primary)] bg-[var(--bg-hover)]'
                }`}
              >
                {capability.enabled ? 'ON' : 'OFF'}
              </span>
            </div>
          ))}
          {hasEndFrame && !modelRouting.supportsEndFrame && (
            <p className="text-[9px] text-[var(--warning-text)] font-mono">
              当前模型会自动忽略尾帧输入，仅使用首帧驱动。
            </p>
          )}
        </div>
        {selectedModelId === 'veo_3_1-fast' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-tertiary)] uppercase">清晰度</span>
            <div className="flex gap-1">
              <button
                onClick={() => handleVeoFastQualityChange('standard')}
                disabled={isGenerating}
                className={`
                  px-3 py-1.5 rounded-md text-xs transition-all
                  ${
                    veoFastQuality === 'standard'
                      ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                      : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:bg-[var(--border-secondary)] hover:text-[var(--text-secondary)]'
                  }
                  ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                标准
              </button>
              <button
                onClick={() => handleVeoFastQualityChange('4k')}
                disabled={isGenerating}
                className={`
                  px-3 py-1.5 rounded-md text-xs transition-all
                  ${
                    veoFastQuality === '4k'
                      ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                      : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:bg-[var(--border-secondary)] hover:text-[var(--text-secondary)]'
                  }
                  ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                4K
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest block">视频设置</label>
        <VideoSettingsPanel
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          duration={duration}
          onDurationChange={setDuration}
          modelType={modelType}
          disabled={isGenerating}
          supportedAspectRatios={selectedModel?.params.supportedAspectRatios}
          supportedDurations={selectedModel?.params.supportedDurations}
        />
      </div>

      {hasVideo ? (
        <div className="w-full aspect-video bg-[var(--bg-base)] rounded-lg overflow-hidden border border-[var(--border-secondary)] relative shadow-lg">
          <video src={resolvedVideoSrc} controls className="w-full h-full" />
        </div>
      ) : (
        <div className="w-full aspect-video bg-[var(--nav-hover-bg)] rounded-lg border border-dashed border-[var(--border-primary)] flex items-center justify-center">
          <span className="text-xs text-[var(--text-muted)] font-mono">PREVIEW AREA</span>
        </div>
      )}

      <button
        onClick={handleGenerate}
        disabled={!canGenerate || isGenerating}
        className={`w-full py-3 rounded-lg font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${
          hasVideo
            ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:bg-[var(--border-secondary)]'
            : 'bg-[var(--accent)] text-[var(--text-primary)] hover:bg-[var(--accent-hover)] shadow-lg shadow-[var(--accent-shadow)]'
        } ${!canGenerate ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {isGenerating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            {`生成视频中 (${aspectRatio}, ${modelType === 'sora' ? `${duration}秒` : selectedModel?.name})...`}
          </>
        ) : (
          <>{hasVideo ? '重新生成视频' : '开始生成视频'}</>
        )}
      </button>
      {isMissingVolcengineApiKey && (
        <div className="text-[9px] text-[var(--error-text)] text-center font-mono">
          * 请选择并配置火山引擎 API Key（模型 Key 或 Volcengine 提供商 Key）
        </div>
      )}

      {!hasEndFrame && (
        <div className="text-[9px] text-[var(--text-tertiary)] text-center font-mono">
          * 未检测到结束帧，将使用单图生成模式 (Image-to-Video)
        </div>
      )}
    </div>
  );
};

export default VideoGenerator;
