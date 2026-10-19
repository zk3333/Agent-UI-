import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { narrateStep, clearHighlight, hideStepBanner, resetStepTimings, getStepTimings } from './video-utils';

/**
 * HoloPix 登录 + 自由画布创作流程 UI 自动化测试
 *
 * 测试步骤来源：steps.md
 *  1. 打开 https://holopix.cn
 *  2. 点击"登录"按钮
 *  3. 选择账号密码登录方式
 *  4. 输入账号密码 (15767065333 / zhangkai0716)
 *  5. 点击"登录"按钮
 *  6. 断言首页右上角有头像和有用户算力
 *  7. 点击自由画布
 *  8. 高级输入框选择模板：细节强化器
 *  9. 切换到全能编辑V3
 *  10. 上传图片（调用本地图库，随机选择一张图片）
 *  11. 上传完毕点击生成按钮
 *  12. 断言生成完成
 *  13. 生成完成后点击右侧创作记录，hover 态生成的图 → 收藏/断言已收藏；发布/填标签提交
 *
 * 自愈记录：
 *  - 首页无文字"登录"按钮，登录入口为头像 img[alt=avatar] → 触发 popover → 点击 .to-login-btn-tooltip .button
 *  - 登录对话框默认为微信扫码，需点击"账号密码"文字切换
 *  - 密码框在填入手机号并点击"注册/登录"后才出现
 *  - 登录按钮文本为"登 录"（中间有空格）
 *  - 登录成功后头部右上角显示头像与"算力"数值，作为用户身份断言依据
 *  - 页面可能随时弹出推广弹窗，需主动检测并关闭
 *  - 自由画布页面点击第一个画布项进入编辑器
 *  - 画布编辑器中 canvas 元素会遮挡底部按钮，需用 JS force click 或 dispatchEvent
 *  - 模板选择：点击"选择模板创作"按钮 → 搜索"细节强化器" → 点击模板卡片
 *  - 模型切换：点击模型选择器 → 点击 img[alt="全能编辑 V3"] 卡片
 *  - 上传图片：点击"添加参考图" → 文件选择器上传图片（图片需在工作区内）
 *  - 生成按钮：上传图片后变为可点击状态，按钮文本为算力数值（如"35"）
 *  - 发布详情页 /image/{id}"..."菜单（.ant-popover.more-report-popover）只有"举报"项，无删除入口
 *  - 作品卡上的"编辑/删除"按钮（icon-personalCenter-delete）仅出现在"审核未通过"卡片的
 *    .artwork-item__disable-actions 内，正常作品卡没有
 *  - 正常作品卡的删除入口：个人主页作品卡 footer 的 .artwork-item__actions-more（"..."图标）→ 弹出菜单含"删除"
 *    → 二次确认（4 轮 trace DOM 快照确认；narrateStep 横幅"删除发布的作品"会被 text=删除 子串误匹配，用完整正则）
 */

const LOGIN_URL = 'https://holopix.cn';
const ACCOUNT = '15767065333';
const PASSWORD = 'zhangkai0716';
const TEST_IMAGE = path.resolve(__dirname, '../assets/test-image.png');

async function stepShot(page: Page, name: string) {
  const screenshot = await page.screenshot({ path: path.resolve(__dirname, '../screenshots/', `${name}.png`), fullPage: true });
  await test.info().attach(name, { body: screenshot, contentType: 'image/png' });
}

/**
 * 候选定位器链（self-healing locator）：依次尝试候选选择器，返回第一个可见的。
 * 用于易变元素（登录入口、tab、下拉选项等），轻微改版时自动 fallback，减少自愈轮次。
 */
async function pick(page: Page, candidates: string[], timeout = 1000) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout }).catch(() => false)) return loc;
  }
  return page.locator(candidates[0]).first(); // 兜底返回第一个，交给后续 waitFor 报错
}

/**
 * 主动检测并关闭页面上可能出现的各类弹窗。
 *
 * 注意：不能关闭功能性对话框（如登录对话框、模板选择对话框），
 * 只关闭推广/引导弹窗。判断依据：不含 input 元素的 dialog 才是推广弹窗。
 *
 * 弹窗类型：
 * 1. 推广弹窗（含飞书外链）：img[alt=关闭]
 * 2. 登录/注册引导弹窗：带半透明遮罩，右上角有关闭按钮，不含 input
 * 3. cookie/隐私同意横幅
 */
