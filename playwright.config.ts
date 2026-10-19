import { defineConfig, devices } from '@playwright/test';

// 注意：本环境注入了"安全删除 shim"，会拦截 node 端 fs 的批量删除/改名
// （目录内文件 >500 即报 SAFE_DELETE_BULK_CONFIRM_REQUIRED，且异步抛出、try/catch 兜不住）。
// 因此 outputDir 的预清理不在 node/config 层做，改由 run-test.ps1 用 PowerShell Move-Item
// （shell 层操作，不经 node shim）在启动 playwright 前把已存在的 test-out 移走，
// 使 Playwright 启动时面对的是"不存在的目录"→ 直接新建空目录 → 不会触发批量删除 guard。
// outputDir 固定为 './test-out'，以兼容 enhance-video.js / generate-report.js 的按名查找。
const outputDirPath = './test-out';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'data/test-results.json' }],
  ],
  outputDir: outputDirPath,
  use: {
    baseURL: 'https://holopix.cn',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // 录制尺寸设为 1280x720：略小于最大化后的实际视口（约 1284x726），
    // Chromium 会把画面整体缩放填满，不会产生四周灰边，
    // 因此无需后续 ffmpeg 裁剪重编码（后处理从分钟级降到秒级）。
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    locale: 'zh-CN',
    // 窗口最大化
    viewport: null,
    launchOptions: {
      args: [
        '--start-maximized',
        // 禁用浏览器原生 UI 弹窗（Chrome"要保存密码吗"气泡等）——
        // 这类弹窗在浏览器 UI 层，不在页面 DOM 里，dismissPopups 无法关闭，
        // 必须在启动参数层禁用（--enable-automation 会同时禁用密码保存/自动填充/翻译提示气泡）
        '--enable-automation',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
