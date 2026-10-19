/**
 * 视频「铺满」修正工具
 *
 * 背景：playwright.config.ts 里固定了 video.size = 1920x1080，但实际窗口视口
 * 只有约 1284x726（受屏幕分辨率 / DPI 缩放限制，maximized 也撑不到 1920 CSS px）。
 * Chromium 的 screencast 只输出视口大小的帧，编码画布仍是 1920x1080，于是多出来的
 * 区域被填充为中性灰（YUV 128,128,128），表现为「画面缩在左上角、右侧下方一片灰」。
 *
 * 本模块在一帧画面上自动识别灰边，用 ffmpeg 裁掉，得到内容自适应比例的干净视频，
 * 报告里的 <video> 就能整块铺满。结果带缓存，同一源视频只转码一次。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let ffmpeg = null;
try { ffmpeg = require('ffmpeg-static'); } catch (e) { ffmpeg = null; }

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'playwright-report', '.video-cache');

function runFfmpeg(args, opts = {}) {
  if (!ffmpeg) throw new Error('未安装 ffmpeg-static，无法处理视频边距');
  return execFileSync(ffmpeg, args, { maxBuffer: 512 * 1024 * 1024, ...opts });
}

/** 解析视频宽高与时长 */
function probeVideo(file) {
  let out = '';
  try {
    runFfmpeg(['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stderr || '').toString();
  }
  const m = out.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  const d = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    width: m ? parseInt(m[1], 10) : 0,
    height: m ? parseInt(m[2], 10) : 0,
    duration: d ? parseInt(d[1], 10) * 3600 + parseInt(d[2], 10) * 60 + parseFloat(d[3]) : 0,
  };
}

/**
 * 检测视频四周的「灰边」填充区域，返回应保留的内容矩形。
 * 无填充时返回 null。
 */
function detectContentRect(file) {
  const { width: W, height: H, duration } = probeVideo(file);
  if (!W || !H) return null;

  // 取中间一帧，按 1/2 缩放解码，够快也够准
  const SCALE = 2;
  const w = Math.round(W / SCALE);
  const h = Math.round(H / SCALE);
  let raw;
  try {
    raw = runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(1, Math.floor((duration || 10) / 2))),
      '-i', file, '-frames:v', '1',
      '-vf', `scale=${w}:${h}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
  } catch (e) {
    return null;
  }
  if (!raw || raw.length < w * h * 3) return null;

  const px = (x, y) => {
    const i = (y * w + x) * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  // 中性灰填充：R≈G≈B 且亮度在 100~170
  const isPad = (p) => Math.abs(p[0] - p[1]) <= 8 && Math.abs(p[1] - p[2]) <= 8 && p[0] > 96 && p[0] < 178;

  const colIsPad = (x) => {
    let pad = 0, total = 0;
    for (let y = 0; y < h; y += 3) { total++; if (isPad(px(x, y))) pad++; }
    return pad / total > 0.95;
  };
  const rowIsPad = (y) => {
    let pad = 0, total = 0;
    for (let x = 0; x < w; x += 3) { total++; if (isPad(px(x, y))) pad++; }
    return pad / total > 0.95;
  };

  let left = 0, right = w - 1, top = 0, bottom = h - 1;
  while (left < right && colIsPad(left)) left++;
  while (right > left && colIsPad(right)) right--;
  while (top < bottom && rowIsPad(top)) top++;
  while (bottom > top && rowIsPad(bottom)) bottom--;

  // 向外留 1 个缩放像素的安全边，避免把内容边缘裁掉
  right = Math.min(w - 1, right + 2);
  bottom = Math.min(h - 1, bottom + 2);

  const cw = right - left + 1;
  const ch = bottom - top + 1;
  // 几乎没有边距：认为不需要处理
  if (cw > w * 0.97 && ch > h * 0.97) return null;

  const rect = {
    x: Math.max(0, left * SCALE),
    y: Math.max(0, top * SCALE),
    w: Math.min(W, cw * SCALE),
    h: Math.min(H, ch * SCALE),
    srcWidth: W,
    srcHeight: H,
  };
  // yuv420p 要求偶数尺寸
  rect.w -= rect.w % 2;
  rect.h -= rect.h % 2;
  if (rect.w < 64 || rect.h < 64) return null;
  return rect;
}

/**
 * 返回一个「画面铺满」的视频路径。
 * 若原视频没有填充边距则原样返回；否则裁剪后缓存到 playwright-report/.video-cache。
 */
function ensureFittedVideo(src) {
  if (!src || !fs.existsSync(src) || !ffmpeg) return src;
  const st = fs.statSync(src);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const base = path.basename(src, path.extname(src)).replace(/[^\w.-]+/g, '_');
  const cacheName = `fit-${base}-${Math.round(st.mtimeMs)}-${st.size}.webm`;
  const cachePath = path.join(CACHE_DIR, cacheName);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1024) return cachePath;

  const rect = detectContentRect(src);
  if (!rect) return src;

  console.log(`  ✂️  检测到视频灰边填充 ${rect.srcWidth}x${rect.srcHeight} → 内容区 ${rect.w}x${rect.h}，正在裁剪...`);
  try {
    runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', src,
      '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`,
      // 实时模式 + 最高速度档，裁剪耗时从分钟级降到十几秒
      '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0',
      '-deadline', 'realtime', '-cpu-used', '8',
      '-row-mt', '1', '-threads', '8',
      '-an',
      cachePath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1024) {
      // 只保留本次缓存，删除历史遗留，避免目录无限增长
      try {
        for (const f of fs.readdirSync(CACHE_DIR)) {
          const p = path.join(CACHE_DIR, f);
          if (p !== cachePath) fs.unlinkSync(p);
        }
      } catch {}
      console.log(`  ✅ 已生成铺满版视频: ${path.relative(ROOT, cachePath)}`);
      return cachePath;
    }
  } catch (e) {
    console.log('  ⚠️ 视频裁剪失败，继续使用原始视频:', (e.stderr || e.message || '').toString().split('\n')[0]);
    try { if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath); } catch {}
  }
  return src;
}

module.exports = { ensureFittedVideo, detectContentRect, probeVideo };

if (require.main === module) {
  const src = process.argv[2];
  if (!src) {
    console.error('用法: node src/video-fit.js <视频路径>');
    process.exit(1);
  }
  console.log('检测结果:', detectContentRect(src));
  console.log('输出:', ensureFittedVideo(src));
}
