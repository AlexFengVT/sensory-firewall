import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';

import {
  ARCHIVE_KEY,
  DEFAULT_SETTINGS,
  MODE_CONFIG,
  STORAGE_KEY,
  USAGE_KEY
} from './src/config';
import { SENSORY_POLICY } from './src/policy';
import {
  blankUsage,
  clampNumber,
  countArchiveChars,
  emptyPrecisionContext,
  emptyTaskSession,
  estimateTranscriptionCost,
  extractTextFromOpenAIResponse,
  formatDateTime,
  formatPrecisionContextForPrompt,
  makeId,
  makeMemorySummary,
  money,
  parseDecision,
  parseTags,
  parseTriggerKeywords,
  summarizeArchiveLocally,
  todayKey,
  transcriptMatchesTrigger,
  trimPrecisionContext
} from './src/core';

export default function App() {
  const cameraRef = useRef(null);
  const noiseRef = useRef(null);
  const loopRef = useRef(null);
  const triggerLoopRef = useRef(null);
  const recordingRef = useRef(null);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const lastCloudAtRef = useRef(0);
  const lastTriggerAtRef = useRef(0);
  const precisionContextRef = useRef(emptyPrecisionContext());
  const taskSessionRef = useRef(null);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, setMicPermission] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [usage, setUsage] = useState(blankUsage());
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastDecision, setLastDecision] = useState(null);
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastTriggerTranscript, setLastTriggerTranscript] = useState('');
  const [precisionContext, setPrecisionContext] = useState(emptyPrecisionContext());
  const [taskSession, setTaskSession] = useState(null);
  const [archives, setArchives] = useState([]);
  const [archiveQuery, setArchiveQuery] = useState('');
  const [searchArchiveRaw, setSearchArchiveRaw] = useState(false);
  const [expandedArchiveId, setExpandedArchiveId] = useState(null);
  const [log, setLog] = useState([]);

  const mode = MODE_CONFIG[settings.costMode] || MODE_CONFIG.economy;
  const intervalMs = useMemo(() => clampNumber(settings.analyzeEverySeconds, 5, 600, 20) * 1000, [settings.analyzeEverySeconds]);
  const audioChunkSeconds = useMemo(() => clampNumber(settings.audioChunkSeconds, 3, 30, 8), [settings.audioChunkSeconds]);
  const triggerListenEveryMs = useMemo(() => clampNumber(settings.triggerListenEverySeconds, 3, 300, 12) * 1000, [settings.triggerListenEverySeconds]);
  const triggerAudioChunkSeconds = useMemo(() => clampNumber(settings.triggerAudioChunkSeconds, 2, 20, 4), [settings.triggerAudioChunkSeconds]);
  const minCloudIntervalMs = useMemo(() => clampNumber(settings.minCloudIntervalSeconds, 0, 3600, 180) * 1000, [settings.minCloudIntervalSeconds]);
  const precisionContextTurns = useMemo(() => clampNumber(settings.precisionContextTurns, 1, 30, 8), [settings.precisionContextTurns]);
  const precisionContextChars = useMemo(() => clampNumber(settings.precisionContextChars, 500, 30000, 4500), [settings.precisionContextChars]);
  const precisionSummaryTurns = useMemo(() => clampNumber(settings.precisionSummaryTurns, 1, 60, 16), [settings.precisionSummaryTurns]);
  const precisionSummaryChars = useMemo(() => clampNumber(settings.precisionSummaryChars, 200, 60000, 2200), [settings.precisionSummaryChars]);
  const noiseVolume = useMemo(() => clampNumber(settings.noiseVolume, 0, 1, 0.72), [settings.noiseVolume]);
  const duckVolume = useMemo(() => clampNumber(settings.duckVolume, 0, 1, 0.25), [settings.duckVolume]);
  const dailyBudget = useMemo(() => clampNumber(settings.dailyBudgetUsd, 0, 100, 0.5), [settings.dailyBudgetUsd]);
  const estimatedSceneCost = useMemo(() => clampNumber(settings.estimatedSceneCostUsd, 0, 1, 0.002), [settings.estimatedSceneCostUsd]);
  const estimatedAudioCost = useMemo(() => estimateTranscriptionCost(settings.transcriptionModel, audioChunkSeconds), [settings.transcriptionModel, audioChunkSeconds]);
  const estimatedTriggerAudioCost = useMemo(() => estimateTranscriptionCost(settings.transcriptionModel, triggerAudioChunkSeconds), [settings.transcriptionModel, triggerAudioChunkSeconds]);
  const estimatedOneCloudRun = useMemo(() => {
    return (settings.enableAudio ? estimatedAudioCost : 0) + estimatedSceneCost;
  }, [settings.enableAudio, estimatedAudioCost, estimatedSceneCost]);

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved), apiKey: '' });
        const savedUsage = await AsyncStorage.getItem(USAGE_KEY);
        if (savedUsage) {
          const parsed = JSON.parse(savedUsage);
          setUsage(parsed.date === todayKey() ? { ...blankUsage(), ...parsed } : blankUsage());
        }
        const savedArchives = await AsyncStorage.getItem(ARCHIVE_KEY);
        if (savedArchives) {
          const parsedArchives = JSON.parse(savedArchives);
          setArchives(Array.isArray(parsedArchives) ? parsedArchives : []);
        }
      } catch (e) {
        addLog('读取设置失败');
      } finally {
        setReady(true);
      }
    })();

    return () => {
      runningRef.current = false;
      busyRef.current = false;
      if (loopRef.current) clearTimeout(loopRef.current);
      if (triggerLoopRef.current) clearTimeout(triggerLoopRef.current);
      Speech.stop();
      if (noiseRef.current) noiseRef.current.unloadAsync();
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const persistedSettings = { ...settings, apiKey: '' };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(persistedSettings)).catch(() => {});
  }, [settings]);

  useEffect(() => {
    AsyncStorage.setItem(USAGE_KEY, JSON.stringify(usage)).catch(() => {});
  }, [usage]);

  useEffect(() => {
    AsyncStorage.setItem(ARCHIVE_KEY, JSON.stringify(archives)).catch(() => {});
  }, [archives]);

  function addLog(message) {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [`${time} ${message}`, ...prev].slice(0, 60));
  }

  function updateSetting(key, value) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  function resetPrecisionContextWithLog(message) {
    const next = emptyPrecisionContext();
    precisionContextRef.current = next;
    setPrecisionContext(next);
    if (message) addLog(message);
    return next;
  }

  function startTaskSession(source = 'precision') {
    const next = emptyTaskSession(source);
    taskSessionRef.current = next;
    setTaskSession(next);
    return next;
  }

  function ensureTaskSession(source = 'precision') {
    if (!taskSessionRef.current) return startTaskSession(source);
    return taskSessionRef.current;
  }

  function updateTaskSession(mutator) {
    const current = ensureTaskSession('precision');
    const next = mutator(current);
    taskSessionRef.current = next;
    setTaskSession(next);
    return next;
  }

  function buildArchiveFromSession(session, reason = '任务结束') {
    const titleText = String(settings.archiveTitle || '').trim();
    const tags = parseTags(settings.archiveTags);
    const endedAt = new Date().toISOString();
    return {
      id: makeId('archive'),
      title: titleText || `${reason} ${formatDateTime(session.startedAt)}`,
      tags,
      reason,
      startedAt: session.startedAt,
      endedAt,
      summary: summarizeArchiveLocally({ ...session, endedAt }),
      transcriptCount: Array.isArray(session.transcripts) ? session.transcripts.length : 0,
      decisionCount: Array.isArray(session.decisions) ? session.decisions.length : 0,
      transcriptChars: countArchiveChars(session),
      transcripts: Array.isArray(session.transcripts) ? session.transcripts : [],
      decisions: Array.isArray(session.decisions) ? session.decisions : []
    };
  }

  function archiveCurrentTask(reason = '任务结束', options = {}) {
    const session = taskSessionRef.current;
    if (!session || (!session.transcripts?.length && !session.decisions?.length)) {
      if (!options.silent) addLog('没有可归档的任务内容');
      return null;
    }
    const archive = buildArchiveFromSession(session, reason);
    setArchives(prev => [archive, ...prev].slice(0, 80));
    addLog(`已归档：${archive.title}`);
    taskSessionRef.current = null;
    setTaskSession(null);
    return archive;
  }

  function clearCurrentTaskWithoutArchiving(message = '已清空当前任务') {
    taskSessionRef.current = null;
    setTaskSession(null);
    if (message) addLog(message);
  }

  function finishTaskAndArchive() {
    archiveCurrentTask('手动结束任务');
    resetPrecisionContextWithLog('已结束任务并清空滑动窗口');
  }

  function deleteArchive(id) {
    setArchives(prev => prev.filter(item => item.id !== id));
    if (expandedArchiveId === id) setExpandedArchiveId(null);
    addLog('已删除一条归档');
  }

  function clearArchives() {
    Alert.alert('清空归档？', '这会删除本机保存的所有任务原始转写和摘要。', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => { setArchives([]); setExpandedArchiveId(null); addLog('已清空全部归档'); } }
    ]);
  }

  function setCostMode(nextMode) {
    const cfg = MODE_CONFIG[nextMode] || MODE_CONFIG.economy;
    if (nextMode === 'precision' && settings.costMode !== 'precision') {
      resetPrecisionContextWithLog('进入精确模式：开始新的滑动窗口');
      startTaskSession('mode-switch');
    }
    if (settings.costMode === 'precision' && nextMode !== 'precision') {
      if (settings.autoArchiveOnPrecisionEnd) archiveCurrentTask('离开精确模式', { silent: true });
      else clearCurrentTaskWithoutArchiving('');
      resetPrecisionContextWithLog('离开精确模式：已清空滑动窗口');
    }
    setSettings(prev => ({
      ...prev,
      costMode: nextMode,
      analyzeEverySeconds: cfg.defaultInterval,
      minCloudIntervalSeconds: cfg.defaultCloudCooldown
    }));
  }

  function mutateUsage(patch) {
    setUsage(prev => {
      const base = prev.date === todayKey() ? { ...blankUsage(), ...prev } : blankUsage();
      const nextPatch = typeof patch === 'function' ? patch(base) : patch;
      return { ...base, ...nextPatch };
    });
  }

  function resetUsage() {
    const next = blankUsage();
    setUsage(next);
    addLog('已重置今日预算记录');
  }

  function resetPrecisionContext() {
    resetPrecisionContextWithLog('已清空精确模式滑动窗口');
  }

  function precisionContextEnabled(force = false) {
    return (force || settings.costMode === 'precision') && !!settings.keepPrecisionContext;
  }

  function appendTranscriptToPrecisionContext(transcript, manual, force = false, source = '') {
    if (!precisionContextEnabled(force)) return precisionContextRef.current;
    const text = String(transcript || '').trim();
    if (!text) return precisionContextRef.current;
    const item = {
      id: makeId('tr'),
      isoTime: new Date().toISOString(),
      time: new Date().toLocaleTimeString(),
      manual: !!manual,
      source,
      text
    };
    const nextRaw = {
      ...precisionContextRef.current,
      transcripts: [
        ...precisionContextRef.current.transcripts,
        item
      ]
    };
    const next = trimPrecisionContext(nextRaw, precisionContextTurns, precisionContextChars, precisionSummaryTurns, precisionSummaryChars);
    precisionContextRef.current = next;
    setPrecisionContext(next);

    updateTaskSession(session => ({
      ...session,
      transcripts: [...(session.transcripts || []), item]
    }));
    return next;
  }

  function appendDecisionToPrecisionContext(decision, force = false, transcriptForSummary = '') {
    if (!precisionContextEnabled(force)) return;
    const item = {
      id: makeId('dec'),
      isoTime: new Date().toISOString(),
      time: new Date().toLocaleTimeString(),
      level: Number(decision?.level) || 0,
      mode: decision?.mode || 'silent',
      speak: decision?.speak || '',
      card: decision?.card || '',
      reason: decision?.reason || '',
      memorySummary: decision?.memorySummary || ''
    };
    const summaryText = makeMemorySummary(decision, transcriptForSummary);
    const summaryItem = summaryText ? {
      id: makeId('sum'),
      isoTime: item.isoTime,
      time: item.time,
      source: item.mode,
      summary: summaryText
    } : null;
    const nextRaw = {
      ...precisionContextRef.current,
      summaries: summaryItem ? [...(precisionContextRef.current.summaries || []), summaryItem] : (precisionContextRef.current.summaries || []),
      decisions: [
        ...precisionContextRef.current.decisions,
        item
      ]
    };
    const next = trimPrecisionContext(nextRaw, precisionContextTurns, precisionContextChars, precisionSummaryTurns, precisionSummaryChars);
    precisionContextRef.current = next;
    setPrecisionContext(next);

    updateTaskSession(session => ({
      ...session,
      decisions: [...(session.decisions || []), item]
    }));
  }

  function canSpend(estimated) {
    if (dailyBudget <= 0) return false;
    const current = usage.date === todayKey() ? usage.estimatedSpentUsd : 0;
    return current + estimated <= dailyBudget;
  }

  function shouldUseCloud(manual) {
    if (!settings.apiKey) return { ok: false, reason: 'missing_key' };
    if (!manual && !mode.autoCloud) return { ok: false, reason: 'mode' };
    const since = Date.now() - lastCloudAtRef.current;
    if (!manual && since < minCloudIntervalMs) return { ok: false, reason: 'cooldown' };
    if (!canSpend(estimatedOneCloudRun)) return { ok: false, reason: 'budget' };
    return { ok: true, reason: manual ? 'manual' : 'auto' };
  }

  function shouldUseTriggerCloud() {
    if (!settings.triggerEnabled) return { ok: false, reason: 'disabled' };
    if (!settings.enableAudio) return { ok: false, reason: 'audio_disabled' };
    if (settings.costMode === 'precision') return { ok: false, reason: 'already_precision' };
    if (!settings.apiKey) return { ok: false, reason: 'missing_key' };
    if (!parseTriggerKeywords(settings.triggerKeywords).length) return { ok: false, reason: 'no_keywords' };
    if (!canSpend(estimatedTriggerAudioCost)) return { ok: false, reason: 'trigger_budget' };
    return { ok: true, reason: 'ok' };
  }

  async function ensurePermissions() {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) throw new Error('没有摄像头权限');
    }
    const mic = await Audio.requestPermissionsAsync();
    setMicPermission(mic);
    if (!mic.granted && settings.enableAudio) throw new Error('没有麦克风权限');
  }

  async function setupAudio() {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false
    });
  }

  async function startNoise() {
    if (noiseRef.current) return;
    const { sound } = await Audio.Sound.createAsync(
      require('./assets/white_noise.wav'),
      { isLooping: true, volume: noiseVolume, shouldPlay: true }
    );
    noiseRef.current = sound;
  }

  async function stopNoise() {
    if (noiseRef.current) {
      await noiseRef.current.stopAsync().catch(() => {});
      await noiseRef.current.unloadAsync().catch(() => {});
      noiseRef.current = null;
    }
  }

  async function duckNoise(volume) {
    if (noiseRef.current) {
      await noiseRef.current.setVolumeAsync(volume).catch(() => {});
    }
  }

  async function playPrecisionCue() {
    if (!settings.triggerCueEnabled) return;
    await duckNoise(Math.min(duckVolume, 0.12));
    Speech.stop();
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('./assets/precision_cue.wav'),
        { shouldPlay: true, volume: 1.0 }
      );
      await new Promise(resolve => {
        sound.setOnPlaybackStatusUpdate(status => {
          if (status.didJustFinish || status.error) resolve();
        });
        setTimeout(resolve, 1200);
      });
      await sound.unloadAsync().catch(() => {});
    } catch (e) {
      await new Promise(resolve => {
        Speech.speak('滴', {
          language: settings.language || 'zh-CN',
          rate: 1.1,
          onDone: resolve,
          onError: resolve,
          onStopped: resolve
        });
      });
    }
    await duckNoise(noiseVolume);
  }

  async function speakDecision(decision) {
    const text = (decision?.speak || '').trim();
    if (!text || Number(decision.level) <= 0) return;

    await duckNoise(decision.level >= 4 ? Math.min(duckVolume, 0.15) : duckVolume);
    Speech.stop();
    return new Promise(resolve => {
      Speech.speak(text, {
        language: settings.language || 'zh-CN',
        rate: decision.level >= 4 ? 1.05 : 0.92,
        pitch: 1.0,
        onDone: async () => {
          await duckNoise(noiseVolume);
          resolve();
        },
        onStopped: async () => {
          await duckNoise(noiseVolume);
          resolve();
        },
        onError: async () => {
          await duckNoise(noiseVolume);
          resolve();
        }
      });
    });
  }

  async function captureFrameBase64() {
    if (!settings.enableVision) return null;
    if (!cameraRef.current) return null;
    const photo = await cameraRef.current.takePictureAsync({
      base64: true,
      quality: settings.costMode === 'precision' ? 0.45 : 0.25,
      skipProcessing: true
    });
    if (photo?.uri) {
      FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});
    }
    return photo?.base64 ? `data:image/jpeg;base64,${photo.base64}` : null;
  }

  async function recordAudioChunk(secondsOverride = null) {
    if (!settings.enableAudio) return null;
    const seconds = secondsOverride == null ? audioChunkSeconds : clampNumber(secondsOverride, 2, 30, audioChunkSeconds);
    const durationMs = seconds * 1000;
    try {
      const recording = new Audio.Recording();
      recordingRef.current = recording;
      await recording.prepareToRecordAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.RECORDING_OPTION_ANDROID_OUTPUT_FORMAT_MPEG_4,
          audioEncoder: Audio.RECORDING_OPTION_ANDROID_AUDIO_ENCODER_AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 64000
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.RECORDING_OPTION_IOS_OUTPUT_FORMAT_MPEG4AAC,
          audioQuality: Audio.RECORDING_OPTION_IOS_AUDIO_QUALITY_MEDIUM,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 64000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false
        },
        web: {
          mimeType: 'audio/webm',
          bitsPerSecond: 64000
        }
      });
      await recording.startAsync();
      await new Promise(resolve => setTimeout(resolve, durationMs));
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;
      return uri;
    } catch (e) {
      recordingRef.current = null;
      addLog(`录音失败：${e.message || e}`);
      return null;
    }
  }

  async function transcribeAudio(uri) {
    if (!uri || !settings.apiKey) return '';
    const form = new FormData();
    form.append('model', settings.transcriptionModel || 'gpt-4o-mini-transcribe');
    form.append('file', {
      uri,
      name: 'chunk.m4a',
      type: 'audio/m4a'
    });

    try {
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`
        },
        body: form
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`转写失败 ${res.status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      return json.text || '';
    } finally {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }

  async function callSceneDecision(imageUrl, transcript, contextForPrompt = null) {
    if (!settings.apiKey) throw new Error('缺少 OpenAI API key');

    const contextBlock = contextForPrompt ? `\n\n【连续上下文】\n${contextForPrompt}\n\n要求：当前判断必须接上连续上下文，尤其要保留上一轮未完成的作业/考试/地点/材料说明；但不要重复播报同一个已经播过的事项。` : '';
    const content = [
      {
        type: 'input_text',
        text: `${SENSORY_POLICY}${contextBlock}\n\n【当前麦克风转写】\n${transcript || '(无音频转写)'}\n\n请结合当前画面、当前声音、以及连续上下文判断是否需要输出。若只是普通场景、普通人脸、人声、点名、互动、笑声、表情，必须沉默。`
      }
    ];
    if (imageUrl) {
      content.push({ type: 'input_image', image_url: imageUrl });
    }

    const payload = {
      model: settings.model || 'gpt-4.1-mini',
      input: [{ role: 'user', content }],
      text: {
        format: {
          type: 'json_schema',
          name: 'sensory_firewall_decision',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              level: { type: 'integer', minimum: 0, maximum: 4 },
              mode: { type: 'string', enum: ['silent', 'info', 'suggestion', 'instruction', 'alarm'] },
              speak: { type: 'string' },
              card: { type: 'string' },
              reason: { type: 'string' },
              memorySummary: { type: 'string' }
            },
            required: ['level', 'mode', 'speak', 'card', 'reason', 'memorySummary']
          }
        }
      }
    };

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(payload)
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`分析失败 ${res.status}: ${body.slice(0, 300)}`);
    const json = JSON.parse(body);
    return parseDecision(extractTextFromOpenAIResponse(json));
  }

  function noteSkipped(reason) {
    if (reason === 'budget') mutateUsage(u => ({ skippedByBudget: u.skippedByBudget + 1 }));
    if (reason === 'mode') mutateUsage(u => ({ skippedByMode: u.skippedByMode + 1 }));
    if (reason === 'cooldown') mutateUsage(u => ({ skippedByCooldown: u.skippedByCooldown + 1 }));
    if (reason === 'trigger_budget') mutateUsage(u => ({ skippedByTriggerBudget: u.skippedByTriggerBudget + 1 }));
  }

  async function analyzeOnce(manual = false, options = {}) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const forcePrecisionContext = !!options.forcePrecisionContext;
      const cloudGate = shouldUseCloud(manual);
      if (!cloudGate.ok) {
        noteSkipped(cloudGate.reason);
        const messages = {
          missing_key: '缺少 API key，只播放白噪音',
          mode: '省钱模式自动沉默',
          cooldown: '冷却中，自动沉默',
          budget: '预算已到，自动沉默'
        };
        addLog(messages[cloudGate.reason] || '本轮不调用云端');
        setLastDecision({ level: 0, mode: 'silent', speak: '', card: messages[cloudGate.reason] || '未调用云端', reason: cloudGate.reason, memorySummary: '' });
        return;
      }

      lastCloudAtRef.current = Date.now();
      addLog(`${manual ? '手动' : '自动'}云端分析，预计 ${money(estimatedOneCloudRun)}`);

      const [imageUrl, audioUri] = await Promise.all([
        captureFrameBase64().catch(e => {
          addLog(`画面捕获失败：${e.message || e}`);
          return null;
        }),
        recordAudioChunk(audioChunkSeconds)
      ]);

      let transcript = '';
      if (audioUri) {
        transcript = await transcribeAudio(audioUri).catch(e => {
          addLog(e.message || String(e));
          return '';
        });
        mutateUsage(u => ({
          transcriptionCalls: u.transcriptionCalls + 1,
          audioSeconds: u.audioSeconds + audioChunkSeconds,
          estimatedSpentUsd: u.estimatedSpentUsd + estimatedAudioCost
        }));
      }
      setLastTranscript(transcript);

      let contextForPrompt = null;
      const usePrecisionContext = precisionContextEnabled(forcePrecisionContext);
      if (usePrecisionContext) {
        const previousCtx = trimPrecisionContext(precisionContextRef.current, precisionContextTurns, precisionContextChars, precisionSummaryTurns, precisionSummaryChars);
        contextForPrompt = formatPrecisionContextForPrompt(previousCtx);
        appendTranscriptToPrecisionContext(transcript, manual, forcePrecisionContext, manual ? 'scene-manual' : 'scene-auto');
        addLog(`精确上下文：${(previousCtx.summaries || []).length} 条总结，${previousCtx.transcripts.length} 段前文原文`);
      }

      const decision = await callSceneDecision(imageUrl, transcript, contextForPrompt);
      mutateUsage(u => ({
        sceneCalls: u.sceneCalls + 1,
        estimatedSpentUsd: u.estimatedSpentUsd + estimatedSceneCost
      }));
      setLastDecision(decision);
      appendDecisionToPrecisionContext(decision, forcePrecisionContext, transcript);

      if (decision.level > 0 && decision.speak) {
        addLog(`播报：${decision.speak}`);
        await speakDecision(decision);
      } else {
        addLog('云端判断：沉默');
      }
    } catch (e) {
      addLog(e.message || String(e));
      setLastDecision({ level: 1, mode: 'info', speak: '', card: e.message || String(e), reason: 'error', memorySummary: '' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function enterPrecisionMode(source = '手动', seedTranscript = '', autoAnalyze = false) {
    const cfg = MODE_CONFIG.precision;
    if (taskSessionRef.current && settings.autoArchiveOnPrecisionEnd) {
      archiveCurrentTask('新精确任务开始前自动归档', { silent: true });
    }
    resetPrecisionContextWithLog(`${source}：进入精确模式，开始新的滑动窗口`);
    startTaskSession(source);
    setSettings(prev => ({
      ...prev,
      costMode: 'precision',
      analyzeEverySeconds: cfg.defaultInterval,
      minCloudIntervalSeconds: cfg.defaultCloudCooldown
    }));
    if (seedTranscript) {
      appendTranscriptToPrecisionContext(seedTranscript, false, true, 'trigger-seed');
    }
    await playPrecisionCue();
    if (autoAnalyze && runningRef.current) {
      setTimeout(() => analyzeOnce(true, { forcePrecisionContext: true }), 500);
    }
  }

  async function checkTriggerOnce() {
    if (!runningRef.current) return;
    if (busyRef.current) return;
    const gate = shouldUseTriggerCloud();
    if (!gate.ok) {
      if (gate.reason === 'trigger_budget') noteSkipped('trigger_budget');
      return;
    }
    const now = Date.now();
    if (now - lastTriggerAtRef.current < triggerListenEveryMs) return;
    lastTriggerAtRef.current = now;

    busyRef.current = true;
    setBusy(true);
    try {
      const uri = await recordAudioChunk(triggerAudioChunkSeconds);
      if (!uri) return;
      const transcript = await transcribeAudio(uri).catch(e => {
        addLog(`触发词转写失败：${e.message || e}`);
        return '';
      });
      mutateUsage(u => ({
        triggerTranscriptionCalls: u.triggerTranscriptionCalls + 1,
        triggerAudioSeconds: u.triggerAudioSeconds + triggerAudioChunkSeconds,
        estimatedSpentUsd: u.estimatedSpentUsd + estimatedTriggerAudioCost
      }));
      setLastTriggerTranscript(transcript);
      const hit = transcriptMatchesTrigger(transcript, parseTriggerKeywords(settings.triggerKeywords));
      if (hit) {
        mutateUsage(u => ({ triggerHits: u.triggerHits + 1 }));
        addLog(`触发词命中：${hit}`);
        await enterPrecisionMode(`触发词 ${hit}`, transcript, !!settings.triggerAutoAnalyze);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function loop() {
    if (!runningRef.current) return;
    const startedAt = Date.now();
    await analyzeOnce(false);
    if (!runningRef.current) return;
    const elapsed = Date.now() - startedAt;
    loopRef.current = setTimeout(loop, Math.max(500, intervalMs - elapsed));
  }

  async function triggerLoop() {
    if (!runningRef.current) return;
    const startedAt = Date.now();
    await checkTriggerOnce();
    if (!runningRef.current) return;
    const elapsed = Date.now() - startedAt;
    triggerLoopRef.current = setTimeout(triggerLoop, Math.max(500, triggerListenEveryMs - elapsed));
  }

  async function start() {
    try {
      await ensurePermissions();
      await setupAudio();
      await startNoise();
      runningRef.current = true;
      setRunning(true);
      if (settings.costMode === 'precision' && settings.keepPrecisionContext) {
        resetPrecisionContextWithLog('精确模式：开始新的滑动窗口');
        startTaskSession('start');
      }
      addLog(`开始：${mode.label}模式`);
      loopRef.current = setTimeout(loop, 600);
      triggerLoopRef.current = setTimeout(triggerLoop, 1200);
    } catch (e) {
      Alert.alert('无法启动', e.message || String(e));
    }
  }

  async function stop() {
    runningRef.current = false;
    setRunning(false);
    if (loopRef.current) clearTimeout(loopRef.current);
    if (triggerLoopRef.current) clearTimeout(triggerLoopRef.current);
    if (recordingRef.current) {
      await recordingRef.current.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
    }
    Speech.stop();
    await stopNoise();
    if (settings.costMode === 'precision') {
      if (settings.autoArchiveOnPrecisionEnd) archiveCurrentTask('停止精确模式', { silent: true });
      else clearCurrentTaskWithoutArchiving('停止精确模式：未归档当前任务');
      resetPrecisionContextWithLog('停止精确模式：已清空滑动窗口');
    }
    addLog('停止');
  }

  if (!ready) {
    return <View style={styles.center}><ActivityIndicator /><Text style={styles.muted}>加载中</Text></View>;
  }

  const remainingBudget = Math.max(0, dailyBudget - (usage.estimatedSpentUsd || 0));
  const possibleRuns = estimatedOneCloudRun > 0 ? Math.floor(remainingBudget / estimatedOneCloudRun) : 0;
  const possibleTriggerRuns = estimatedTriggerAudioCost > 0 ? Math.floor(remainingBudget / estimatedTriggerAudioCost) : 0;
  const triggerKeywords = parseTriggerKeywords(settings.triggerKeywords);
  const normalizedArchiveQuery = archiveQuery.trim().toLowerCase();
  const filteredArchives = archives.filter(item => {
    if (!normalizedArchiveQuery) return true;
    const summaryIndex = [item.title, item.summary, item.reason, ...(item.tags || [])].join(' ').toLowerCase();
    if (summaryIndex.includes(normalizedArchiveQuery)) return true;
    if (!searchArchiveRaw) return false;
    const rawIndex = (item.transcripts || []).map(t => t.text || '').join(' ').toLowerCase();
    return rawIndex.includes(normalizedArchiveQuery);
  });

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.cameraWrap}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        <View style={styles.cameraOverlay}>
          <Text style={styles.overlayText}>{running ? `运行中：${mode.label}` : '未启动'}</Text>
          {settings.triggerEnabled && settings.costMode !== 'precision' ? <Text style={styles.overlayText}>触发监听</Text> : null}
          {busy ? <Text style={styles.overlayText}>分析中…</Text> : null}
        </View>
      </View>

      <ScrollView style={styles.panel} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Sensory Firewall V5</Text>
        <Text style={styles.subtitle}>OpenAI 转写 + 双窗口上下文 + 任务归档。沉默表示无须处理。</Text>

        <Text style={styles.sectionTitle}>三个模式</Text>
        <View style={styles.modeRow}>
          {Object.keys(MODE_CONFIG).map(key => (
            <TouchableOpacity
              key={key}
              style={[styles.modeButton, settings.costMode === key ? styles.modeButtonActive : null]}
              onPress={() => setCostMode(key)}
            >
              <Text style={[styles.modeText, settings.costMode === key ? styles.modeTextActive : null]}>{MODE_CONFIG[key].label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.helper}>{mode.description}</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>刺激触发模式</Text>
          <Text style={styles.cardText}>作用：在省钱/平衡模式下，低频用 OpenAI 转写短音频；听到触发词后，播放提示音并进入精确模式。</Text>
          <View style={styles.switchRow}>
            <Text style={styles.labelInline}>开启触发</Text>
            <Switch value={!!settings.triggerEnabled} onValueChange={v => updateSetting('triggerEnabled', v)} />
            <Text style={styles.labelInline}>提示音</Text>
            <Switch value={!!settings.triggerCueEnabled} onValueChange={v => updateSetting('triggerCueEnabled', v)} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.labelInline}>命中后立即分析</Text>
            <Switch value={!!settings.triggerAutoAnalyze} onValueChange={v => updateSetting('triggerAutoAnalyze', v)} />
          </View>
          <Text style={styles.label}>触发词，可用逗号分隔</Text>
          <TextInput value={settings.triggerKeywords} onChangeText={v => updateSetting('triggerKeywords', v)} style={styles.input} autoCapitalize="none" />
          <Text style={styles.helper}>当前触发词：{triggerKeywords.length ? triggerKeywords.join(' / ') : '无'}</Text>
          <View style={styles.row2}>
            <View style={styles.flex1}>
              <Text style={styles.label}>监听间隔 秒</Text>
              <TextInput value={settings.triggerListenEverySeconds} onChangeText={v => updateSetting('triggerListenEverySeconds', v)} keyboardType="numeric" style={styles.input} />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.label}>触发录音 秒</Text>
              <TextInput value={settings.triggerAudioChunkSeconds} onChangeText={v => updateSetting('triggerAudioChunkSeconds', v)} keyboardType="numeric" style={styles.input} />
            </View>
          </View>
          <Text style={styles.cardText}>触发转写估算：每次 {money(estimatedTriggerAudioCost)}，剩余约 {possibleTriggerRuns} 次。</Text>
          <Text style={styles.cardText}>触发命中：{usage.triggerHits}；触发转写：{usage.triggerTranscriptionCalls}；触发秒数：{usage.triggerAudioSeconds}</Text>
          <Text style={styles.cardText}>最近触发转写：{lastTriggerTranscript || '-'}</Text>
        </View>

        <View style={styles.budgetCard}>
          <Text style={styles.cardTitle}>今日预算</Text>
          <Text style={styles.cardText}>已估算：{money(usage.estimatedSpentUsd)} / {money(dailyBudget)}</Text>
          <Text style={styles.cardText}>剩余：{money(remainingBudget)}，约还能完整云端分析 {possibleRuns} 次</Text>
          <Text style={styles.cardText}>完整分析：{money(estimatedOneCloudRun)} = 音频 {money(settings.enableAudio ? estimatedAudioCost : 0)} + 画面 {money(estimatedSceneCost)}</Text>
          <Text style={styles.cardText}>画面调用：{usage.sceneCalls}；分析转写：{usage.transcriptionCalls}；分析录音秒数：{usage.audioSeconds}</Text>
          <Text style={styles.cardText}>跳过：预算 {usage.skippedByBudget} / 模式 {usage.skippedByMode} / 冷却 {usage.skippedByCooldown} / 触发预算 {usage.skippedByTriggerBudget}</Text>
          <TouchableOpacity style={[styles.smallButton, styles.buttonSecondary]} onPress={resetUsage}>
            <Text style={styles.buttonText}>重置今日记录</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>OpenAI API Key</Text>
        <TextInput
          value={settings.apiKey}
          onChangeText={v => updateSetting('apiKey', v)}
          placeholder="sk-..."
          placeholderTextColor="#666"
          secureTextEntry
          autoCapitalize="none"
          style={styles.input}
        />

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.label}>分析模型</Text>
            <TextInput value={settings.model} onChangeText={v => updateSetting('model', v)} style={styles.input} autoCapitalize="none" />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.label}>OpenAI 转写模型</Text>
            <TextInput value={settings.transcriptionModel} onChangeText={v => updateSetting('transcriptionModel', v)} style={styles.input} autoCapitalize="none" />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.label}>自动循环间隔 秒</Text>
            <TextInput value={settings.analyzeEverySeconds} onChangeText={v => updateSetting('analyzeEverySeconds', v)} keyboardType="numeric" style={styles.input} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.label}>云端冷却 秒</Text>
            <TextInput value={settings.minCloudIntervalSeconds} onChangeText={v => updateSetting('minCloudIntervalSeconds', v)} keyboardType="numeric" style={styles.input} />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.label}>分析录音长度 秒</Text>
            <TextInput value={settings.audioChunkSeconds} onChangeText={v => updateSetting('audioChunkSeconds', v)} keyboardType="numeric" style={styles.input} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.label}>每日预算 $</Text>
            <TextInput value={settings.dailyBudgetUsd} onChangeText={v => updateSetting('dailyBudgetUsd', v)} keyboardType="decimal-pad" style={styles.input} />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.label}>估算每次画面 $</Text>
            <TextInput value={settings.estimatedSceneCostUsd} onChangeText={v => updateSetting('estimatedSceneCostUsd', v)} keyboardType="decimal-pad" style={styles.input} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.label}>白噪音音量 0-1</Text>
            <TextInput value={settings.noiseVolume} onChangeText={v => updateSetting('noiseVolume', v)} keyboardType="decimal-pad" style={styles.input} />
          </View>
        </View>

        <View style={styles.row2}>
          <View style={styles.flex1}>
            <Text style={styles.label}>播报时白噪音压低到</Text>
            <TextInput value={settings.duckVolume} onChangeText={v => updateSetting('duckVolume', v)} keyboardType="decimal-pad" style={styles.input} />
          </View>
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.labelInline}>启用画面</Text>
          <Switch value={settings.enableVision} onValueChange={v => updateSetting('enableVision', v)} />
          <Text style={styles.labelInline}>启用声音</Text>
          <Switch value={settings.enableAudio} onValueChange={v => updateSetting('enableAudio', v)} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>精确模式上下文</Text>
          <Text style={styles.cardText}>作用：两层滑动窗口。极简总结窗口保留长期连续性；原文窗口保留最近几段逐字转写，用来接上前文。</Text>
          <View style={styles.switchRow}>
            <Text style={styles.labelInline}>启用上下文</Text>
            <Switch value={!!settings.keepPrecisionContext} onValueChange={v => updateSetting('keepPrecisionContext', v)} />
          </View>
          <View style={styles.row2}>
            <View style={styles.flex1}>
              <Text style={styles.label}>原文窗口段数</Text>
              <TextInput value={settings.precisionContextTurns} onChangeText={v => updateSetting('precisionContextTurns', v)} keyboardType="numeric" style={styles.input} />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.label}>原文窗口最多字符</Text>
              <TextInput value={settings.precisionContextChars} onChangeText={v => updateSetting('precisionContextChars', v)} keyboardType="numeric" style={styles.input} />
            </View>
          </View>
          <View style={styles.row2}>
            <View style={styles.flex1}>
              <Text style={styles.label}>总结窗口条数</Text>
              <TextInput value={settings.precisionSummaryTurns} onChangeText={v => updateSetting('precisionSummaryTurns', v)} keyboardType="numeric" style={styles.input} />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.label}>总结窗口最多字符</Text>
              <TextInput value={settings.precisionSummaryChars} onChangeText={v => updateSetting('precisionSummaryChars', v)} keyboardType="numeric" style={styles.input} />
            </View>
          </View>
          <Text style={styles.cardText}>当前滑动窗口：{(precisionContext.summaries || []).length} 条总结，{precisionContext.transcripts.length} 段原文，{precisionContext.decisions.length} 次判断</Text>
          <Text style={styles.cardText}>当前任务：{taskSession ? `${formatDateTime(taskSession.startedAt)} 开始；已收集 ${(taskSession.transcripts || []).length} 段原始转写，${countArchiveChars(taskSession)} 字符` : '无'}</Text>
          <View style={styles.switchRow}>
            <Text style={styles.labelInline}>结束精确模式时自动归档</Text>
            <Switch value={!!settings.autoArchiveOnPrecisionEnd} onValueChange={v => updateSetting('autoArchiveOnPrecisionEnd', v)} />
          </View>
          <Text style={styles.label}>当前任务标题，可空</Text>
          <TextInput value={settings.archiveTitle} onChangeText={v => updateSetting('archiveTitle', v)} style={styles.input} placeholder="例如 ENGL 课堂说明" placeholderTextColor="#666" />
          <Text style={styles.label}>当前任务标签，可用逗号分隔</Text>
          <TextInput value={settings.archiveTags} onChangeText={v => updateSetting('archiveTags', v)} style={styles.input} placeholder="class, assignment" placeholderTextColor="#666" />
          <View style={styles.buttons}>
            <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={resetPrecisionContext}>
              <Text style={styles.buttonText}>只清空滑动窗口</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.buttonPrecision]} onPress={finishTaskAndArchive}>
              <Text style={styles.buttonText}>结束任务并归档</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.button, running ? styles.buttonDanger : styles.buttonPrimary]} onPress={running ? stop : start}>
            <Text style={styles.buttonText}>{running ? '停止' : '开始'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={() => analyzeOnce(true)} disabled={busy}>
            <Text style={styles.buttonText}>手动云端分析</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[styles.buttonFull, styles.buttonPrecision]} onPress={() => enterPrecisionMode('手动按钮', '', true)} disabled={busy}>
          <Text style={styles.buttonText}>提示音 + 进入精确模式 + 分析一次</Text>
        </TouchableOpacity>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>最近决策</Text>
          <Text style={styles.cardText}>level: {lastDecision?.level ?? '-'}</Text>
          <Text style={styles.cardText}>mode: {lastDecision?.mode ?? '-'}</Text>
          <Text style={styles.cardText}>speak: {lastDecision?.speak || '(沉默)'}</Text>
          <Text style={styles.cardText}>card: {lastDecision?.card || '-'}</Text>
          <Text style={styles.cardText}>reason: {lastDecision?.reason || '-'}</Text>
          <Text style={styles.cardText}>memory: {lastDecision?.memorySummary || '-'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>最近分析音频转写</Text>
          <Text style={styles.cardText}>{lastTranscript || '-'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>精确模式极简总结窗口</Text>
          <Text style={styles.cardText}>{(precisionContext.summaries || []).length ? precisionContext.summaries.map((item, idx) => `${idx + 1}. ${item.time} ${item.source ? `[${item.source}]` : ''} ${item.summary}`).join('\n') : '-'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>精确模式原文窗口</Text>
          <Text style={styles.cardText}>{precisionContext.transcripts.length ? precisionContext.transcripts.map((item, idx) => `${idx + 1}. ${item.time} ${item.manual ? '[手动]' : '[自动]'} ${item.source ? `[${item.source}]` : ''} ${item.text}`).join('\n\n') : '-'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>任务归档</Text>
          <Text style={styles.cardText}>用途：先搜索标题、标签、摘要；必要时再展开原始转写。</Text>
          <TextInput
            value={archiveQuery}
            onChangeText={setArchiveQuery}
            placeholder="搜索摘要/标签/标题"
            placeholderTextColor="#666"
            style={styles.input}
          />
          <View style={styles.switchRow}>
            <Text style={styles.labelInline}>搜索时包含原文</Text>
            <Switch value={!!searchArchiveRaw} onValueChange={setSearchArchiveRaw} />
            <Text style={styles.labelInline}>归档数：{archives.length}</Text>
          </View>
          <TouchableOpacity style={[styles.smallButton, styles.buttonDanger]} onPress={clearArchives}>
            <Text style={styles.buttonText}>清空全部归档</Text>
          </TouchableOpacity>
          {filteredArchives.length ? filteredArchives.map(item => (
            <View key={item.id} style={styles.archiveItem}>
              <Text style={styles.archiveTitle}>{item.title}</Text>
              <Text style={styles.archiveMeta}>{formatDateTime(item.startedAt)} → {formatDateTime(item.endedAt)}</Text>
              <Text style={styles.archiveMeta}>标签：{(item.tags || []).length ? item.tags.join(' / ') : '无'}；转写 {item.transcriptCount} 段；原文 {item.transcriptChars} 字符；判断 {item.decisionCount} 次</Text>
              <Text style={styles.cardText}>摘要：{item.summary}</Text>
              <View style={styles.buttons}>
                <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={() => setExpandedArchiveId(expandedArchiveId === item.id ? null : item.id)}>
                  <Text style={styles.buttonText}>{expandedArchiveId === item.id ? '收起原文' : '展开原文'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, styles.buttonDanger]} onPress={() => deleteArchive(item.id)}>
                  <Text style={styles.buttonText}>删除</Text>
                </TouchableOpacity>
              </View>
              {expandedArchiveId === item.id ? (
                <View style={styles.rawBox}>
                  <Text style={styles.archiveTitle}>原始转写</Text>
                  <Text style={styles.cardText}>{(item.transcripts || []).length ? item.transcripts.map((t, idx) => `${idx + 1}. ${formatDateTime(t.isoTime)} ${t.manual ? '[手动]' : '[自动]'} ${t.source ? `[${t.source}]` : ''}\n${t.text}`).join('\n\n') : '-'}</Text>
                  <Text style={styles.archiveTitle}>AI 判断记录</Text>
                  <Text style={styles.cardText}>{(item.decisions || []).length ? item.decisions.map((d, idx) => `${idx + 1}. ${formatDateTime(d.isoTime)} level=${d.level} ${d.mode} ${d.speak ? `｜${d.speak}` : ''} ${d.card ? `｜${d.card}` : ''} ${d.memorySummary ? `｜memory=${d.memorySummary}` : ''}`).join('\n') : '-'}</Text>
                </View>
              ) : null}
            </View>
          )) : <Text style={styles.cardText}>没有匹配的归档。</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>运行日志</Text>
          {log.map((item, idx) => <Text key={`${idx}-${item}`} style={styles.logText}>{item}</Text>)}
        </View>

        <Text style={styles.warning}>
          这只是原型。触发词监听也会花 OpenAI 转写费用。不要把它当成道路、实验室、厨房或紧急安全系统；不要在禁止录音录像或私人空间使用。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050505' },
  center: { flex: 1, backgroundColor: '#050505', alignItems: 'center', justifyContent: 'center' },
  cameraWrap: { height: 270, backgroundColor: '#111', position: 'relative' },
  camera: { flex: 1 },
  cameraOverlay: { position: 'absolute', left: 12, right: 12, bottom: 12, flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  overlayText: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7, overflow: 'hidden' },
  panel: { flex: 1, padding: 14 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#aaa', marginTop: 4, marginBottom: 12 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 10, marginBottom: 8 },
  label: { color: '#ddd', marginTop: 10, marginBottom: 6, fontSize: 13 },
  labelInline: { color: '#ddd', marginRight: 8 },
  helper: { color: '#aaa', fontSize: 12, lineHeight: 18, marginTop: 8 },
  input: { color: '#fff', backgroundColor: '#171717', borderWidth: 1, borderColor: '#333', borderRadius: 9, paddingHorizontal: 10, paddingVertical: Platform.OS === 'ios' ? 10 : 7 },
  row2: { flexDirection: 'row', gap: 10 },
  flex1: { flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 16 },
  button: { flex: 1, paddingVertical: 13, borderRadius: 10, alignItems: 'center' },
  buttonFull: { paddingVertical: 13, borderRadius: 10, alignItems: 'center', marginTop: 10 },
  smallButton: { alignSelf: 'flex-start', paddingVertical: 9, paddingHorizontal: 12, borderRadius: 9, alignItems: 'center', marginTop: 10 },
  buttonPrimary: { backgroundColor: '#2f6fed' },
  buttonDanger: { backgroundColor: '#b73737' },
  buttonSecondary: { backgroundColor: '#333' },
  buttonPrecision: { backgroundColor: '#5b3cc4' },
  buttonText: { color: '#fff', fontWeight: '700' },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeButton: { flex: 1, borderWidth: 1, borderColor: '#333', backgroundColor: '#121212', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  modeButtonActive: { borderColor: '#6ea2ff', backgroundColor: '#1b2d52' },
  modeText: { color: '#aaa', fontWeight: '700' },
  modeTextActive: { color: '#fff' },
  budgetCard: { backgroundColor: '#101522', borderColor: '#26385f', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 14 },
  card: { backgroundColor: '#111', borderColor: '#282828', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 14 },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 8 },
  cardText: { color: '#ddd', lineHeight: 21 },
  logText: { color: '#aaa', lineHeight: 20, fontSize: 12 },
  archiveItem: { borderTopWidth: 1, borderTopColor: '#2b2b2b', paddingTop: 12, marginTop: 12 },
  archiveTitle: { color: '#fff', fontWeight: '700', lineHeight: 22, marginTop: 4 },
  archiveMeta: { color: '#aaa', lineHeight: 19, fontSize: 12 },
  rawBox: { backgroundColor: '#080808', borderColor: '#252525', borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 10 },
  muted: { color: '#aaa', marginTop: 8 },
  warning: { color: '#c8a45d', fontSize: 12, lineHeight: 18, marginVertical: 18 }
});
