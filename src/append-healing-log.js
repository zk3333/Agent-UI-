#!/usr/bin/env node
/**
 * 自愈日志写入器
 *
 * 作用：向 data/healing-log.json 追加/重置自愈推理记录，
 *       供 src/generate-report.js 的 generateHealingLogHTML() 渲染到报告「AI 推理日志」区块。
 *
 * 用法：
 *   node src/append-healing-log.js --reset
 *   node src/append-healing-log.js '{"type":"heal","title":"...","detail":"..."}'
 *
 * type 可选：init | analyze | generate | execute | heal | fix | retry | success | error
 *   （与 generate-report.js 的 typeMeta 一一对应）
 *
 * 说明：PowerShell 下用单引号包裹 JSON 即可安全传入中文与空格。
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const logPath = path.join(dataDir, 'healing-log.json');
const args = process.argv.slice(2);

function readLogs() {
  try {
    const arr = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

if (!args.length) {
  console.error('用法: node src/append-healing-log.js --reset');
  console.error('      node src/append-healing-log.js \'{"type":"heal","title":"...","detail":"..."}\'');
  process.exit(1);
}

if (args[0] === '--reset' || args[0] === 'reset') {
  fs.writeFileSync(logPath, '[]', 'utf8');
  console.log('healing-log: reset -> []');
  process.exit(0);
}

const raw = args.join(' ');
let entry;
try {
  entry = JSON.parse(raw);
} catch (e) {
  console.error('JSON 解析失败：' + e.message);
  process.exit(1);
}
if (!entry || !entry.type || !entry.title) {
  console.error('缺少必填字段 type / title');
  process.exit(1);
}

/**
 * 归一化 ts 为带时区的 UTC ISO 字符串。
 * 无时区标记（既无 Z 也无 ±hh:mm）的时间按 UTC 处理——与默认 toISOString 语义一致，
 * 避免后续按本地时区解析导致报告时间比真实时间早 8 小时（UTC 墙钟被当成本地时间）。
 */
function toUtcIso(value) {
  if (!value) return new Date().toISOString();
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const logs = readLogs();
logs.push({
  ts: toUtcIso(entry.ts),
  type: entry.type,
  title: entry.title,
  detail: entry.detail || '',
});
fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf8');
console.log('healing-log +1: [' + entry.type + '] ' + entry.title);