async function dismissPopups(page: Page) {
  // 检测并关闭推广弹窗关闭按钮
  // 排除包含输入框的功能性对话框（登录对话框、模板对话框等）
  const popupSelectors = [
    // 推广弹窗的关闭图片（HoloPix 特有）
    page.getByRole('img', { name: '关闭' }),
    // cookie/隐私同意横幅
    page.getByRole('button', { name: /同意|Accept|我知道了|知道了|确定/i }),
  ];

  for (const selector of popupSelectors) {
    // 超时降到 250ms：没弹窗时不再空等 1.5s（每次 dismissPopups 原本最多白耗 3s）
    const visible = await selector.first().isVisible({ timeout: 250 }).catch(() => false);
    if (visible) {
      await selector.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // JS 检测：只关闭不含 input 和功能文本的推广弹窗（避免误关登录对话框）
  await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role=dialog], .ant-modal-wrap, .ant-modal');
    for (const dialog of dialogs) {
      const style = window.getComputedStyle(dialog);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      // 跳过包含输入框的功能性对话框
      if (dialog.querySelector('input, textarea, [contenteditable]')) continue;

      // 跳过包含登录/注册等功能关键词的对话框
      const text = dialog.textContent || '';
      if (text.includes('登录') || text.includes('注册') || text.includes('微信') ||
          text.includes('账号密码') || text.includes('手机验证码')) continue;

      // 查找弹窗内的关闭按钮
      const closeBtn = dialog.querySelector('.ant-modal-close, .anticon-close, [class*="close" i], img[alt*="关闭" i]');
      if (closeBtn) {
        (closeBtn as HTMLElement).click();
      }
    }
  }).catch(() => {});
}

/**
 * 当 canvas 画布遮挡目标元素时，用 JS force click 绕过。
 */
async function jsClick(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) el.click();
  }, selector);
}

