#!/usr/bin/env node
/**
 * 视频后处理（极速版）：字幕 + 红框，无配音
 *
 * 字幕（顶部胶囊）和红框高亮由 tests/video-utils.ts 的 narrateStep() 在录制过程中
 * 注入页面 DOM，已经直接录进原始视频，不需要 ffmpeg 二次叠加。
 *
 * 已移除：
 *  - edge-tts 语音旁白生成（每步一个 python 子进程 + 网络，最耗时）
 *  - amix 音轨拼接
 *  - drawtext 重复叠加字幕（录屏里已经有了）
 *  - libvpx-vp9 全片重编码（约 2 分钟）
 *
 * 现在只剩：查找原始视频 →（若仍有灰边则一次性裁剪）→ 复制到 report 目录。
 * 正常情况下（录制已按实际视口）耗时 < 1 秒。
 *
 * 用法: node enhance-video.js [原始视频.webm]
 */
const fs = require('fs');
const path = require('path');
const { ensureFittedVideo } = require('./video-fit');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'playwright-report');

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

function main() {
  console.log('═══════════════════════════════════════');
  console.log('  视频后处理：字幕 + 红框（无配音）');
  console.log('═══════════════════════════════════════\n');

  // 1. 查找原始视频
  const sourcePath = findVideo();
  if (!sourcePath) {
    console.error('❌ 未找到原始视频文件（.webm）');
    process.exit(1);
  }
  console.log(`📹 原始视频: ${sourcePath}`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 2. 仅当录制画布大于实际视口（四周有灰边）时才裁剪；正常情况直接返回原文件
  const videoPath = ensureFittedVideo(sourcePath);

  // 3. 不再复制一份 enhanced-video.webm：报告直接引用录制视频，
  //    避免每次运行多出一份 ~15MB 的重复文件。顺手清掉历史遗留副本。
  const legacy = path.join(OUTPUT_DIR, 'enhanced-video.webm');
  if (fs.existsSync(legacy)) {
    try { fs.unlinkSync(legacy); console.log('  🧹 已清理历史遗留的 enhanced-video.webm 副本'); } catch {}
  }

  const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ 视频已就绪: ${videoPath} (${sizeMB} MB)`);
  console.log('   字幕与红框高亮已随录制注入，无需转码、无需复制。');
  return videoPath;
}

module.exports = { main, findVideo };

// 直接运行
if (require.main === module) {
  main();
}
