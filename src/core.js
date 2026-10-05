export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function emptyPrecisionContext() {
  return {
    startedAt: new Date().toISOString(),
    summaries: [],
    transcripts: [],
    decisions: []
  };
}

export function trimTextMiddle(text, maxChars) {
  const raw = String(text || '');
  if (raw.length <= maxChars) return raw;
  const head = Math.floor(maxChars * 0.35);
  const tail = Math.max(0, maxChars - head - 18);
  return `${raw.slice(0, head)}\n…[中间截断]…\n${raw.slice(-tail)}`;
}

export function trimWindowByChars(items, maxItems, maxChars, textKey = 'text') {
  const itemLimit = clampNumber(maxItems, 1, 60, 8);
  const charLimit = clampNumber(maxChars, 200, 60000, 6000);
  let kept = Array.isArray(items) ? items.slice(-itemLimit) : [];
  let total = kept.reduce((sum, item) => sum + String(item[textKey] || '').length, 0);
  while (kept.length > 1 && total > charLimit) {
    const removed = kept.shift();
    total -= String(removed[textKey] || '').length;
  }
  if (total > charLimit && kept.length === 1) {
    kept = [{ ...kept[0], [textKey]: trimTextMiddle(kept[0][textKey], charLimit) }];
  }
  return kept;
}

export function trimPrecisionContext(ctx, rawTurns, rawChars, summaryTurns = 16, summaryChars = 2200) {
  const transcripts = trimWindowByChars(ctx.transcripts, rawTurns, rawChars, 'text');
  const summaries = trimWindowByChars(ctx.summaries, summaryTurns, summaryChars, 'summary');
  const decisions = Array.isArray(ctx.decisions) ? ctx.decisions.slice(-6) : [];
  return {
    startedAt: ctx.startedAt || new Date().toISOString(),
    summaries,
    transcripts,
    decisions
  };
}

export function formatPrecisionContextForPrompt(ctx) {
  const summaries = Array.isArray(ctx.summaries) ? ctx.summaries : [];
  const transcripts = Array.isArray(ctx.transcripts) ? ctx.transcripts : [];
  const decisions = Array.isArray(ctx.decisions) ? ctx.decisions : [];
  const summaryBlock = summaries.length
    ? summaries.map((item, idx) => `摘要 ${idx + 1}｜${item.time}${item.source ? `｜${item.source}` : ''}\n${item.summary}`).join('\n')
    : '(无历史摘要)';
  const transcriptBlock = transcripts.length
    ? transcripts.map((item, idx) => `原文 ${idx + 1}｜${item.time}${item.manual ? '｜手动' : '｜自动'}${item.source ? `｜${item.source}` : ''}\n${item.text}`).join('\n\n')
    : '(无近期原文)';
  const decisionBlock = decisions.length
    ? decisions.map((item, idx) => `判断 ${idx + 1}｜${item.time}\nlevel=${item.level}; mode=${item.mode}; speak=${item.speak || '(沉默)'}; card=${item.card || ''}; memory=${item.memorySummary || ''}`).join('\n')
    : '(无历史判断)';
  return `精确模式连续上下文开始时间：${ctx.startedAt}\n\n【第一层：极简总结窗口】\n用途：保持长期连续性。优先用它理解任务、主题、上一轮已经确认的事实，但不要把摘要当逐字原文。\n${summaryBlock}\n\n【第二层：近期原文窗口】\n用途：保留最近几段 OpenAI 原始转写，处理指代、连续说明、上一句接下一句。需要精确判断时以这里为准。\n${transcriptBlock}\n\n【最近 AI 判断】\n用途：避免重复播报同一事项。\n${decisionBlock}`;
}

export function makeMemorySummary(decision) {
  const explicit = String(decision?.memorySummary || '').trim();
  if (explicit) return explicit.slice(0, 180);
  const level = Number(decision?.level) || 0;
  const fact = String(decision?.card || decision?.speak || '').trim();
  if (level > 0 && fact) return fact.slice(0, 180);
  return '';
}

