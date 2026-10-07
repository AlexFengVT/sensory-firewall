export const STORAGE_KEY = 'sensory_firewall_settings_v5_dual_context';
export const USAGE_KEY = 'sensory_firewall_usage_v5_dual_context';
export const ARCHIVE_KEY = 'sensory_firewall_task_archives_v5';

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gpt-4.1-mini',
  transcriptionModel: 'gpt-4o-mini-transcribe',
  costMode: 'economy',
  analyzeEverySeconds: '20',
  audioChunkSeconds: '8',
  minCloudIntervalSeconds: '180',
  dailyBudgetUsd: '0.50',
  estimatedSceneCostUsd: '0.0020',
  noiseVolume: '0.72',
  duckVolume: '0.25',
  enableAudio: true,
  enableVision: true,
  language: 'zh-CN',
  keepPrecisionContext: true,
  precisionContextTurns: '6',
  precisionContextChars: '4500',
  precisionSummaryTurns: '16',
  precisionSummaryChars: '2200',
  triggerEnabled: false,
  triggerKeywords: '',
  triggerListenEverySeconds: '12',
  triggerAudioChunkSeconds: '4',
  triggerCueEnabled: true,
  triggerAutoAnalyze: true,
  autoArchiveOnPrecisionEnd: true,
  archiveTitle: '',
  archiveTags: 'class, precision'
};

export const MODE_CONFIG = {
  economy: {
    label: '省钱',
    description: '默认不自动分析场景；白噪音持续。可开启触发词监听，听到触发词后进入精确模式。',
    autoCloud: false,
    defaultInterval: '60',
    defaultCloudCooldown: '300'
  },
  balanced: {
    label: '平衡',
    description: '低频自动云端分析；有冷却时间和每日预算限制。',
    autoCloud: true,
    defaultInterval: '45',
    defaultCloudCooldown: '180'
  },
  precision: {
    label: '精确',
    description: '高频云端分析；上下文分两层：极简总结窗口 + 最近原文窗口。只适合短时间使用。',
    autoCloud: true,
    defaultInterval: '15',
    defaultCloudCooldown: '45'
  }
};