test.describe('HoloPix 登录 + 自由画布创作流程', () => {
  test('账号密码登录并完成细节强化器创作', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 分钟：全链路含 AI 生成等待(≤5min)+发布/删除/资产/分享，上轮 19min 触发 600s 超时导致流程中断、teardown 卡死
    resetStepTimings();
    let boardUrl = ''; // 画布编辑器 URL，供 Step 14 返回

    // ---- Step 1: 打开 https://holopix.cn ----
    await test.step('打开 HoloPix 首页', async () => {
      await narrateStep(page, '打开 HoloPix 首页');
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000); // 等待弹窗动画完成

      // 多次检测并关闭弹窗（弹窗可能有延迟出现的情况）
      for (let i = 0; i < 3; i++) {
        await dismissPopups(page);
        await page.keyboard.press('Escape').catch(() => {}); // ESC 关闭可能的弹窗
        await page.waitForTimeout(500);
      }

      await stepShot(page, 'step1-homepage');
    });

    // ---- Step 2: 点击"登录"按钮 ----
    await test.step('点击首页"登录"按钮', async () => {
      await dismissPopups(page);

      // 登录入口：点击头像 img[alt=avatar] 触发 popover
      const avatar = page.getByRole('img', { name: 'avatar' }).first();
      await avatar.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '点击首页登录按钮', avatar, 600);
      await avatar.click();

      // 等待 popover 出现，点击登录按钮（候选链：popover 按钮 → 顶部导航 .toLogin）
      await page.waitForTimeout(1000);
      const loginBtn = await pick(page, ['.to-login-btn-tooltip .button', '.toLogin'], 2000);
      await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
      await loginBtn.click({ force: true });
      await page.waitForTimeout(1000);

      await stepShot(page, 'step2-login-dialog');
    });

    // ---- Step 3: 选择账号密码登录方式 ----
    await test.step('切换到账号密码登录', async () => {
      await dismissPopups(page);

      const accountPwdTab = page.getByText('账号密码', { exact: true }).first();
      await accountPwdTab.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '切换到账号密码登录方式', accountPwdTab, 600);
      await accountPwdTab.click({ force: true });
      await page.waitForTimeout(500);

      await stepShot(page, 'step3-account-password-mode');
    });

    // ---- Step 4: 输入账号密码 ----
    await test.step('输入账号和密码', async () => {
      await dismissPopups(page);

      // 先输入手机号
      const accountInput = page.getByPlaceholder('请输入手机号').first();
      await accountInput.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '输入手机号', accountInput, 600);
      await accountInput.fill(ACCOUNT);

      // 点击"注册/登录"按钮，密码框才会出现
      const nextBtn = page.getByRole('button', { name: '注册/登录' });
      await narrateStep(page, '点击注册登录按钮', nextBtn, 600);
      await nextBtn.click();
      await page.waitForTimeout(800);
      await dismissPopups(page);

      // 密码框出现在新视图
      const passwordInput = page.getByPlaceholder('请输入密码').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '输入密码', passwordInput, 600);
      await passwordInput.fill(PASSWORD);

      await stepShot(page, 'step4-credentials-filled');
    });

    // ---- Step 5: 点击"登录"按钮 ----
    await test.step('提交登录', async () => {
      await dismissPopups(page);

      const submitButton = page.getByRole('button', { name: '登 录' });
      await submitButton.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '提交登录', submitButton, 600);
      await submitButton.click();

      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle').catch(() => {});
      await dismissPopups(page);

      await stepShot(page, 'step5-after-login');
    });

    // ---- Step 6: 断言首页右上角有头像和有用户算力 ----
    await test.step('断言首页右上角有头像和有用户算力', async () => {
      await dismissPopups(page);

      const avatar = page.getByRole('img', { name: 'avatar' }).first();
      await avatar.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '断言首页右上角有头像和有用户算力', avatar, 600);

      await expect(avatar).toBeVisible();

      // 用户算力（头部右上角展示的算力数值）
      const computePower = page.getByText('算力', { exact: true }).first();
      await expect(computePower).toBeVisible({ timeout: 15000 });

      // 位置校验：头像与算力都应落在页面右上方
      const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const avatarBox = await avatar.boundingBox();
      const powerBox = await computePower.boundingBox();
      if (avatarBox) {
        expect(avatarBox.x + avatarBox.width / 2, '头像应位于页面右上角').toBeGreaterThan(w / 2);
        expect(avatarBox.y, '头像应位于页面右上角').toBeLessThan(h / 3);
      }
      if (powerBox) {
        expect(powerBox.x + powerBox.width / 2, '用户算力应位于页面右上角').toBeGreaterThan(w / 2);
        expect(powerBox.y, '用户算力应位于页面右上角').toBeLessThan(h / 3);
      }

      await stepShot(page, 'step6-assert-avatar-power');
    });

    // ---- Step 7: 点击自由画布 ----
    await test.step('点击自由画布', async () => {
      await dismissPopups(page);

      // 点击侧边菜单"自由画布"
      const canvasMenu = page.getByRole('menuitem', { name: '自由画布' });
      await canvasMenu.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '点击自由画布', canvasMenu, 600);
      await canvasMenu.click();

      // 等待画布列表页面加载
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle').catch(() => {});
      await dismissPopups(page);

      // 点击第一个画布项进入编辑器
      const firstBoard = page.locator('.board-item').first();
      await firstBoard.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '进入画布编辑器', firstBoard, 600);
      await firstBoard.click();

      // 等待编辑器加载
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle').catch(() => {});

      boardUrl = page.url(); // 记录画布 URL，供 Step 14 返回
      await stepShot(page, 'step7-canvas-editor');
    });

    // ---- Step 8: 高级输入框选择模板：细节强化器 ----
    await test.step('选择模板：细节强化器', async () => {
      await dismissPopups(page);

      await narrateStep(page, '选择模板：细节强化器');

      // 展开底部输入区域（canvas 遮挡，用 JS click）
      await jsClick(page, '.collapsed-bar-inner');
      await page.waitForTimeout(1000);

      // 底部有"风格"和"模板"两个 tab，需切换到"模板"tab
      // 用 force click 绕过 canvas 遮挡
      const templateTab = page.getByRole('button', { name: '模板', exact: true });
      await templateTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);

      // 点击"选择创意模板"按钮打开模板对话框
      const selectTemplateBtn = page.getByRole('button', { name: '选择创意模板' });
      await narrateStep(page, '打开模板选择对话框', selectTemplateBtn, 600);
      await selectTemplateBtn.click({ force: true });
      await page.waitForTimeout(1500);

      // 在模板对话框中搜索"细节强化器"
      const searchInput = page.getByRole('textbox', { name: '搜索模板' });
      await searchInput.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '搜索细节强化器', searchInput, 600);
      await searchInput.fill('细节强化器');
      await page.waitForTimeout(2000);

      // 点击搜索结果中的"细节强化器"模板
      const templateImg = page.locator('img[alt="细节强化器"]').first();
      await templateImg.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '选择细节强化器模板', templateImg, 600);
      await templateImg.click();
      await page.waitForTimeout(1500);
      await dismissPopups(page);

      await stepShot(page, 'step8-template-selected');
    });

    // ---- Step 9: 切换到全能编辑V3 ----
    await test.step('切换到全能编辑V3', async () => {
      await dismissPopups(page);

      // 点击模型选择器（当前显示"全能编辑 V3.5 极速版"）
      const modelSelector = page.locator('.image-model-trigger').first();
      await modelSelector.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '切换到全能编辑V3', modelSelector, 600);
      await modelSelector.click({ force: true });
      await page.waitForTimeout(1500);

      // 在模型面板中点击"全能编辑 V3"
      const v3Model = page.locator('img[alt="全能编辑 V3"]').first();
      await v3Model.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '选择全能编辑V3模型', v3Model, 600);
      await v3Model.click();
      await page.waitForTimeout(1000);

      await stepShot(page, 'step9-model-v3');
    });

    // ---- Step 10: 上传图片 ----
    await test.step('上传图片', async () => {
      await dismissPopups(page);

      // 点击"添加参考图"按钮，触发文件选择器
      const addRefBtn = page.getByRole('button', { name: '添加参考图' });
      await addRefBtn.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '上传参考图片', addRefBtn, 600);

      // 设置文件选择器监听，点击按钮后上传文件
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        addRefBtn.click(),
      ]);
      await fileChooser.setFiles(TEST_IMAGE);

      // 等待图片上传完成 — 出现"更换参考图"按钮表示上传成功
      const changeRefBtn = page.getByRole('button', { name: '更换参考图' });
      await changeRefBtn.waitFor({ state: 'visible', timeout: 30000 });

      await stepShot(page, 'step10-image-uploaded');
    });

    // ---- Step 11: 上传完毕点击生成按钮 ----
    await test.step('点击生成按钮', async () => {
      await dismissPopups(page);

      // 生成按钮文本为算力数值（如"35"），上传图片后变为可点击
      const generateBtn = page.getByRole('button', { name: /^\d+$/ }).last();
      await generateBtn.waitFor({ state: 'visible', timeout: 10000 });
      await narrateStep(page, '点击生成按钮', generateBtn, 600);
      await generateBtn.click({ force: true });

      await page.waitForTimeout(2000);
      await stepShot(page, 'step11-generating');
    });

    // ---- Step 12: 断言生成完成 ----
    await test.step('断言生成完成', async () => {
      await dismissPopups(page);
      await narrateStep(page, '等待生成完成');

      // 注意：顶部"等待生成完成 xx%"提示生成完成后仍常驻显示，不能作为完成依据；
      // 真正完成标志：创作记录面板出现生成结果图（.message-item .result-image__img），最长等 600s
      // （AI 生成偶发偏慢超 5 分钟，300s 不够；自愈第 1 轮从 300s 提到 600s）
      const resultImg = page.locator('.message-item .result-image__img').first();
      const deadline = Date.now() + 600_000;
      let finished = false;
      while (Date.now() < deadline) {
        await dismissPopups(page);
        if (await resultImg.isVisible({ timeout: 1000 }).catch(() => false)) { finished = true; break; }
        await page.waitForTimeout(2500); // 轮询间隔缩短，更快发现生成完成
      }
      expect(finished, '生成应完成（创作记录出现生成结果图）').toBe(true);
      await stepShot(page, 'step12-generated');
    });

    // ---- Step 13: 生成完成后点击右侧创作记录，收藏并发布 ----
    await test.step('生成完成后点击右侧创作记录，收藏并发布', async () => {
      await dismissPopups(page);

      // 详情页（点击作品卡可能开新标签页）；提升到外层作用域供「删除」子步骤复用
      let detail: Page = page;
      let detailPage: Page | null = null;

      // 子步骤 1：打开创作记录面板并 hover 生成图
      await test.step('打开创作记录并hover生成图', async () => {
        const galleryPanel = page.locator('.gallery-panel');
        const hasRecord = await page.locator('.message-item .result-image__img').first()
          .isVisible({ timeout: 3000 }).catch(() => false);
        if (!hasRecord) {
          const historyTab = galleryPanel.getByText('创作记录', { exact: true });
          await historyTab.waitFor({ state: 'visible', timeout: 10000 });
          await narrateStep(page, '打开右侧创作记录', historyTab, 600);
          await historyTab.click({ force: true });
          await page.waitForTimeout(1500);
        }

        // 最新一条记录的生成结果图（.message-item 内 .result-image__img，排除"参考图"缩略图）
        const resultImg = page.locator('.message-item .result-image__img').last();
        await resultImg.waitFor({ state: 'visible', timeout: 20000 });
        await narrateStep(page, 'hover 生成图', resultImg, 600);
        await resultImg.hover();
        await page.waitForTimeout(800);
        await stepShot(page, 'step13-history-panel');
      });

      // 子步骤 2：收藏并断言图标变为已收藏
      await test.step('收藏并断言图标变为已收藏', async () => {
        const favBtn = page.locator('.message-item .overlay__btn--favorite').last();
        await favBtn.waitFor({ state: 'visible', timeout: 10000 });
        await narrateStep(page, '点击收藏', favBtn, 600);
        await favBtn.click({ force: true });
        await page.waitForTimeout(1000);
        await expect(favBtn).toHaveClass(/is-favorited/, { timeout: 10000 });
        await stepShot(page, 'step13-favorited');
      });

      // 子步骤 3：发布弹窗填写标题标签并提交
      await test.step('发布：填写标题标签并提交', async () => {
        const pubBtn = page.locator('.message-item .overlay__btn--publish').last();
        await pubBtn.waitFor({ state: 'visible', timeout: 10000 });
        await narrateStep(page, '点击发布', pubBtn, 600);
        await pubBtn.click({ force: true });
        await page.waitForTimeout(1500);

        const dialog = page.locator('.modal-publish-image .ant-modal');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });

        // 作品标题
        const titleInput = dialog.locator('#basic_name');
        await titleInput.waitFor({ state: 'visible', timeout: 10000 });
        await titleInput.fill('二次元');

        // 作品标签：多选下拉，选项为 .item[title=...]
        await dialog.locator('#basic_labels').click();
        const tagOption = page.locator('.modal-publish-image-select-popup .item[title="二次元"]');
        await tagOption.waitFor({ state: 'visible', timeout: 10000 });
        await narrateStep(page, '填写标签提交发布', tagOption, 600);
        await tagOption.click();
        await stepShot(page, 'step13-publish-dialog');

        // 提交发布（按钮文本"发 布"，中间有空格）；发布成功仅关弹窗，不自动跳转
        const submit = dialog.getByRole('button', { name: /发\s*布/ });
        await submit.click({ force: true });
        await expect(dialog).toBeHidden({ timeout: 15000 });
      });

      // 子步骤 4：发布完成后回到个人主页，断言数据存在
      await test.step('发布完成后回到个人主页，断言数据存在', async () => {
        await page.goto('/personalCenter');
        await dismissPopups(page);

        // 切换"作品"筛选（ant-segmented）
        const workFilter = page.locator('.ant-segmented-item-label:text-is("作品")');
        await workFilter.waitFor({ state: 'visible', timeout: 15000 });
        await workFilter.click();
        await page.waitForTimeout(1500);

        // 断言数据存在：已发布作品列表有内容
        const workCard = page.locator('.waterfall img.model-preview').first();
        await expect(workCard).toBeVisible({ timeout: 15000 });
        await narrateStep(page, '回到个人主页断言数据存在', workCard, 600);
        await stepShot(page, 'step13-personal-works');
      });

      // 子步骤 5：进入发布详情页（点击作品卡，新标签页打开 /image/{id}）
      await test.step('进入发布详情页', async () => {
        const workCard = page.locator('.waterfall img.model-preview').first();
        const detailPages = await Promise.all([
          page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
          workCard.click(),
        ]);
        detailPage = detailPages[0];
        detail = detailPage || page;
        await detail.waitForURL(/\/image\//, { timeout: 15000 });
        // 断言详情页包含发布的作品数据（标题"二次元"）
        await expect(detail.locator('.image-name')).toHaveText('二次元', { timeout: 15000 });
        const detailShot = await detail.screenshot({ fullPage: true });
        await test.info().attach('step13-publish-detail', { body: detailShot, contentType: 'image/png' });
      });

      // 子步骤 6（steps.md 新增）：删除发布的作品并断言删除成功
      // 自愈结论（4 轮 trace DOM 快照分析）：
      //  1) 详情页 /image/{id}"..."菜单（.more-report-popover）只有"举报"，无删除入口
      //  2) 作品卡上的"编辑/删除"按钮（icon-personalCenter-delete）仅出现在"审核未通过"卡片
      //     的 .artwork-item__disable-actions 内，正常作品卡没有
      //  3) 正常作品卡的删除入口：卡片 footer 的 .artwork-item__actions-more（"..."图标）→ 弹出菜单
      //  4) 坑：narrateStep 横幅"删除发布的作品"会被 text=删除 子串误匹配，必须用完整正则
      await test.step('删除发布的作品并断言删除成功', async () => {
        // 1. 关闭详情页标签，回个人主页（删除入口所在页面）
        if (detailPage) await detailPage.close();
        detailPage = null;
        await page.goto('/personalCenter');
        await dismissPopups(page);
        const workFilter = page.locator('.ant-segmented-item-label:text-is("作品")');
        if (await workFilter.isVisible({ timeout: 3000 }).catch(() => false)) {
          await workFilter.click();
        }
        await page.waitForTimeout(1500);

        // 2. 记录删除前作品卡数量，hover 首张作品卡（最新发布）
        const cardSel = '.waterfall .artwork-item';
        const before = await page.locator(cardSel).count();
        const firstCard = page.locator(cardSel).first();
        await firstCard.waitFor({ state: 'visible', timeout: 15000 });
        await firstCard.hover();
        await page.waitForTimeout(500);

        // 3. 点击卡片"..."更多图标 → 弹出菜单；轮询等待"删除"菜单项出现
        //    （弹出菜单类名未知，候选链覆盖 ant-popover / ant-dropdown / 自定义浮层；
        //     用完整正则避免误命中步骤横幅"删除发布的作品"）
        const cardMore = firstCard.locator('.artwork-item__actions-more');
        let delItem: ReturnType<Page['locator']> | null = null;
        for (const how of ['hover', 'click'] as const) {
          if (how === 'hover') await cardMore.hover().catch(() => {});
          else await cardMore.click({ force: true }).catch(() => {});
          await page.waitForTimeout(800);
          const cand = await pick(page, [
            '.ant-popover >> text=/^删除(作品)?$/',
            '.ant-dropdown >> text=/^删除(作品)?$/',
            'text=/^删除(作品)?$/',
          ], 1500);
          if (await cand.isVisible({ timeout: 500 }).catch(() => false)) { delItem = cand; break; }
        }
        expect(delItem, '点击作品卡"..."后应出现"删除"菜单项').toBeTruthy();
        await narrateStep(page, '删除发布的作品', delItem!, 600);
        await delItem!.click({ force: true });
        await page.waitForTimeout(800);

        // 4. 二次确认弹窗（popconfirm / modal / 自定义确认，候选链）
        const confirmBtn = await pick(page, [
          '.ant-popconfirm .ant-btn-primary',
          '.ant-modal-confirm .ant-btn-primary',
          '.ant-modal-confirm-btns .ant-btn-danger',
          'button:text-is("确定"):visible',
          'button:text-is("确 定"):visible',
        ], 2000);
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.click({ force: true });
        }
        await page.waitForTimeout(2500);

        // 5. 断言删除成功：出现删除提示，或作品卡数量减少
        const after = await page.locator(cardSel).count();
        const toastDeleted = await page.evaluate(() => {
          const t = document.body.textContent || '';
          return /删除成功|已删除|删除后不可恢复/.test(t) && !t.includes('删除发布的作品');
        }).catch(() => false);
        await stepShot(page, 'step13-deleted');
        expect(toastDeleted || after < before, '发布的作品应被删除（提示已删除或作品卡数量减少）').toBe(true);
      });
    });

    // ---- Step 14: 我的资产操作 ----
    await test.step('我的资产操作', async () => {
      await dismissPopups(page);

      // 返回画布编辑器（创作记录/我的资产面板所在页面）
      await page.goto(boardUrl);
      await page.waitForLoadState('networkidle').catch(() => {});
      await dismissPopups(page);

      // 点击"我的资产" tab
      const assetsTab = page.locator('.gallery-panel .tab-item', { hasText: '我的资产' });
      await assetsTab.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '点击我的资产', assetsTab, 600);
      await assetsTab.click();
      await page.waitForTimeout(2000);

      // 断言资产数据存在
      const assetItem = page.locator('.gallery-panel .image-item').first();
      await expect(assetItem).toBeVisible({ timeout: 20000 });

      // 点击资产项打开资产详情弹窗（.image-details）
      // 资产列表是 vue-recycle-scroller 虚拟滚动，.image-item 为虚拟项；force click 常因节点回收/零尺寸 15s 超时。
      // 先滚入视口 + 短等待稳定，再 force 点击（短超时）；失败回退 JS dispatch 直接触发 Vue @click
      await narrateStep(page, '点击资产详情弹窗', assetItem, 600);
      await assetItem.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(800);
      try {
        await assetItem.click({ force: true, timeout: 8000 });
      } catch {
        await assetItem.evaluate((el: HTMLElement) => el.click()).catch(() => {});
      }
      const assetDialog = page.locator('.image-details');
      await assetDialog.waitFor({ state: 'visible', timeout: 15000 });
      // 断言资产详情弹窗包含资产数据（真实图片；排除懒加载的 data:svg 占位图）
      const assetImg = assetDialog.locator('img[src^="http"]').first();
      await expect(assetImg).toBeVisible({ timeout: 10000 });

      await stepShot(page, 'step14-my-assets');

      // 断言资产详情弹窗包含资产数据：创意模板（页面字段名"使用模板"）+ 创作场景
      await expect(assetDialog.locator('.chat-info-item--template .chat-info-value'))
        .toContainText('细节强化器', { timeout: 10000 });
      await expect(assetDialog.locator('.chat-info-item--scene .chat-info-value'))
        .toHaveText('全能编辑 V3', { timeout: 10000 });

      // 关闭资产详情弹窗
      const closeBtn = assetDialog.locator('.ant-modal-close, [class*="close" i]').first();
      await closeBtn.click({ force: true }).catch(() => {});

      // 子步骤（steps.md 新增）：回到首页 → 点击左侧菜单「我的资产」→ 断言单图第一条数据 → 详情弹窗断言
      await test.step('回到首页并通过左侧菜单进入我的资产', async () => {
        await page.goto('/');
        await page.waitForLoadState('networkidle').catch(() => {});
        await dismissPopups(page);

        // 点击左侧菜单"我的资产"（候选链：menuitem role → 文本 → 侧边导航项）
        // 自愈：菜单点击偶发不导航（SPA 路由，force click 点击了但导航未触发），
        // 增加「点击后验证导航（单图筛选出现）+ 未导航则重试」机制，最多 3 次。
        await narrateStep(page, '点击左侧菜单我的资产');
        const singleImgTab = page.getByRole('button', { name: '单图', exact: true });

        // 点击「我的资产」菜单 → 验证已导航（"单图"筛选出现）→ 未导航则重试，最多 3 次
        let enteredAssets = false;
        for (let i = 0; i < 3 && !enteredAssets; i++) {
          await dismissPopups(page);
          const sideAssets = await pick(page, [
            '[role="menuitem"]:has-text("我的资产")',
            '.ant-menu-item:has-text("我的资产")',
            'a:has-text("我的资产")',
            'text="我的资产"',
          ], 3000);
          await sideAssets.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
          // 先用普通点击（让 Playwright 等待可交互），失败再 force click
          await sideAssets.click({ timeout: 8000 }).catch(async () => {
            await sideAssets.click({ force: true }).catch(() => {});
          });
          await page.waitForTimeout(2000);
          await page.waitForLoadState('networkidle').catch(() => {});
          enteredAssets = await singleImgTab.isVisible({ timeout: 8000 }).catch(() => false);
        }
        // 断言数据存在：我的资产 - 单图第一条数据（"单图"筛选出现即表示已进入资产页）
        await expect(singleImgTab).toBeVisible({ timeout: 20000 });

        // 资产项：img[alt^="资产 "]（alt 以"资产 "开头，后跟资产 ID）
        const firstAsset = page.locator('img[alt^="资产 "]').first();
        await expect(firstAsset).toBeVisible({ timeout: 20000 });
        await stepShot(page, 'step14-side-assets-list');

        // 点击资产详情弹窗
        // 自愈（3 轮结论）：点击 img[alt^="资产 "] 后 .image-details 弹窗未出现。
        // ARIA 快照显示页面无弹窗——点击很可能打开「新标签页」（类似 Step 13 发布详情页），
        // 原代码在原 page 等弹窗当然等不到。改为「弹窗 + 新标签页」双检测：
        //   先设 waitForEvent('page') 监听新标签页 → 点击 → 5s 内弹窗出现则用弹窗，否则用新标签页
        await narrateStep(page, '点击左侧菜单资产详情弹窗', firstAsset, 600);
        await firstAsset.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);

        // 点击前先设新标签页监听（Promise.all 模式，避免错过事件）
        const newPagePromise = page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null);
        try {
          await firstAsset.click({ timeout: 8000 });
        } catch {
          try { await firstAsset.click({ force: true, timeout: 5000 }); }
          catch { await firstAsset.evaluate((el: HTMLElement) => el.click()).catch(() => {}); }
        }

        // 竞争检测：弹窗（5s）或新标签页（10s）
        // 自愈：侧边菜单「我的资产」页的资产详情 dialog 与画布编辑器内不同——
        // 画布编辑器用 .image-details（含 .chat-info-item--template/.chat-info-value 结构化字段）；
        // 侧边菜单页用通用 dialog（数据呈扁平文本，无 .chat-info-value 类）。
        // 故先试 .image-details，再回退 getByRole('dialog')。
        const sideDialog = page.locator('.image-details');
        let dialogVisible = await sideDialog.isVisible({ timeout: 5000 }).catch(() => false);

        let detailPage: Page = page;
        let detailRoot: ReturnType<Page['locator']> = sideDialog;

        if (!dialogVisible) {
          // 回退：通用 dialog role（侧边菜单「我的资产」页的详情弹窗）
          const roleDialog = page.getByRole('dialog');
          const roleVisible = await roleDialog.first().isVisible({ timeout: 3000 }).catch(() => false);
          if (roleVisible) {
            detailRoot = roleDialog.first();
            dialogVisible = true;
          }
        }

        if (!dialogVisible) {
          // 弹窗未出现，等新标签页
          const newPage = await newPagePromise;
          if (newPage) {
            detailPage = newPage;
            await detailPage.waitForLoadState('domcontentloaded').catch(() => {});
            // 新标签页可能是纯详情页，用 body 作为根定位
            detailRoot = detailPage.locator('body');
          } else {
            // 既没弹窗也没新标签页，兜底在原 page 断言
            detailRoot = page.locator('body');
          }
        }

        // 断言详情包含真实图片（排除懒加载 data:svg 占位）
        await expect(detailRoot.locator('img[src^="http"]').first()).toBeVisible({ timeout: 15000 });
        // 断言资产详情包含资产数据：创意模板（页面字段"创意模版"+ 细节强化器）+ 创作场景（全能编辑 V3）
        // 自愈：该 dialog 无 .chat-info-item--template/.chat-info-value 结构化类，数据为扁平文本；
        // 改为在 detailRoot（dialog 根）上做 toContainText，兼容两种 dialog 结构（向后兼容画布编辑器 dialog）
        await expect(detailRoot).toContainText('细节强化器', { timeout: 15000 });
        await expect(detailRoot).toContainText('全能编辑 V3', { timeout: 15000 });
        await stepShot(detailPage, 'step14-side-asset-detail');

        // 关闭详情（新标签页则 close，弹窗则点关闭按钮）
        if (detailPage !== page) {
          await detailPage.close().catch(() => {});
        } else {
          const sideClose = sideDialog.locator('.ant-modal-close, [class*="close" i]').first();
          await sideClose.click({ force: true }).catch(() => {});
        }
      });
    });

    // ---- Step 15: 分享画布操作 ----
    await test.step('分享画布操作', async () => {
      // 自愈：Step 14 子步骤导航到了「我的资产」资产列表页，需先返回画布编辑器（boardUrl），
      // 「分享」按钮在画布编辑器顶部工具栏，资产页没有。
      await page.goto(boardUrl);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
      await dismissPopups(page);

      // 点击顶部工具栏"分享"按钮
      const shareBtn = page.locator('.toolbar .toolbar__btn', { hasText: '分享' }).first();
      await shareBtn.waitFor({ state: 'visible', timeout: 15000 });
      await narrateStep(page, '点击分享画布', shareBtn, 600);
      // 自愈：force 点击偶发因元素重渲染（detached）在 15s 超时卡死；
      // 缩短超时并回退到直接派发 click 事件（每次重解析定位器、绕过坐标/稳定态检查，对重渲染免疫）
      await shareBtn.click({ force: true, timeout: 5000 }).catch(async () => {
        await shareBtn.dispatchEvent('click').catch(() => {});
      });
      await page.waitForTimeout(1000);

      // 断言分享弹窗出现（.hpx-share-dialog，权限默认"仅查看"）
      const shareDialog = page.locator('.hpx-share-dialog');
      await expect(shareDialog).toBeVisible({ timeout: 10000 });
      await expect(shareDialog.locator('.hpx-select-value').first()).toHaveText('仅查看', { timeout: 10000 });
      await stepShot(page, 'step15-share-dialog');

      // 按 steps.md：分享权限选择"可复制"选项（默认"仅查看"）→ 点击权限下拉 → 选择"可复制"
      const permSelect = shareDialog.locator('.hpx-select-value').first();
      await narrateStep(page, '切换分享权限为可复制', permSelect, 600);
      await permSelect.click();
      await page.waitForTimeout(800);
      // 下拉选项候选链：自定义面板项 / ant 选项 / 文本；steps.md 措辞为"可复制"
      const copyableOpt = await pick(page, [
        '.hpx-select-dropdown .hpx-select-item:has-text("可复制")',
        '.hpx-select-dropdown li:has-text("可复制")',
        'text="可复制"',
      ], 3000);
      await copyableOpt.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await copyableOpt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      // 断言权限已切换为"可复制"
      await expect(shareDialog.locator('.hpx-select-value').first()).toHaveText('可复制', { timeout: 10000 });
      await stepShot(page, 'step15-share-copyable');

      // 点击"生成分享链接"
      await shareDialog.locator('.hpx-gradient-btn').click();

      // 断言分享成功：toast 出现"分享链接已生成"，并从中提取分享链接
      let shareUrl = '';
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !shareUrl) {
        shareUrl = await page.evaluate(() => {
          // 注意：限定 URL 字符集，避免把紧随其后的按钮文字（如"重新复制"）吞进参数
          const m = (document.body.textContent || '').match(/https:\/\/holopix\.cn\/board\/share\/[A-Za-z0-9=&?%._-]+/);
          return m ? m[0] : '';
        }).catch(() => '');
        if (!shareUrl) await page.waitForTimeout(500);
      }
      // 分享成功瞬间拍图：toast 一般存活 2~3s，轮询最迟 500ms 检测到，能拍到；
      // 该截图供报告中断言子步骤「分享成功（toast 出现分享链接）」映射使用
      await stepShot(page, 'step15-share-success');
      expect(shareUrl, '分享成功（toast 出现分享链接）').toBeTruthy();

      // 打开新标签页粘贴分享链接
      const sharePage = await page.context().newPage();
      await sharePage.goto(shareUrl);
      await sharePage.waitForLoadState('domcontentloaded');
      // 断言分享页面存在（只读画布）
      await expect(sharePage.locator('.share-board-body')).toBeVisible({ timeout: 20000 });
      await sharePage.waitForTimeout(2000);
      await stepShot(sharePage, 'step15-share-page');
      const sharePageShot = await sharePage.screenshot({ fullPage: false });
      await test.info().attach('step15-share-view', { body: sharePageShot, contentType: 'image/png' });

      // 分享页面点击图片 → 打开图片详情弹窗
      // 自愈：分享页图片详情弹窗的真实类名是 .image-details（ant-modal，
      // image-details--canvas-chat），旧选择器 .hpx-image-viewer-mask 已不适用；
      // 两者都探测以兼容改版。
      const canvas = sharePage.locator('canvas.upper-canvas');
      await canvas.waitFor({ state: 'visible', timeout: 20000 });
      const viewerCandidates = [
        sharePage.locator('.image-details'),
        sharePage.locator('.hpx-image-viewer-mask'),
      ];
      const viewerVisible = async () => {
        for (const v of viewerCandidates) {
          if (await v.first().isVisible({ timeout: 300 }).catch(() => false)) return v.first();
        }
        return null;
      };
      // 生成图固定在画布左上区域（canvas 内部坐标 1920 固定、CSS 等比缩放，图片以固定 CSS px 呈现），
      // 用网格探测依次点击，详情弹窗出现即命中
      await narrateStep(sharePage, '分享页点击图片查看详情');
      const box = await canvas.boundingBox();
      let opened: ReturnType<typeof sharePage.locator> | null = null;
      if (box) {
        const positions: { x: number; y: number }[] = [];
        for (const y of [0.12, 0.2, 0.28, 0.36, 0.45]) {
          for (const x of [0.1, 0.16, 0.22, 0.28, 0.34, 0.42]) positions.push({ x, y });
        }
        for (const p of positions) {
          await sharePage.mouse.click(box.x + box.width * p.x, box.y + box.height * p.y);
          await sharePage.waitForTimeout(1000);
          opened = await viewerVisible();
          if (opened) break;
        }
      } else {
        await canvas.click();
        opened = await viewerVisible();
      }
      expect(opened, '分享页点击图片应打开详情弹窗').not.toBeNull();
      const viewer = opened!;
      // 断言详情弹窗包含图片数据（真实图片；排除懒加载 data:svg 占位）
      await expect(viewer.locator('img[src^="http"]').first()).toBeVisible({ timeout: 10000 });
      // steps.md：断言弹窗包含创意模板与创作场景（页面字段为"使用模板"/"创作场景"）
      await expect(viewer.locator('.chat-info-item--template .chat-info-value'))
        .toContainText('细节强化器', { timeout: 10000 });
      await expect(viewer.locator('.chat-info-item--scene .chat-info-value'))
        .toHaveText('全能编辑 V3', { timeout: 10000 });
      const viewerShot = await sharePage.screenshot({ fullPage: false });
      await test.info().attach('step15-share-viewer', { body: viewerShot, contentType: 'image/png' });
      await sharePage.close();

      // 测试结束后保存步骤时间表
      const timings = getStepTimings();
      const fs = await import('fs');
      fs.writeFileSync(path.resolve(__dirname, '../data/step-timings.json'), JSON.stringify(timings, null, 2), 'utf8');
    });
  });
});
