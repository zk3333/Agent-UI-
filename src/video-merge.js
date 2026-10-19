/**
 * 按录制时间内联合并「主录像 + 分页录像」
 *
 * 背景：Playwright 按 page 分别录制视频。主页面视频看不到新标签页（详情页/分享页）内容；
 * 分页视频往往开头有 5~15s 黑屏（页面加载），若直接追加到主录像末尾，详情页内容只剩结尾一闪，
 * 看起来就像"步骤有截图、视频里却没有这一步"。
 *
 * 做法：
 *  1. 用 (文件 mtime - 时长) 推算每段录像的真实结束/开始时刻；
 *  2. 用 blackdetect 去掉分页录像开头的黑屏；
 *  3. 把有效内容按相对主录像的偏移**替换**进主录像对应区间（保持总时长≈主录像）；
 *  4. ffmpeg trim + concat 重编码输出（VP9 realtime 档，约 6x 实时速度）。
 *
 * 任何一步失败返回 null，由调用方回退到旧的「末尾追加」逻辑。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let ffmpeg = null;
try { ffmpeg = require('ffmpeg-static'); } catch { /* 可选依赖 */ }

/** 读取视频时长与分辨率（ffmpeg -i 输出解析） */
function probe(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const s = r.stderr || '';
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  const v = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(s);
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0,
    width: v ? parseInt(v[1], 10) : 0,
    height: v ? parseInt(v[2], 10) : 0,
  };
}

/** 返回开头黑屏结束时间（秒）；无黑屏返回 0 */
function leadingBlackEnd(file) {
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-i', file,
    '-vf', 'blackdetect=d=0.2:pix_th=0.12',
    '-an', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const s = r.stderr || '';
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
  let m;
  let end = 0;
  while ((m = re.exec(s))) {
    const st = parseFloat(m[1]);
    const en = parseFloat(m[2]);
    if (st <= 0.6) end = Math.max(end, en);
  }
  return end;
}

/**
 * @param {{main:string, extras:string[], outPath:string}} opts
 * @returns {string|null} 成功返回 outPath，失败返回 null
 */
function buildFullRunVideo({ main, extras, outPath }) {
  if (!ffmpeg || !main || !fs.existsSync(main)) return null;
  const mainInfo = probe(main);
  if (!mainInfo.duration) return null;
  const mainStart = fs.statSync(main).mtimeMs - mainInfo.duration * 1000;

  const inserts = [];
  for (const file of extras) {
    if (!file || !fs.existsSync(file)) continue;
    const info = probe(file);
    if (!info.duration) continue;
    const start = fs.statSync(file).mtimeMs - info.duration * 1000;
    const blackEnd = Math.min(leadingBlackEnd(file), info.duration - 0.2);
    if (blackEnd >= info.duration - 0.2) continue; // 整段全黑，丢弃
    const relStart = (start - mainStart) / 1000 + blackEnd;
    const relEnd = (start - mainStart) / 1000 + info.duration;
    if (relEnd <= 0) continue; // 早于主录像开始
    inserts.push({ file, trimStart: blackEnd, trimEnd: info.duration, relStart, relEnd });
  }
  if (!inserts.length) return null;
  inserts.sort((a, b) => a.relStart - b.relStart);

  // 组装分段：主录像区间 + 分页内容（按时间替换，总时长≈主录像）
  const segments = [];
  const used = [];
  let cursor = 0;
  for (const ins of inserts) {
    const s = Math.max(cursor, Math.min(mainInfo.duration, ins.relStart));
    if (s >= mainInfo.duration) break;
    const e = Math.min(mainInfo.duration, Math.max(s + 0.2, ins.relEnd));
    const dur = Math.min(e - s, ins.trimEnd - ins.trimStart);
    if (dur <= 0.1) continue;
    if (s > cursor) segments.push({ file: main, start: cursor, end: s });
    segments.push({ file: ins.file, start: ins.trimStart, end: ins.trimStart + dur });
    used.push({ file: ins.file, at: s, from: ins.trimStart, dur });
    cursor = s + dur;
  }
  if (cursor < mainInfo.duration - 0.05) {
    segments.push({ file: main, start: cursor, end: mainInfo.duration });
  }
  if (!used.length) return null;

  // filter_complex：主录像 split 复用，分页录像各自 trim，最后 concat
  const mainSegs = segments.filter(s => s.file === main);
  const extraSegs = segments.filter(s => s.file !== main);
  const inputs = [main, ...used.map(u => u.file)];
  const parts = [];
  if (mainSegs.length) {
    parts.push(`[0:v]split=${mainSegs.length}${mainSegs.map((_, i) => `[m${i}]`).join('')}`);
    mainSegs.forEach((s, i) => {
      parts.push(`[m${i}]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[ms${i}]`);
    });
  }
  const extraInputIndex = new Map();
  used.forEach((u, i) => extraInputIndex.set(u.file, i + 1));
  extraSegs.forEach((s, i) => {
    const idx = extraInputIndex.get(s.file);
    parts.push(`[${idx}:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[es${i}]`);
  });
  const order = segments.map(s => (s.file === main
    ? `ms${mainSegs.indexOf(s)}`
    : `es${extraSegs.indexOf(s)}`));
  parts.push(`${order.map(o => `[${o}]`).join('')}concat=n=${order.length}:v=1:a=0[outv]`);

  const args = ['-y'];
  inputs.forEach(f => args.push('-i', f));
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[outv]',
    '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0',
    '-deadline', 'realtime', '-cpu-used', '8',
    '-row-mt', '1', '-threads', '8', '-an',
    outPath,
  );

  console.log('  🎬 按时间内联分页录像:');
  used.forEach(u => {
    console.log(`     - ${path.basename(u.file)} → 插入 ${u.at.toFixed(2)}s（内容 ${u.from.toFixed(2)}s 起，${u.dur.toFixed(2)}s）`);
  });

  const r = spawnSync(ffmpeg, args, { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    return null;
  }
  return outPath;
}

module.exports = { buildFullRunVideo, probe, leadingBlackEnd };
