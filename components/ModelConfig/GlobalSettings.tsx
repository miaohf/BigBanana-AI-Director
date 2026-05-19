/**
 * 全局配置组件
 * 包含 API Base URL 和 API Key 配置
 */

import React, { useState, useEffect } from 'react';
import { Key, Loader2, CheckCircle, AlertCircle, Link } from 'lucide-react';
import {
  getActiveChatModel,
  getDefaultProvider,
  getGlobalApiKey,
  setActiveChatModelByName,
  setDefaultProviderBaseUrl,
  setGlobalApiKey,
} from '../../services/modelRegistry';
import { verifyApiKey } from '../../services/modelService';
import { DEFAULT_CHAT_VERIFY_MODEL, normalizeChatModelId } from '../../services/modelIdUtils';

interface GlobalSettingsProps {
  onRefresh: () => void;
}

const normalizeApiBaseUrlInput = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

const GlobalSettings: React.FC<GlobalSettingsProps> = ({ onRefresh }) => {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [chatModelName, setChatModelName] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [verifyMessage, setVerifyMessage] = useState('');

  useEffect(() => {
    const currentKey = getGlobalApiKey() || '';
    const currentBaseUrl = getDefaultProvider().baseUrl || '';
    const currentChatModel = getActiveChatModel();
    setApiKey(currentKey);
    setBaseUrl(currentBaseUrl);
    setChatModelName(currentChatModel?.apiModel || currentChatModel?.id || DEFAULT_CHAT_VERIFY_MODEL);
    if (currentKey) {
      setVerifyStatus('success');
      setVerifyMessage('API Key 已配置');
    }
  }, []);

  const handleVerifyAndSave = async () => {
    if (!apiKey.trim()) {
      setVerifyStatus('error');
      setVerifyMessage('请输入 API Key');
      return;
    }

    const normalizedChatModelName = normalizeChatModelId(chatModelName)?.trim();
    if (!normalizedChatModelName) {
      setVerifyStatus('error');
      setVerifyMessage('请输入对话模型名称');
      return;
    }

    if (!baseUrl.trim()) {
      setVerifyStatus('error');
      setVerifyMessage('请输入 API Base URL');
      return;
    }

    let normalizedBaseUrl = '';
    try {
      normalizedBaseUrl = normalizeApiBaseUrlInput(baseUrl);
      const parsedUrl = new URL(normalizedBaseUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('unsupported protocol');
      }
    } catch {
      setVerifyStatus('error');
      setVerifyMessage('API Base URL 格式不正确');
      return;
    }

    setIsVerifying(true);
    setVerifyStatus('idle');
    setVerifyMessage('');

    try {
      const result = await verifyApiKey(apiKey.trim(), normalizedBaseUrl, normalizedChatModelName);
      
      if (result.success) {
        setVerifyStatus('success');
        setVerifyMessage('验证成功！配置已保存');
        setChatModelName(normalizedChatModelName);
        setBaseUrl(normalizedBaseUrl);
        setDefaultProviderBaseUrl(normalizedBaseUrl);
        setActiveChatModelByName(normalizedChatModelName);
        setGlobalApiKey(apiKey.trim());
        onRefresh();
      } else {
        setVerifyStatus('error');
        setVerifyMessage(result.message);
      }
    } catch (error: any) {
      setVerifyStatus('error');
      setVerifyMessage(error.message || '验证过程出错');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleClearKey = () => {
    setApiKey('');
    setVerifyStatus('idle');
    setVerifyMessage('');
    setGlobalApiKey('');
    onRefresh();
  };

  return (
    <div className="space-y-6">
      {/* API 配置 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Key className="w-4 h-4 text-[var(--accent-text)]" />
          <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
            全局 API 配置
          </label>
        </div>
        
        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Link className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
                API Base URL
              </label>
            </div>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setVerifyStatus('idle');
                setVerifyMessage('');
              }}
              placeholder="https://api.example.com"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] px-4 py-3 text-sm rounded-lg focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-hover)] transition-all font-mono placeholder:text-[var(--text-muted)]"
              disabled={isVerifying}
            />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Key className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
                对话模型名称
              </label>
            </div>
            <input
              type="text"
              value={chatModelName}
              onChange={(e) => {
                setChatModelName(e.target.value);
                setVerifyStatus('idle');
                setVerifyMessage('');
              }}
              placeholder="例如 gpt-5.4"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] px-4 py-3 text-sm rounded-lg focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-hover)] transition-all font-mono placeholder:text-[var(--text-muted)]"
              disabled={isVerifying}
            />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Key className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
                API Key
              </label>
            </div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setVerifyStatus('idle');
                setVerifyMessage('');
              }}
              placeholder="输入你的 API Key..."
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] px-4 py-3 text-sm rounded-lg focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-hover)] transition-all font-mono placeholder:text-[var(--text-muted)]"
              disabled={isVerifying}
            />
          </div>
          
          {/* 状态提示 */}
          {verifyMessage && (
            <div className={`flex items-center gap-2 text-xs ${
              verifyStatus === 'success' ? 'text-[var(--success-text)]' : 'text-[var(--error-text)]'
            }`}>
              {verifyStatus === 'success' ? (
                <CheckCircle className="w-3.5 h-3.5" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5" />
              )}
              {verifyMessage}
            </div>
          )}

          {/* 说明文字 */}
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            对话模型名称会作为剧本、分镜和提示词等文本生成任务的默认模型。
          </p>

          {/* 操作按钮 */}
          <div className="flex gap-3">
            {getGlobalApiKey() && (
              <button
                onClick={handleClearKey}
                className="flex-1 py-3 bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-xs font-bold uppercase tracking-wider transition-colors rounded-lg border border-[var(--border-primary)]"
              >
                清除 Key
              </button>
            )}
            <button
              onClick={handleVerifyAndSave}
              disabled={isVerifying || !apiKey.trim() || !baseUrl.trim() || !chatModelName.trim()}
              className="flex-1 py-3 bg-[var(--accent)] text-[var(--text-primary)] font-bold text-xs uppercase tracking-wider rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  验证中...
                </>
              ) : (
                '验证并保存'
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 提示 */}
      <div className="p-4 bg-[var(--bg-elevated)]/50 rounded-lg border border-[var(--border-primary)]">
        <h4 className="text-xs font-bold text-[var(--text-tertiary)] mb-2">配置说明</h4>
        <ul className="text-[10px] text-[var(--text-muted)] space-y-1 list-disc list-inside">
          <li>全局 API Base URL 会作为默认内置模型的请求地址</li>
          <li>对话模型名称会同步为当前激活的文本模型；列表中不存在时会自动添加</li>
          <li>全局 API Key 用于默认内置模型的调用</li>
          <li>你可以在各模型类别中调整模型参数（温度、Token 等）</li>
          <li>支持添加自定义模型，使用其他 API 服务</li>
          <li>所有配置仅保存在本地浏览器，不会上传到服务器</li>
        </ul>
      </div>
    </div>
  );
};

export default GlobalSettings;