export function parseTriggerKeywords(text) {
  return String(text || '')
    .split(/[，,;；\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function transcriptMatchesTrigger(transcript, keywords) {
  const raw = String(transcript || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const keyword of keywords) {
    const k = String(keyword || '').trim();
    if (!k) continue;
    if (lower.includes(k.toLowerCase())) return k;
  }
  return null;
}

export function parseTags(text) {
  return String(text || '')
    .split(/[，,;；\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function makeId(prefix = 'task') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyTaskSession(source = 'manual') {
  return {
    id: makeId('session'),
    source,
    startedAt: new Date().toISOString(),
    endedAt: null,
    transcripts: [],
    decisions: []
  };
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return String(iso);
  }
}

export function summarizeArchiveLocally(session) {
  const decisions = Array.isArray(session.decisions) ? session.decisions : [];
  const transcripts = Array.isArray(session.transcripts) ? session.transcripts : [];
  const useful = decisions
    .filter(d => Number(d.level) > 0 && (d.card || d.speak))
    .map(d => (d.card || d.speak || '').trim())
    .filter(Boolean);
  const deduped = [];
  for (const item of useful) {
    if (!deduped.some(x => x === item)) deduped.push(item);
    if (deduped.length >= 4) break;
  }
  if (deduped.length) return deduped.join('；').slice(0, 220);
  const joined = transcripts.map(t => t.text || '').join(' ').replace(/\s+/g, ' ').trim();
  if (joined) return `无高等级播报；转写片段：${joined.slice(0, 160)}`;
  return '本任务没有可用转写。';
}

export function countArchiveChars(session) {
  return (Array.isArray(session.transcripts) ? session.transcripts : [])
    .reduce((sum, item) => sum + String(item.text || '').length, 0);
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function blankUsage() {
  return {
    date: todayKey(),
    estimatedSpentUsd: 0,
    sceneCalls: 0,
    transcriptionCalls: 0,
    triggerTranscriptionCalls: 0,
    triggerHits: 0,
    audioSeconds: 0,
    triggerAudioSeconds: 0,
    skippedByBudget: 0,
    skippedByMode: 0,
    skippedByCooldown: 0,
    skippedByTriggerBudget: 0
  };
}

export function money(n) {
  const value = Number(n) || 0;
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function estimateTranscriptionCost(model, seconds) {
  const minutes = Math.max(0, Number(seconds) || 0) / 60;
  const name = String(model || '').toLowerCase();
  let pricePerMinute = 0.003;
  if (name.includes('realtime')) pricePerMinute = 0.017;
  if (name.includes('whisper-1')) pricePerMinute = 0.006;
  return minutes * pricePerMinute;
}

export function extractTextFromOpenAIResponse(json) {
  if (typeof json.output_text === 'string') return json.output_text;
  const chunks = [];
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === 'string') chunks.push(c.text);
          if (typeof c.output_text === 'string') chunks.push(c.output_text);
        }
      }
    }
  }
  return chunks.join('\n');
}

export function parseDecision(text) {
  if (!text) return { level: 0, mode: 'silent', speak: '', card: '', reason: 'empty', memorySummary: '' };
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    const obj = JSON.parse(cleaned);
    return {
      level: Number.isFinite(Number(obj.level)) ? Number(obj.level) : 0,
      mode: obj.mode || 'silent',
      speak: typeof obj.speak === 'string' ? obj.speak.trim() : '',
      card: typeof obj.card === 'string' ? obj.card.trim() : '',
      reason: typeof obj.reason === 'string' ? obj.reason.trim() : '',
      memorySummary: typeof obj.memorySummary === 'string' ? obj.memorySummary.trim() : ''
    };
  } catch (e) {
    return { level: 1, mode: 'info', speak: '', card: cleaned.slice(0, 300), reason: 'json parse failed', memorySummary: '' };
  }
}
