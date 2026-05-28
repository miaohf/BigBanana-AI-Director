import React, { useRef } from 'react';
import { BookOpen, Wand2, BrainCircuit, AlertCircle, ChevronRight, ImagePlus } from 'lucide-react';
import OptionSelector from './OptionSelector';
import { DURATION_OPTIONS, LANGUAGE_OPTIONS, VISUAL_STYLE_OPTIONS, STYLES } from './constants';
import ModelSelector from '../ModelSelector';
import { getChatModelApiName } from '../../services/modelRegistry';
import { parseDurationToSeconds } from '../../services/durationParser';

interface Props {
  title: string;
  duration: string;
  language: string;
  model: string;
  visualStyle: string;
  customDurationInput: string;
  customModelInput: string;
  customStyleInput: string;
  isProcessing: boolean;
  isInferringVisualStyle?: boolean;
  error: string | null;
  onShowModelConfig?: () => void;
  onTitleChange: (value: string) => void;
  onDurationChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onVisualStyleChange: (value: string) => void;
  onCustomDurationChange: (value: string) => void;
  onCustomModelChange: (value: string) => void;
  onCustomStyleChange: (value: string) => void;
  onInferVisualStyleByImage?: (file: File) => void;
  enableQualityCheck: boolean;
  onToggleQualityCheck: (value: boolean) => void;
  onAnalyze: () => void;
  analyzeButtonLabel?: string;
  canCancelAnalyze?: boolean;
  onCancelAnalyze?: () => void;
}

const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);

  return parts.join(' ');
};

