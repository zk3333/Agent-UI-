# 项目目录结构说明

```
ui_test/
├── src/                        # 🔧 脚本源码
│   ├── generate-report.js      #    报告生成器
│   ├── enhance-video.js        #    视频增强（ffmpeg 裁剪/合成）
│   ├── video-fit.js            #    视频灰边自动裁剪（保证画面铺满）
│   ├── video-merge.js          #    主录像 + 分页录像按时间内联合并
│   └── append-prompt.js        #    提示词持久化工具
├── tests/                      # 🧪 测试脚本
│   ├── holopix-login.spec.ts   #    HoloPix UI 自动化测试
│   └── video-utils.ts          #    红框高亮+步骤标签模块
├── assets/                     # 📦 静态资源
│   └── test-image.png          #    测试上传图片
├── data/                       # 📄 数据文件
│   ├── steps.md                #    操作步骤文档
│   ├── step-timings.json       #    步骤计时数据
│   ├── test-results.json       #    JSON 报告数据
│   └── user-prompts.json       #    用户提示词存档
├── screenshots/                # 📸 截图输出（自动生成）
├── playwright-report/          # 📊 报告输出（自动生成）
├── run-test.ps1               # 🚀 测试运行脚本（预清理+跑测试+生成报告）
├── poll-test.ps1              # ⏳ 轮询 run.log 等待 RC= 标记
├── test-out/                   # 🎥 视频录制输出（自动生成+清理）
├── node_modules/               # 📦 npm 依赖
├── package.json                # ⚙️ npm 配置
├── playwright.config.ts        # ⚙️ Playwright 配置
├── tsconfig.json               # ⚙️ TypeScript 配置
└── PROJECT-STRUCTURE.md        # 📖 本说明文件
```

## 核心脚本说明

| 脚本 | 作用 | 运行命令 |
|---|---|---|
| `src/generate-report.js` | 解析 Playwright 原生报告内嵌数据，生成浅紫白色主题自包含 HTML 报告 | `node src/generate-report.js` |
| `src/enhance-video.js` | 读取步骤计时数据，用 ffmpeg 对视频做裁剪/合成增强（TTS 语音旁白已移除） | `node src/enhance-video.js` |
| `src/video-fit.js` | 检测录制视频四周的灰边填充并裁剪，让报告里的录像铺满播放器 | `node src/video-fit.js <视频路径>` |
| `src/video-merge.js` | 用 (mtime−时长) 推算分页录像时间点，去黑屏后内联进主录像，解决详情页/分享页视频缺失 | 由 `generate-report.js` 自动调用 |
| `src/append-prompt.js` | 将用户提示词追加到 JSON 存档 | `node src/append-prompt.js "提示词内容"` |
| `run-test.ps1` | 预清理 outputDir（Move 到 TEMP）→ 跑测试 → 生成自定义报告 | `.\run-test.ps1` |
| `poll-test.ps1` | 轮询 run.log 直到出现 `RC=` 标记（供异步等待测试结果） | `.\poll-test.ps1` |
| `tests/holopix-login.spec.ts` | HoloPix 登录+创作流程 UI 自动化测试 | `npx playwright test` |
| `tests/video-utils.ts` | 视频增强工具模块（被测试脚本 import） | 被测试脚本引用，不单独运行 |

## 常用命令

```bash
# 完整流程：测试 → 视频增强 → 生成报告
npm run test

# 带浏览器窗口运行
npm run test:headed

# 仅生成报告
npm run report

# 仅运行视频增强
npm run enhance-video

# 保存用户提示词
npm run save-prompt -- "提示词内容"

# 预览报告（需先启动 HTTP 服务器）
node playwright-report/serve.js
# 然后访问 http://localhost:8766/custom-report.html
```

## 依赖说明

| 依赖 | 类型 | 用途 |
|---|---|---|
| `@playwright/test` | npm devDependency | Playwright 测试框架 |
| `typescript` | npm devDependency | TypeScript 编译 |
| `ffmpeg-static` | npm（可选） | 视频合成（ffmpeg 二进制；未安装时报告仍可用原生录像） |

## 目录分类逻辑

| 分类 | 目录 | 说明 |
|---|---|---|
| **源码** | `src/` | 报告生成、视频增强等工具脚本 |
| **测试** | `tests/` | Playwright 测试脚本和辅助模块 |
| **数据** | `data/` | 步骤文档、计时数据、报告数据、提示词存档 |
| **资源** | `assets/` | 测试用静态资源（上传图片等） |
| **配置** | 根目录 | package.json、playwright.config.ts、tsconfig.json |
| **输出** | `playwright-report/`、`screenshots/`、`test-out/` | 运行时自动生成，可安全删除 |
