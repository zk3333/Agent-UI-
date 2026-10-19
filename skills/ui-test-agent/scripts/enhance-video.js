#!/usr/bin/env node
/**
 * 视频增强脚本：为 Playwright 录制的视频添加语音旁白 + 步骤文案
 *
 * 流程：
 *  1. 读取 step-timings.json 获取每个步骤的文案和时间戳
 *  2. 用 edge-tts 生成每步的中文语音
 *  3. 用 ffmpeg 将语音拼接，叠加到原始视频上
 *
 * 用法: node enhance-video.js [原始视频.webm]
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const ROOT = path.resolve(__dirname, '..');
const TIMINGS_FILE = path.join(ROOT, 'data', 'step-timings.json');
const TTS_DIR = path.join(ROOT, 'tts-cache');
const OUTPUT_DIR = path.join(ROOT, 'playwright-report');

// 确保目录存在
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });

// 查找原始视频文件
function findVideo() {
  // 优先从命令行参数获取
  if (process.argv[2] && fs.existsSync(process.argv[2])) return process.argv[2];

  // 在固定的 test-out 目录中递归查找最新的 webm
  const testDir = path.join(ROOT, 'test-out');
  if (!fs.existsSync(testDir)) return null;

  function findWebmRecursive(dir) {
    const results = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        results.push(...findWebmRecursive(fullPath));
      } else if (item.name.endsWith('.webm')) {
        results.push({ name: item.name, path: fullPath, mtime: fs.statSync(fullPath).mtime });
      }
    }
    return results;
  }

  const files = findWebmRecursive(testDir);
  if (files.length > 0) {
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0].path;
  }
  return null;
}

// 用 edge-tts 生成单条语音
function generateTTS(text, outputPath) {
  if (fs.existsSync(outputPath)) return true;
  try {
    execSync(`python -m edge_tts --voice zh-CN-XiaoxiaoNeural --rate=-10% --text "${text.replace(/"/g, '\\"')}" --write-media "${outputPath}"`, {
      stdio: 'pipe',
    });
    return true;
  } catch (e) {
    return false;
  }
}

// 并行生成所有 TTS 语音（使用子进程，不阻塞）
function generateTTSBatch(timings) {
  const { spawn } = require('child_process');
  const tasks = timings.filter(step => {
    const audioFile = path.join(TTS_DIR, `step-${step.index}.mp3`);
    step.audioFile = audioFile;
    return !fs.existsSync(audioFile);
  });

  if (tasks.length === 0) {
    console.log(`  ♻️  全部 ${timings.length} 条语音已缓存`);
    return;
  }

  console.log(`  🎙️  并行生成 ${tasks.length} 条语音（已缓存 ${timings.length - tasks.length} 条）...`);
  const MAX_CONCURRENT = 5;
  let completed = 0;
  let index = 0;

  return new Promise((resolve, reject) => {
    function next() {
      while (index < tasks.length && (index - completed) < MAX_CONCURRENT) {
        const step = tasks[index++];
        const audioFile = step.audioFile;
        const child = spawn('python', ['-m', 'edge_tts', '--voice', 'zh-CN-XiaoxiaoNeural', '--rate=-10%', '--text', step.title, '--write-media', audioFile], { stdio: 'pipe' });
        child.on('close', (code) => {
          completed++;
          if (code !== 0) console.log(`  ⚠️ 步骤 ${step.index} 语音生成失败`);
          if (completed === tasks.length) resolve();
          else next();
        });
        child.on('error', () => {
          completed++;
          if (completed === tasks.length) resolve();
          else next();
        });
      }
    }
    next();
  });
}

// 带 EBUSY 重试的 execFileSync 封装
function execFfmpegRetry(cmd, args, options = {}) {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
    } catch (e) {
      if (e.code === 'EBUSY' && attempt < maxRetries - 1) {
        const wait = (attempt + 1) * 2000;
        execSync(`powershell -Command "Start-Sleep -Milliseconds ${wait}"`);
        continue;
      }
      throw e;
    }
  }
}

// 获取音频时长（秒）—— 单次 ffmpeg 调用，从 stderr 解析
function getAudioDuration(filePath) {
  try {
    execFfmpegRetry(ffmpeg, ['-i', filePath, '-f', 'null', '-'], { encoding: 'utf8' });
  } catch (e) {
    const err = e.stderr ? e.stderr.toString() : (e.toString ? e.toString() : '');
    const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  }
  return 2; // 默认 2 秒
}

// 生成带文字的图片覆盖层（透明背景 PNG）
function generateTextOverlay(text, outputPath, width = 1280) {
  // 用 ffmpeg 生成文字图片
  const escaped = text.replace(/'/g, "\\'").replace(/:/g, '\\:');
  execFileSync(ffmpeg, [
    '-f', 'lavfi', '-i', `color=c=red@0.85:s=${width}x48:d=1`,
    '-vf', `drawtext=text='${escaped}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-frames:v', '1',
    outputPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  视频增强：语音旁白 + 步骤文案');
  console.log('═══════════════════════════════════════\n');

  // 1. 查找原始视频
  const videoPath = findVideo();
  if (!videoPath) {
    console.error('❌ 未找到原始视频文件（.webm）');
    process.exit(1);
  }
  console.log(`📹 原始视频: ${videoPath}`);

  // 2. 读取步骤时间表
  if (!fs.existsSync(TIMINGS_FILE)) {
    console.error('❌ 未找到 step-timings.json，请先运行测试');
    process.exit(1);
  }
  const timings = JSON.parse(fs.readFileSync(TIMINGS_FILE, 'utf8'));
  console.log(`📋 步骤数: ${timings.length}\n`);

  // 3. 并行生成所有 TTS 语音
  console.log('─── 生成语音旁白 ───');
  for (const step of timings) {
    step.audioFile = path.join(TTS_DIR, `step-${step.index}.mp3`);
  }
  await generateTTSBatch(timings);

  // 获取每条语音时长
  for (const step of timings) {
    step.audioDuration = getAudioDuration(step.audioFile);
  }
  console.log(`  ✅ ${timings.length} 条语音就绪`);

  // 4. 获取视频总时长
  let videoDuration = 60;
  try {
    const probe = execFfmpegRetry(ffmpeg, ['-i', videoPath, '-hide_banner']);
    const m = probe.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) videoDuration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  } catch (e) {
    const err = e.stderr ? e.stderr.toString() : e.toString();
    const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) videoDuration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  }
  console.log(`\n🎬 视频总时长: ${videoDuration.toFixed(1)}s`);

  // 5. 计算每个步骤在视频中的相对时间位置
  const firstStart = timings[0].startMs;
  for (const step of timings) {
    step.videoOffset = Math.max(0, (step.startMs - firstStart) / 1000);
  }

  // 6. 构建 ffmpeg 命令：拼接音频 + 叠加文字
  console.log('\n─── 合成增强视频 ───');

  // 6a. 生成完整音轨（静音 + 各步骤语音按时间偏移拼接）
  const silenceDir = path.join(TTS_DIR, 'silence');
  if (!fs.existsSync(silenceDir)) fs.mkdirSync(silenceDir, { recursive: true });

  // 生成一段足够长的静音音轨
  const silenceFile = path.join(silenceDir, 'silence.mp3');
  if (!fs.existsSync(silenceFile)) {
    execFfmpegRetry(ffmpeg, ['-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`, '-t', String(videoDuration + 5), '-q:a', '9', silenceFile]);
  }

  // 用 adelay 延迟每个音频到对应位置，然后 amix 混合
  const audioInputs = ['-i', silenceFile];
  for (const step of timings) {
    audioInputs.push('-i', step.audioFile);
  }

  const filterParts = [];
  const amixInputs = ['[0:a]'];

  for (let i = 0; i < timings.length; i++) {
    const step = timings[i];
    const delayMs = Math.round(step.videoOffset * 1000);
    filterParts.push(`[${i + 1}:a]adelay=${delayMs}|${delayMs}[a${i + 1}]`);
    amixInputs.push(`[a${i + 1}]`);
  }

  const mixInputs = amixInputs.join('');
  const amixCount = timings.length + 1;
  filterParts.push(`${mixInputs}amix=inputs=${amixCount}:duration=first:dropout_transition=0[aout]`);

  const audioFilter = filterParts.join(';');

  // 6b. 生成 drawtext 滤镜（步骤文案叠加）
  const drawTextParts = [];
  for (const step of timings) {
    const escapedText = step.title.replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
    const startSec = step.videoOffset;
    const endSec = Math.min(videoDuration, step.videoOffset + step.audioDuration + 1);
    drawTextParts.push(
      `drawtext=text='${escapedText}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=12:box=1:boxcolor=red@0.85:boxborderw=8:enable='between(t,${startSec.toFixed(2)},${endSec.toFixed(2)})'`
    );
  }

  const videoFilter = drawTextParts.join(',');

  // 6c. 执行 ffmpeg
  const outputPath = path.join(OUTPUT_DIR, 'enhanced-video.webm');
  const args = [
    ...audioInputs,
    '-i', videoPath,
    '-filter_complex', `${videoFilter ? `[${timings.length + 1}:v]${videoFilter}[vout];${audioFilter}` : audioFilter}`,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libvpx-vp9',
    '-c:a', 'libopus',
    '-b:v', '1M',
    '-b:a', '128k',
    '-y',
    outputPath,
  ];

  console.log(`  🔧 ffmpeg 命令已构建 (${args.length} 参数)`);
  console.log(`  📤 输出: ${outputPath}`);

  try {
    execFfmpegRetry(ffmpeg, args, { stdio: 'inherit', maxBuffer: 100 * 1024 * 1024 });
    console.log(`\n✅ 增强视频已生成: ${outputPath}`);
  } catch (e) {
    console.error('\n⚠️ ffmpeg 合成失败，尝试备用方案（仅音频合成）...');
    // 备用方案：仅合并音频到视频
    try {
      const args2 = [
        ...audioInputs,
        '-i', videoPath,
        '-filter_complex', audioFilter,
        '-map', '1:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'libopus',
        '-shortest',
        '-y',
        outputPath,
      ];
      execFfmpegRetry(ffmpeg, args2, { stdio: 'inherit', maxBuffer: 100 * 1024 * 1024 });
      console.log(`\n✅ 增强视频已生成（仅音频）: ${outputPath}`);
    } catch (e2) {
      console.error('❌ 视频合成失败:', e2.message);
      process.exit(1);
    }
  }

  return outputPath;
}

module.exports = { main, findVideo, generateTTS, getAudioDuration };

// 直接运行
if (require.main === module) {
  main();
}
