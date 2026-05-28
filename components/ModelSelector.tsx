/**
 * 模型选择器组件
 * 用于在各功能模块中选择要使用的模型
 */

import React from 'react';
import { Cpu, ChevronDown } from 'lucide-react';
import { 
  ModelType, 
  ModelDefinition,
  ChatModelDefinition,
  ImageModelDefinition,
  VideoModelDefinition,
  AudioModelDefinition,
} from '../types/model';
import {
  getChatModels,
  getImageModels,
  getVideoModels,
  getAudioModels,
  getActiveChatModel,
} from '../services/modelRegistry';

interface ModelSelectorProps {
  type: ModelType;
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
}

const typeLabels: Record<ModelType, string> = {
  chat: '对话模型',
  image: '图片模型',
  video: '视频模型',
  audio: '配音模型',
};

const ModelSelector: React.FC<ModelSelectorProps> = ({
  type,
  value,
  onChange,
  disabled = false,
  compact = false,
  label,
}) => {
  // 获取对应类型的模型列表（仅启用的模型）
  const getModels = (): ModelDefinition[] => {
    let models: ModelDefinition[] = [];
    switch (type) {
      case 'chat':
        models = getChatModels();
        break;
      case 'image':
        models = getImageModels();
        break;
      case 'video':
        models = getVideoModels();
        break;
      case 'audio':
        models = getAudioModels();
        break;
    }
    return models.filter(m => m.isEnabled);
  };

  const models = getModels();
  const resolvedValue = models.some(m => m.id === value)
    ? value
    : (
      models.find(m => (m.apiModel || m.id) === value)?.id
      || (value ? value : (type === 'chat' ? getActiveChatModel()?.id : undefined))
      || models[0]?.id
      || value
    );
  const selectedModel = models.find(m => m.id === resolvedValue);

  if (compact) {
    return (
      <div className="relative">
        <select
          value={resolvedValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="appearance-none bg-[var(--bg-hover)] border border-[var(--border-secondary)] text-[var(--text-primary)] text-xs rounded px-3 py-1.5 pr-7 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-tertiary)] pointer-events-none" />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {label && (
        <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest flex items-center gap-1">
          <Cpu className="w-3 h-3" />
          {label}
        </label>
      )}
      <div className="relative">
        <select
          value={resolvedValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full appearance-none bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] text-xs rounded-lg px-3 py-2.5 pr-8 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} {model.description ? `- ${model.description}` : ''}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" />
      </div>
      {selectedModel && !compact && (
        <p className="text-[9px] text-[var(--text-muted)]">
          ID: {selectedModel.id}
        </p>
      )}
    </div>
  );
};

export default ModelSelector;

/**
 * 视频模型选择器（带 Sora/Veo 模式显示）
 */
export const VideoModelSelector: React.FC<{
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const models = getVideoModels().filter(m => m.isEnabled);
  const selectedModel = models.find(m => m.id === value) as VideoModelDefinition | undefined;
  
  return (
    <div className="space-y-1">
      <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
        视频模型
      </label>
      <div className="relative">
        <select
          value={resolvedValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full appearance-none bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] text-xs rounded-lg px-3 py-2.5 pr-8 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {models.map((model) => {
            const videoModel = model as VideoModelDefinition;
            const modeLabel = videoModel.params.mode === 'comfyui'
              ? 'ComfyUI'
              : videoModel.params.mode === 'async'
                ? '异步'
                : '同步';
            return (
              <option key={model.id} value={model.id}>
                {model.name} ({modeLabel})
              </option>
            );
          })}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" />
      </div>
      {selectedModel && (
        <p className="text-[9px] text-[var(--text-muted)]">
          模式: {
            selectedModel.params.mode === 'comfyui'
              ? 'ComfyUI Workflow'
              : selectedModel.params.mode === 'async'
                ? '异步（需要轮询）'
                : '同步（直接返回）'
          }
          {selectedModel.params.supportedDurations.length > 1 && 
            ` · 支持时长: ${selectedModel.params.supportedDurations.join('/')}秒`
          }
        </p>
      )}
    </div>
  );
};

/**
 * 配音模型选择器
 */
export const AudioModelSelector: React.FC<{
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const models = getAudioModels().filter(m => m.isEnabled);
  const selectedModel = models.find(m => m.id === value) as AudioModelDefinition | undefined;

  return (
    <div className="space-y-1">
      <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
        配音模型
      </label>
      <div className="relative">
        <select
          value={resolvedValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full appearance-none bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] text-xs rounded-lg px-3 py-2.5 pr-8 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" />
      </div>
      {selectedModel && (
        <p className="text-[9px] text-[var(--text-muted)]">
          默认音色: {selectedModel.params.defaultVoice} · 输出格式: {selectedModel.params.outputFormat}
        </p>
      )}
    </div>
  );
};
