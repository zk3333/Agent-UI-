import type { Page, Locator } from '@playwright/test';

/**
 * 视频增强工具：红框高亮 + 步骤文案横幅
 *
 * 用法：
 *   await showStepBanner(page, '输入账号和密码');
 *   await highlightLocator(page, accountInput);
 *   await accountInput.fill(ACCOUNT);
 *   await clearHighlight(page);
 */

let stepIndex = 0;
const stepTimings: { title: string; startMs: number }[] = [];

/**
 * 在页面顶部显示步骤文案横幅（固定定位，会被视频录制捕获）
 */
export async function showStepBanner(page: Page, title: string) {
  stepIndex++;
  stepTimings.push({ title, startMs: Date.now() });

  await page.evaluate((text) => {
    // 移除旧标签
    const old = document.getElementById('__step_banner');
    if (old) old.remove();

    const label = document.createElement('div');
    label.id = '__step_banner';
    label.style.cssText = `
      position: fixed;
      top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647;
      padding: 6px 18px;
      background: rgba(255,255,255,.92);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(124,58,237,.15);
      border-radius: 999px;
      box-shadow: 0 2px 12px rgba(0,0,0,.12), 0 0 0 1px rgba(255,255,255,.5);
      color: #1e1b2e;
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      font-size: 13px; font-weight: 600;
      letter-spacing: .3px;
      pointer-events: none;
      white-space: nowrap;
    `;
    label.textContent = text;
    document.documentElement.appendChild(label);
  }, title);
}

/**
 * 给目标元素添加红色高亮框（会被视频录制捕获）
 */
export async function highlightLocator(page: Page, locator: Locator): Promise<void> {
  // 可选高亮目标可能不存在（如 pick() 兜底返回的候选定位器），
  // 用短超时 + catch 快速跳过，避免默认 actionTimeout(15s) 挂起拖垮整个测试
  const element = await locator.elementHandle({ timeout: 2000 }).catch(() => null);
  if (!element) return;

  await page.evaluate((el) => {
    // 先清除旧高亮
    document.querySelectorAll('#__highlight_box').forEach(e => e.remove());

    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.id = '__highlight_box';
    box.style.cssText = `
      position: fixed;
      left: ${rect.left - 4}px;
      top: ${rect.top - 4}px;
      width: ${rect.width + 8}px;
      height: ${rect.height + 8}px;
      border: 3px solid #ff0000;
      border-radius: 4px;
      box-shadow: 0 0 12px rgba(255,0,0,.6), 0 0 4px rgba(255,0,0,.8);
      z-index: 2147483646;
      pointer-events: none;
      animation: hl-pulse 1s ease-in-out infinite;
    `;

    // 注入动画 keyframes（只注入一次）
    if (!document.getElementById('__hl_style')) {
      const style = document.createElement('style');
      style.id = '__hl_style';
      style.textContent = `
        @keyframes hl-pulse {
          0%, 100% { box-shadow: 0 0 12px rgba(255,0,0,.6), 0 0 4px rgba(255,0,0,.8); }
          50% { box-shadow: 0 0 20px rgba(255,0,0,.9), 0 0 8px rgba(255,0,0,1); }
        }
      `;
      document.head.appendChild(style);
    }

    document.documentElement.appendChild(box);
  }, element);
}

/**
 * 通过 CSS 选择器高亮元素
 */
export async function highlightSelector(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;

    document.querySelectorAll('#__highlight_box').forEach(e => e.remove());
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.id = '__highlight_box';
    box.style.cssText = `
      position: fixed;
      left: ${rect.left - 4}px;
      top: ${rect.top - 4}px;
      width: ${rect.width + 8}px;
      height: ${rect.height + 8}px;
      border: 3px solid #ff0000;
      border-radius: 4px;
      box-shadow: 0 0 12px rgba(255,0,0,.6), 0 0 4px rgba(255,0,0,.8);
      z-index: 2147483646;
      pointer-events: none;
      animation: hl-pulse 1s ease-in-out infinite;
    `;

    if (!document.getElementById('__hl_style')) {
      const style = document.createElement('style');
      style.id = '__hl_style';
      style.textContent = `
        @keyframes hl-pulse {
          0%, 100% { box-shadow: 0 0 12px rgba(255,0,0,.6), 0 0 4px rgba(255,0,0,.8); }
          50% { box-shadow: 0 0 20px rgba(255,0,0,.9), 0 0 8px rgba(255,0,0,1); }
        }
      `;
      document.head.appendChild(style);
    }

    document.documentElement.appendChild(box);
  }, selector);
}

/**
 * 清除红框高亮
 */
export async function clearHighlight(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('#__highlight_box').forEach(e => e.remove());
  });
}

/**
 * 移除步骤横幅
 */
export async function hideStepBanner(page: Page) {
  await page.evaluate(() => {
    const b = document.getElementById('__step_banner');
    if (b) b.remove();
  });
}

/**
 * 组合操作：显示横幅 → 高亮元素 → 等待（让视频捕获）→ 清除高亮
 * 在此函数后继续执行实际的点击/输入操作
 */
export async function narrateStep(
  page: Page,
  title: string,
  highlightTarget?: Locator | string,
  holdMs: number = 1500
) {
  await showStepBanner(page, title);

  if (highlightTarget) {
    if (typeof highlightTarget === 'string') {
      await highlightSelector(page, highlightTarget);
    } else {
      await highlightLocator(page, highlightTarget);
    }
  }

  // 等待红框和横幅在视频中可见
  await page.waitForTimeout(holdMs);
}

/**
 * 获取步骤计时信息（供后处理脚本生成 TTS 音频时对齐用）
 */
export function getStepTimings() {
  return stepTimings.map((s, i) => ({
    index: i + 1,
    title: s.title,
    startMs: s.startMs,
  }));
}

/**
 * 重置步骤计时（每次测试开始时调用）
 */
export function resetStepTimings() {
  stepIndex = 0;
  stepTimings.length = 0;
}