const ConfigPanel: React.FC<Props> = ({
  title,
  duration,
  language,
  model,
  visualStyle,
  customDurationInput,
  customModelInput,
  customStyleInput,
  isProcessing,
  isInferringVisualStyle = false,
  error,
  onShowModelConfig,
  onTitleChange,
  onDurationChange,
  onLanguageChange,
  onModelChange,
  onVisualStyleChange,
  onCustomDurationChange,
  onCustomModelChange,
  onCustomStyleChange,
  onInferVisualStyleByImage,
  enableQualityCheck,
  onToggleQualityCheck,
  onAnalyze,
  analyzeButtonLabel,
  canCancelAnalyze,
  onCancelAnalyze
}) => {
  const rawDurationValue = duration === 'custom' ? customDurationInput : duration;
  const parsedDurationSeconds = parseDurationToSeconds(rawDurationValue);
  const hasDurationInput = rawDurationValue.trim().length > 0;
  const styleImageInputRef = useRef<HTMLInputElement | null>(null);
  const canInferStyle = !!onInferVisualStyleByImage && !isProcessing && !isInferringVisualStyle;

  const handleTriggerStyleUpload = () => {
    styleImageInputRef.current?.click();
  };

  const handleStyleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && onInferVisualStyleByImage) {
      onInferVisualStyleByImage(file);
    }
    // allow selecting the same file again
    event.target.value = '';
  };

  return (
    <div className="w-96 border-r border-[var(--border-primary)] flex flex-col bg-[var(--bg-primary)]">
      <div className="h-14 px-5 border-b border-[var(--border-primary)] flex items-center justify-between shrink-0">
        <h2 className="text-sm font-bold text-[var(--text-primary)] tracking-wide flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-[var(--text-tertiary)]" />
          项目配置
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        <div className="space-y-2">
          <label className={STYLES.label}>项目标题</label>
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            className={STYLES.input}
            placeholder="输入项目名称..."
          />
        </div>

        <div className="space-y-2">
          <label className={STYLES.label}>输出语言</label>
          <div className="relative">
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              className={STYLES.select}
            >
              {LANGUAGE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <div className="absolute right-3 top-3 pointer-events-none">
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)] rotate-90" />
            </div>
          </div>
        </div>

        <OptionSelector
          label="目标时长"
          options={DURATION_OPTIONS}
          value={duration}
          onChange={onDurationChange}
          customInput={customDurationInput}
          onCustomInputChange={onCustomDurationChange}
          customPlaceholder="输入时长（如 90s、3m）"
          gridCols={2}
        />

        <div className="mt-2 text-[10px] leading-relaxed">
          {parsedDurationSeconds !== null ? (
            <p className="text-[var(--text-tertiary)]">
              当前将按 <span className="font-mono text-[var(--text-secondary)]">{parsedDurationSeconds}s</span>
              （{formatDuration(parsedDurationSeconds)}）规划分镜。
            </p>
          ) : hasDurationInput ? (
            <p className="text-[var(--error)]">
              时长格式无效。支持示例：90s、3m、3min、2m30s、2:30。
            </p>
          ) : (
            <p className="text-[var(--text-muted)]">支持格式：90s、3m、3min、2m30s、2:30。</p>
          )}
        </div>

        <div className="space-y-2">
          <ModelSelector
            type="chat"
            value={model}
            onChange={onModelChange}
            disabled={isProcessing}
            label="分镜生成模型"
          />
          <p className="text-[9px] text-[var(--text-muted)]">
            仅作用于当前项目，与「模型配置 → 对话模型」中的「当前使用」相互独立。当前 API 模型：
            <span className="font-mono text-[var(--text-secondary)] ml-1">{getChatModelApiName(model) || '未配置'}</span>
            。在
            <button
              type="button"
              onClick={onShowModelConfig}
              className="mx-1 text-[var(--accent-text)] hover:text-[var(--accent-text-hover)] underline underline-offset-2 transition-colors"
            >
              模型配置
            </button>
            中可添加更多模型。
          </p>
        </div>

        <OptionSelector
          label="视觉风格"
          icon={<Wand2 className="w-3 h-3" />}
          options={VISUAL_STYLE_OPTIONS}
          value={visualStyle}
          onChange={onVisualStyleChange}
          customInput={customStyleInput}
          onCustomInputChange={onCustomStyleChange}
          customPlaceholder="输入风格（如 水彩、像素、写实）"
          gridCols={2}
        />

        {onInferVisualStyleByImage && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleTriggerStyleUpload}
              disabled={!canInferStyle}
              className={`w-full rounded-md border px-3 py-2 text-xs font-semibold transition-colors flex items-center justify-center gap-2 ${
                canInferStyle
                  ? 'border-[var(--border-secondary)] text-[var(--text-secondary)] hover:border-[var(--accent-border)] hover:text-[var(--text-primary)]'
                  : STYLES.button.disabled
              }`}
            >
              <ImagePlus className={`w-3.5 h-3.5 ${isInferringVisualStyle ? 'animate-pulse' : ''}`} />
              {isInferringVisualStyle ? '正在反推风格...' : '上传图片反推风格'}
            </button>
            <input
              ref={styleImageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleStyleImageChange}
            />
            <p className="text-[10px] text-[var(--text-muted)]">上传你喜欢的风格图片，自动反推风格提示词</p>
          </div>
        )}

        <div className="space-y-2">
          <label className={STYLES.label}>质量控制</label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)]/40 px-3 py-2">
            <input
              type="checkbox"
              checked={enableQualityCheck}
              onChange={(e) => onToggleQualityCheck(e.target.checked)}
              disabled={isProcessing}
              className="mt-0.5 h-4 w-4 rounded border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--accent-text)]"
            />
            <span className="text-xs text-[var(--text-secondary)]">
              启用分镜质量校验与自动修复（推荐）
            </span>
          </label>
          <p className="text-[10px] text-[var(--text-muted)]">
            开启后会在分镜生成完成时自动打分并修复坏点（字段缺失、关键帧结构问题、资产ID非法等）。
          </p>
        </div>
      </div>

      <div className="p-6 border-t border-[var(--border-primary)] bg-[var(--bg-primary)]">
        <button
          onClick={onAnalyze}
          disabled={isProcessing}
          className={`w-full py-3.5 font-bold text-xs tracking-widest uppercase rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg ${
            isProcessing
              ? STYLES.button.disabled
              : STYLES.button.primary
          }`}
        >
          {isProcessing ? (
            <>
              <BrainCircuit className="w-4 h-4 animate-spin" />
              智能分析中...
            </>
          ) : (
            <>
              <Wand2 className="w-4 h-4" />
              {analyzeButtonLabel || '生成分镜脚本'}
            </>
          )}
        </button>

        {isProcessing && canCancelAnalyze && onCancelAnalyze && (
          <button
            type="button"
            onClick={onCancelAnalyze}
            className={`mt-2 w-full rounded-lg border px-3 py-2 text-xs font-semibold tracking-wide transition-colors ${STYLES.button.secondary}`}
          >
            取消生成
          </button>
        )}

        {error && (
          <div className="mt-4 p-3 bg-[var(--error-bg)] border border-[var(--error-border)] text-[var(--error)] text-xs rounded flex items-center gap-2">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default ConfigPanel;
