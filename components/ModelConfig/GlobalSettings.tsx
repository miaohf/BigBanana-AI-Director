/**
 * 全局配置组件
 * 包含默认 API Base URL、API Key 与验证用模型名称
 */

import React, { useState, useEffect } from 'react';
import { Key, Loader2, CheckCircle, AlertCircle, Link } from 'lucide-react';
import {
  getDefaultProvider,
  getGlobalApiKey,
  getGlobalVerifyChatModelName,
  setDefaultProviderBaseUrl,
  setGlobalApiKey,
  setGlobalVerifyChatModelName,
} from '../../services/modelRegistry';
import { verifyApiKey } from '../../services/modelService';
import { normalizeChatModelId, DEFAULT_CHAT_VERIFY_MODEL } from '../../services/modelIdUtils';
import { validateRemoteApiBaseUrl } from '../../services/urlUtils';

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

const DEFAULT_GLOBAL_BASE_URL = 'http://api.example.com';
const DEFAULT_GLOBAL_MODEL_NAME = 'model_name';
const DEFAULT_GLOBAL_API_KEY = 'sk-xxxxxxxxxxxxxxxxxxx';
const BUILTIN_DEFAULT_BASE_URL = 'https://api.antsk.cn';

const GlobalSettings: React.FC<GlobalSettingsProps> = ({ onRefresh }) => {
  const [apiKey, setApiKey] = useState(DEFAULT_GLOBAL_API_KEY);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_GLOBAL_BASE_URL);
  const [verifyModelName, setVerifyModelName] = useState(DEFAULT_GLOBAL_MODEL_NAME);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [verifyMessage, setVerifyMessage] = useState('');

  useEffect(() => {
    const currentKey = getGlobalApiKey() || '';
    const currentBaseUrl = getDefaultProvider().baseUrl || '';
    const savedVerifyModel = getGlobalVerifyChatModelName();
    const displayVerifyModel =
      savedVerifyModel && savedVerifyModel !== DEFAULT_CHAT_VERIFY_MODEL
        ? savedVerifyModel
        : DEFAULT_GLOBAL_MODEL_NAME;

    if (currentKey) {
      setApiKey(currentKey);
      setBaseUrl(currentBaseUrl || DEFAULT_GLOBAL_BASE_URL);
      setVerifyModelName(savedVerifyModel || DEFAULT_GLOBAL_MODEL_NAME);
      setVerifyStatus('success');
      setVerifyMessage('API Key 已配置');
      return;
    }

    setApiKey(DEFAULT_GLOBAL_API_KEY);
    setBaseUrl(
      currentBaseUrl && currentBaseUrl !== BUILTIN_DEFAULT_BASE_URL
        ? currentBaseUrl
        : DEFAULT_GLOBAL_BASE_URL
    );
    setVerifyModelName(displayVerifyModel);
  }, []);

  const handleVerifyAndSave = async () => {
    if (!apiKey.trim()) {
      setVerifyStatus('error');
      setVerifyMessage('请输入 API Key');
      return;
    }

    const normalizedVerifyModelName = normalizeChatModelId(verifyModelName)?.trim();
    if (!normalizedVerifyModelName) {
      setVerifyStatus('error');
      setVerifyMessage('请输入验证用模型名称');
      return;
    }

    if (!baseUrl.trim()) {
      setVerifyStatus('error');
      setVerifyMessage('请输入全局 API Base URL');
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

    const baseUrlError = validateRemoteApiBaseUrl(normalizedBaseUrl);
    if (baseUrlError) {
      setVerifyStatus('error');
      setVerifyMessage(baseUrlError);
      return;
    }

    setIsVerifying(true);
    setVerifyStatus('idle');
    setVerifyMessage('');

    try {
      const savedBaseUrl = setDefaultProviderBaseUrl(normalizedBaseUrl);
      if (!savedBaseUrl) {
        setVerifyStatus('error');
        setVerifyMessage(validateRemoteApiBaseUrl(normalizedBaseUrl) || 'API Base URL 无法保存');
        return;
      }

      const result = await verifyApiKey(
        apiKey.trim(),
        savedBaseUrl,
        normalizedVerifyModelName
      );

      if (result.success) {
        setVerifyStatus('success');
        setVerifyMessage('验证成功！配置已保存');
        setVerifyModelName(normalizedVerifyModelName);
        setBaseUrl(normalizedBaseUrl);
        setGlobalVerifyChatModelName(normalizedVerifyModelName);
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
    setApiKey(DEFAULT_GLOBAL_API_KEY);
    setBaseUrl(DEFAULT_GLOBAL_BASE_URL);
    setVerifyModelName(DEFAULT_GLOBAL_MODEL_NAME);
    setVerifyStatus('idle');
    setVerifyMessage('');
    setGlobalApiKey('');
    setGlobalVerifyChatModelName('');
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Link className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
                全局 API Base URL
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
              placeholder="http://api.example.com"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] px-4 py-3 text-sm rounded-lg focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-hover)] transition-all font-mono placeholder:text-[var(--text-muted)]"
              disabled={isVerifying}
            />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Key className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <label className="text-[10px] font-bold text-[var(--text-tertiary)] uppercase tracking-widest">
                验证用模型名称
              </label>
            </div>
            <input
              type="text"
              value={verifyModelName}
              onChange={(e) => {
                setVerifyModelName(e.target.value);
                setVerifyStatus('idle');
                setVerifyMessage('');
              }}
              placeholder="model_name"
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
              placeholder="sk-xxxxxxxxxxxxxxxxxxx"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-primary)] text-[var(--text-primary)] px-4 py-3 text-sm rounded-lg focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-hover)] transition-all font-mono placeholder:text-[var(--text-muted)]"
              disabled={isVerifying}
            />
          </div>

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

          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            全局 Base URL 为<strong className="font-normal text-[var(--text-tertiary)]">默认远程 API 地址</strong>（LLM / 云端图片 / 云端视频等）。
            各模型卡片中可单独填写 API Base URL 以覆盖全局；ComfyUI（:8188）请在对应模型卡片配置，不要填在此处。
          </p>

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
              disabled={isVerifying || !apiKey.trim() || !baseUrl.trim() || !verifyModelName.trim()}
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

      <div className="p-4 bg-[var(--bg-elevated)]/50 rounded-lg border border-[var(--border-primary)]">
        <h4 className="text-xs font-bold text-[var(--text-tertiary)] mb-2">配置说明</h4>
        <ul className="text-[10px] text-[var(--text-muted)] space-y-1 list-disc list-inside">
          <li>优先级：模型卡片 API Base URL &gt; 全局 Base URL &gt; 内置默认地址</li>
          <li>全局 Base URL 适用于未单独配置的对话 / 云端图片 / 云端视频模型</li>
          <li>ComfyUI 模型请在「图片/视频模型」卡片中配置 :8188 地址</li>
          <li>验证用模型名称仅用于全局 API Key 连通性测试，不影响「对话模型」页中的激活模型</li>
          <li>全局 API Key 作为默认密钥；也可在单个模型卡片中覆盖</li>
          <li>所有配置仅保存在本地浏览器，不会上传到服务器</li>
        </ul>
      </div>
    </div>
  );
};

export default GlobalSettings;
