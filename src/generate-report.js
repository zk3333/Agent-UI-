// 自定义 HTML 报告生成器
// 直接解析原生 Playwright HTML 报告内嵌的数据（含每个步骤/子操作的 ANSI 源码片段），
// 生成「紫白主题 + 步骤截图 + 可展开源代码」的自包含报告。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const reportDir = path.join(ROOT, 'playwright-report');
const outputFile = path.join(reportDir, 'custom-report.html');
const screenshotsDir = path.join(ROOT, 'screenshots');
const dataDir = path.join(ROOT, 'data');

// 注意：不在脚本开头清理 playwright-report/data/，因为附件（视频、截图）文件存储在该目录中。
// 清理操作已移至报告生成完成后执行（见文件末尾）。

// ── 1. 解析原生报告内嵌数据 ──
function unzip(buf) {
  const entries = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) return entries;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < cdCount; n++) {
    const method = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.slice(cdOff + 46, cdOff + 46 + nameLen).toString();
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function loadNativeReport() {
  const htmlPath = path.join(reportDir, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const marker = '<template id="playwrightReportBase64">';
  const mi = html.indexOf(marker);
  if (mi === -1) throw new Error('未找到原生报告内嵌数据 (playwrightReportBase64)');
  const start = mi + marker.length;
  const end = html.indexOf('</template>', start);
  let value = html.slice(start, end).trim();
  const b64idx = value.indexOf('base64,');
  if (b64idx >= 0) value = value.slice(b64idx + 7);
  const zip = Buffer.from(value, 'base64');
  const entries = unzip(zip);
  const report = JSON.parse(entries['report.json'].toString('utf8'));
  const fileId = report.files[0].fileId;
  const fileData = JSON.parse(entries[fileId + '.json'].toString('utf8'));
  return { report, fileData, fileId };
}

const { report, fileData } = loadNativeReport();
const fileInfo = report.files[0];
const test = fileData.tests[0];
const result = test.results[0];

const testStatus = result.status || 'unknown';
const totalDuration = result.duration || 0;
const startTime = result.startTime;
const retryCount = result.retry || 0;
const errors = result.errors || [];
const steps = result.steps || [];
const attachments = result.attachments || [];

const projectName = test.projectName || 'chromium';
const testLocation = test.location || {};
const testPath = (test.path || []).join(' › ');

// 测试中若打开过新标签页（如发布详情页 / 分享页），Playwright 会按 page 分别出视频：
// video.webm = 主页面完整录像，video-N.webm = 新标签页录像（仅几秒）。
// 报告要展示完整流程 → 以体积最大者为主录像，其余分页录像按录制时间顺序**拼接**到主录像之后；
// 否则分享页的「图片详情弹窗」等只存在于分页短视频里，主视频看不到（截图有、视频没有）。
const videoAtts = attachments
  .filter(a => a.contentType === 'video/webm' && a.path)
  .map(a => {
    const p = path.join(reportDir, a.path);
    let size = 0, mtime = 0;
    try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch {}
    return { att: a, p, size, mtime };
  })
  .sort((x, y) => y.size - x.size);
const videoAttachment = videoAtts[0]?.att;
const videoPath = videoAttachment ? videoAttachment.path : '';
// 主录像在前，其余分页录像按录制时间（mtime）升序追加，形成「主流程 → 分页操作」的完整录像
const extraVideoFiles = videoAtts.slice(1).sort((x, y) => x.mtime - y.mtime).map(v => v.p);
const extraVideoAttachments = attachments.filter(a => a.contentType === 'video/webm' && a !== videoAttachment);
const visibleAttachments = attachments.filter(a => a.contentType !== 'video/webm' || a === videoAttachment);

// 依据 data/steps.md 自动推理报告标题：扫描关键步骤关键字，概括执行全过程
function inferReportTitle() {
  let text = '';
  try { text = fs.readFileSync(path.join(dataDir, 'steps.md'), 'utf8'); } catch { return null; }
  if (!text.trim()) return null;

  const has = re => re.test(text);
  const model = has(/全能编辑\s*V3/) ? '(全能编辑 V3)' : '';
  // long = 完整环节名，short = 环节多了之后用于压缩的短名，model = 该环节可附带模型后缀
  const segs = [];
  if (has(/登录/)) segs.push({ long: has(/账号密码/) ? '账号密码登录' : '登录', short: '登录' });
  if (has(/细节强化器/) || has(/自由画布/)) segs.push({ long: '细节强化器创作', short: '创作', model: true });
  if (has(/发布/)) segs.push({ long: '作品发布', short: '发布' });
  if (has(/我的资产/)) segs.push({ long: '资产查看', short: '资产' });
  if (has(/分享/)) segs.push({ long: '画布分享', short: '分享' });

  const withModel = s => (s.model ? s.long + model : s.long);
  // 环节 ≥4 个时标题会折行：只保留前两段全称（省略模型等细节），其余压成「发布/资产/分享」
  if (segs.length >= 4) {
    return [segs[0].long, segs[1].long, segs.slice(2).map(s => s.short).join('/')].join(' → ');
  }
  if (segs.length >= 2) return segs.map(withModel).join(' → ');
  if (segs.length === 1) return withModel(segs[0]);
  const h1 = (text.match(/^#\s+(.+)$/m) || [])[1];
  return h1 ? h1.trim() : null;
}

const reportTitle = inferReportTitle() || test.title;

// ── 2. ANSI → HTML（还原原生报告的语法高亮） ──
const ANSI_COLORS = {
  90: '#8b86a3', 36: '#0891b2', 32: '#16a34a', 33: '#a16207',
  31: '#dc2626', 35: '#c026d3', 34: '#2563eb',
};

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ansiToHtml(text) {
  const parts = String(text || '').split(/\u001b\[(\d+)m/);
  let html = '';
  let color = null;
  let bold = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const t = escapeHtml(parts[i]);
      if (t) {
        const styles = [];
        if (color) styles.push('color:' + color);
        if (bold) styles.push('font-weight:700');
        html += styles.length ? `<span style="${styles.join(';')}">${t}</span>` : t;
      }
    } else {
      const code = parseInt(parts[i], 10);
      if (code === 0) { color = null; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = null;
      else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
    }
  }
  return html;
}

// ── 3. 工具函数 ──
function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(1);
  return `${m}m ${s}s`;
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 解析自愈日志时间戳。
 * 兼容历史数据：无时区标记（既无 Z 也无 ±hh:mm）的时间按 UTC 处理，
 * 否则 new Date() 会按本地时区解析，导致报告时间比真实时间早 8 小时（UTC 墙钟被当成本地时间）。
 */
function parseLogTs(ts) {
  if (!ts) return null;
  let s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const kb = bytes / 1024;
  return kb > 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
}

// 步骤标题 → 截图（attach 名）。value 支持三种形式：
//   'name'                    单张
//   ['name1', 'name2']        多张（按序展示）
//   { file: 'name', label: '说明' }  带说明文字的单张（数组内可混用）
// 映射对**任意层级**的 test.step 标题生效（含嵌套子步骤）
const stepScreenshotMap = {
  '打开 HoloPix 首页': 'step1-homepage',
  '点击首页"登录"按钮': 'step2-login-dialog',
  '切换到账号密码登录': 'step3-account-password-mode',
  '输入账号和密码': 'step4-credentials-filled',
  '提交登录': 'step5-after-login',
  '断言首页右上角有头像和有用户算力': 'step6-assert-avatar-power',
  '点击自由画布': 'step7-canvas-editor',
  '选择模板：细节强化器': 'step8-template-selected',
  '切换到全能编辑V3': 'step9-model-v3',
  '上传图片': 'step10-image-uploaded',
  '点击生成按钮': 'step11-generating',
  '断言生成完成': 'step12-generated',
  // Step 13 的截图挂在各嵌套子步骤上（更细致），顶层不重复展示
  '打开创作记录并hover生成图': { file: 'step13-history-panel', label: '创作记录面板 · hover 生成图' },
  '收藏并断言图标变为已收藏': { file: 'step13-favorited', label: '收藏后 · 图标变为已收藏' },
  '发布：填写标题标签并提交': { file: 'step13-publish-dialog', label: '发布弹窗 · 标题「二次元」+ 标签「二次元」' },
  '发布完成后回到个人主页，断言数据存在': { file: 'step13-personal-works', label: '个人主页 · 已发布作品列表' },
  '进入发布详情页': { file: 'step13-publish-detail', label: '发布详情页 · 标题「二次元」' },
  '删除发布的作品并断言删除成功': { file: 'step13-deleted', label: '删除后 · 详情页不可用/已删除提示' },
  '我的资产操作': 'step14-my-assets',
  '分享画布操作': ['step15-share-dialog', { file: 'step15-share-copyable', label: '分享权限切换为「可复制」' }, { file: 'step15-share-viewer', label: '分享页 · 图片详情弹窗' }],
  // expect 断言自动生成的子步骤（标题=断言消息）也可配截图
  '分享页点击图片应打开详情弹窗': { file: 'step15-share-viewer', label: '分享页 · 图片详情弹窗' },
  '分享成功（toast 出现分享链接）': { file: 'step15-share-success', label: '分享成功 toast' },
};

// 失败时 Playwright 自动保留的整页截图（attachments 里 name='screenshot'）
function failureScreenshot() {
  const att = attachments.find(a => a.name === 'screenshot' && a.contentType && a.contentType.startsWith('image/') && a.path);
  if (att && att.path) {
    const p = path.join(reportDir, att.path);
    if (fs.existsSync(p)) return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  }
  return null;
}

function screenshotsForStep(stepTitle) {
  const v = stepScreenshotMap[stepTitle];
  if (!v) return [];
  const items = Array.isArray(v) ? v : [v];
  return items
    .map(item => {
      const name = typeof item === 'string' ? item : item.file;
      const label = typeof item === 'string' ? '' : (item.label || '');
      if (!name) return null;
      let src = null;
      const att = attachments.find(a => a.name === name);
      if (att && att.path) {
        const p = path.join(reportDir, att.path);
        if (fs.existsSync(p)) src = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
      }
      if (!src) {
        const p2 = path.join(screenshotsDir, `${name}.png`);
        if (fs.existsSync(p2)) src = `data:image/png;base64,${fs.readFileSync(p2).toString('base64')}`;
      }
      return src ? { src, label, name } : null;
    })
    .filter(Boolean);
}

// ── 4. 渲染步骤树 ──
// 仅当节点自身或子树含「源码 / 截图」时才可展开；否则渲染为纯静态行（无箭头、无点击）
function subtreeHasContent(step, isTop, shotCache) {
  // 任意层级均可挂截图（嵌套子步骤也显示「步骤截图」字段）
  if (screenshotsForStep(step.title).length) return true;
  if (step.snippet) return true;
  const children = Array.isArray(step.steps) ? step.steps : [];
  return children.some(c => subtreeHasContent(c, false, shotCache));
}

const HOOK_RE = /^(Before|After)\s+Hooks?$/i;

function renderStep(step, level, num, inheritedShot) {
  const isTop = level === 0;
  const children = Array.isArray(step.steps) ? step.steps : [];
  let shots = screenshotsForStep(step.title); // 任意层级均可有截图
  // 失败兜底：带 error 的步骤若没有配置截图，自动挂「失败时页面截图」
  if (!shots.length && step.error) {
    const fail = failureScreenshot();
    if (fail) shots = [{ src: fail, label: '失败时页面截图', name: 'failure' }];
  }
  // 通用继承：中文语义命名的子步骤（test.step / expect 断言消息）无映射时，
  // 自动继承上级步骤最近一张截图——新增断言无需再逐个补映射
  if (!shots.length && level > 0 && inheritedShot && /[\u4e00-\u9fa5]/.test(step.title)) {
    shots = [{ src: inheritedShot, label: '页面状态（继承上级步骤截图）', name: 'inherited' }];
  }
  const lastShot = shots.length ? shots[shots.length - 1].src : inheritedShot;
  const expandable = subtreeHasContent(step, isTop, null);
  const isHook = isTop && HOOK_RE.test(step.title);
  const duration = formatDuration(step.duration);
  const loc = step.location ? `${step.location.file}:${step.location.line}` : '';
  const subtitleHtml = step.subtitle ? `<span class="s-subtitle">${escapeHtml(step.subtitle)}</span>` : '';
  const locHtml = loc ? `<span class="s-loc">${escapeHtml(loc)}</span>` : '';

  const snippetHtml = step.snippet
    ? `<pre class="code"><code>${ansiToHtml(step.snippet)}</code></pre>`
    : '';
  const shotHtml = shots.length
    ? `<details class="shot-field">
        <summary>
          <svg class="sf-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="sf-label">步骤截图</span>
          <span class="sf-hint">${shots.length > 1 ? `${shots.length} 张 · 展开查看` : '展开查看'}</span>
        </summary>
        ${shots.map((s, i) => `
        <figure class="shot">
          ${s.label ? `<figcaption class="shot-caption">${escapeHtml(s.label)}</figcaption>` : ''}
          <img src="${s.src}" alt="${escapeHtml(s.label || `${step.title} · 截图${shots.length > 1 ? ` ${i + 1}` : ''}`)}" loading="lazy" onclick="openLightbox(this.src, this.alt)" />
          <figcaption class="shot-tip">点击图片可放大预览</figcaption>
        </figure>`).join('')}
      </details>`
    : '';

  const childHtml = children
    .map((c, i) => renderStep(c, level + 1, num ? `${num}.${i + 1}` : String(i + 1), lastShot))
    .join('');

  const listHtml = (shotHtml || childHtml)
    ? `<div class="s-children">${shotHtml}${childHtml}</div>`
    : '';

  const bodyHtml = (snippetHtml || listHtml)
    ? `<div class="s-body">${snippetHtml}${listHtml}</div>`
    : '';

  const badge = isHook
    ? `<span class="s-badge hook" title="${escapeHtml(step.title)}">⚙</span>`
    : (num ? `<span class="s-badge">${escapeHtml(num)}</span>` : '');

  const chevron = expandable
    ? `<svg class="s-chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : '';

  const cls = [
    's', `s-lv${level}`,
    expandable ? 'expandable' : 'static',
    isHook ? 'is-hook' : '',
    step.skipped ? 'skipped' : '',
  ].filter(Boolean).join(' ');

  const headerInner = `
      ${chevron}
      ${badge}
      <span class="s-main">
        <span class="s-row1">
          <span class="s-title">${escapeHtml(step.title)}</span>
          ${subtitleHtml}
        </span>
        ${locHtml ? `<span class="s-row2">${locHtml}</span>` : ''}
      </span>
      <span class="s-dur">${duration}</span>`;

  if (!expandable) {
    return `<div class="${cls}"><div class="s-head">${headerInner}</div></div>`;
  }
  return `<div class="${cls}">
    <div class="s-head" onclick="toggleStep(this)">${headerInner}</div>
    ${bodyHtml}
  </div>`;
}

function generateStepsHTML() {
  let mainIdx = 0;
  return steps.map(s => {
    const isHook = HOOK_RE.test(s.title);
    const num = isHook ? null : String(++mainIdx);
    return renderStep(s, 0, num);
  }).join('');
}

// ── 5. 其它区块 ──
function generateAttachmentsHTML() {
  if (!visibleAttachments.length) return '<div class="empty">无附件</div>';
  return `<div class="att-list">${visibleAttachments.map(att => {
    const icon = att.contentType?.startsWith('image/') ? '🖼️'
      : att.contentType?.startsWith('video/') ? '🎬'
      : att.name === 'trace' ? '🔍' : '📄';
    let size = '';
    if (att.path) {
      const p = path.join(reportDir, att.path);
      if (fs.existsSync(p)) size = humanSize(fs.statSync(p).size);
    }
    return `<div class="att">
      <span class="att-icon">${icon}</span>
      <span class="att-name">${escapeHtml(att.name)}</span>
      <span class="att-type">${escapeHtml(att.contentType || '')}</span>
      ${size ? `<span class="att-size">${size}</span>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function generateErrorsHTML() {
  if (!errors.length) return '';
  return `<section class="card error-card">
    <h2><span class="h-ico">${ICONS.error}</span>错误信息</h2>
    ${errors.map(err => `<pre class="error-stack">${escapeHtml(err.message || JSON.stringify(err))}${err.stack ? '\n\n' + escapeHtml(err.stack) : ''}</pre>`).join('')}
  </section>`;
}

// ── 耗时分析图表（纯 SVG / CSS，无外部依赖） ──
const CHART_COLORS = ['#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#e9e5f8'];

function generateChartsHTML() {
  const mainSteps = steps.filter(s => !HOOK_RE.test(s.title));
  if (!mainSteps.length) return '';

  const runStart = new Date(startTime).getTime();
  const rows = mainSteps.map((s, i) => {
    const st = s.startTime ? new Date(s.startTime).getTime() : runStart;
    const offset = Math.max(0, st - runStart);
    const duration = s.duration || 0;
    return { idx: i + 1, title: s.title, duration, offset, end: offset + duration };
  });
  const span = Math.max(totalDuration, ...rows.map(r => r.end)) || 1;

  // 环形图：耗时 Top5 + 其他
  const sorted = [...rows].sort((a, b) => b.duration - a.duration);
  const TOP_N = 5;
  const items = sorted.slice(0, TOP_N).map((r, i) => ({
    label: `${r.idx}. ${r.title}`, value: r.duration, color: CHART_COLORS[i],
  }));
  const restSum = sorted.slice(TOP_N).reduce((n, r) => n + r.duration, 0);
  if (restSum > 0) items.push({ label: '其他步骤', value: restSum, color: CHART_COLORS[5] });
  const sum = items.reduce((n, it) => n + it.value, 0) || 1;

  const R = 68, CX = 90, CY = 90, SW = 24;
  const CIRC = 2 * Math.PI * R;
  let acc = 0;
  const arcs = items.map(it => {
    const len = (it.value / sum) * CIRC;
    const seg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${it.color}" stroke-width="${SW}" `
      + `stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" `
      + `transform="rotate(-90 ${CX} ${CY})"><title>${escapeHtml(it.label)} · ${formatDuration(it.value)}</title></circle>`;
    acc += len;
    return seg;
  }).join('');

  const legend = items.map(it => `<li>
      <span class="lg-dot" style="background:${it.color}"></span>
      <span class="lg-label" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</span>
      <span class="lg-val">${formatDuration(it.value)} · ${((it.value / sum) * 100).toFixed(1)}%</span>
    </li>`).join('');

  const wf = rows.map(r => {
    const left = (r.offset / span) * 100;
    const width = Math.max((r.duration / span) * 100, 0.5);
    return `<div class="wf-row">
      <span class="wf-name" title="${escapeHtml(r.title)}"><i>${r.idx}</i><span class="wf-txt">${escapeHtml(r.title)}</span></span>
      <span class="wf-track"><span class="wf-bar" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></span></span>
      <span class="wf-dur">${formatDuration(r.duration)}</span>
    </div>`;
  }).join('');

  // 步骤较多时：限高内部滚动（不展开全部）
  const VISIBLE_LIMIT = 14;
  const scrollable = rows.length > VISIBLE_LIMIT;

  return `<section class="card">
    <h2><span class="h-ico">${ICONS.clock}</span>耗时分析<span class="h-hint">单位：毫秒/秒</span></h2>
    <div class="charts">
      <div class="chart">
        <div class="chart-title">耗时占比</div>
        <div class="donut-wrap">
          <svg class="donut" viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="耗时占比">
            <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#f3f0fb" stroke-width="${SW}" />
            ${arcs}
          </svg>
          <div class="donut-center"><b>${formatDuration(totalDuration)}</b><span>总耗时</span></div>
        </div>
        <ul class="legend">${legend}</ul>
      </div>
      <div class="chart">
        <div class="chart-title">执行时间线<span class="chart-count">共 ${rows.length} 步</span></div>
        <div class="wf-wrap${scrollable ? ' scrollable' : ''}" id="wf-wrap">
          <div class="wf" id="wf-list">${wf}</div>
        </div>
      </div>
    </div>
  </section>`;
}

// ── 报告分析（自动结论 + 操作类型分布） ──
const OP_CATS = [
  { name: '等待', color: '#7c3aed', re: /^Wait for/i },
  { name: '交互操作', color: '#8b5cf6', re: /^(Click|Fill|Press|Hover|Select|Check|Uncheck|Set input files|Drag|Scroll|Tap)/i },
  { name: '断言校验', color: '#a78bfa', re: /^Expect/i },
  { name: '脚本执行', color: '#c4b5fd', re: /^Evaluate/i },
  { name: '页面导航', color: '#ddd6fe', re: /^Navigate/i },
  { name: '截图附件', color: '#e9e5f8', re: /^(Screenshot|Attach)/i },
];

function pctOf(a, b) { return b ? ((a / b) * 100).toFixed(1) : '0.0'; }

// 收集所有子操作（层级 >= 1 的节点）
function collectOps() {
  const ops = [];
  (function walk(list, depth) {
    list.forEach(s => {
      if (depth >= 1) ops.push(s);
      if (Array.isArray(s.steps)) walk(s.steps, depth + 1);
    });
  })(steps, 0);
  return ops;
}

function generateHealingLogHTML() {
  // 读取 healing-log.json，不存在则自动生成默认日志
  let logs = [];
  try {
    const logPath = path.join(dataDir, 'healing-log.json');
    if (fs.existsSync(logPath)) {
      logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    }
  } catch (e) { /* ignore */ }

  // 如果没有日志数据，生成默认的自愈推理日志
  if (!logs.length) {
    logs = [
      { ts: startTime || new Date().toISOString(), type: 'init', title: '初始化测试环境',
        detail: '读取操作步骤文档，解析页面 URL、输入数据、断言点。配置窗口最大化（viewport: null + --start-maximized）和视频录制。' },
      { ts: startTime || new Date().toISOString(), type: 'analyze', title: '分析页面结构',
        detail: '通过 Playwright MCP 获取页面 accessibility 快照，识别登录入口、弹窗类型、表单结构。分析发现：首页无文字"登录"按钮，登录入口为头像 img[alt=avatar] 触发 popover。' },
      { ts: startTime || new Date().toISOString(), type: 'generate', title: '生成测试脚本',
        detail: `生成 ${mainStepCount} 个步骤的 Playwright TypeScript 测试脚本，包含 dismissPopups 弹窗检测函数和 narrateStep 视频增强函数。` },
      { ts: startTime || new Date().toISOString(), type: 'execute', title: '执行测试',
        detail: testStatus === 'passed'
          ? `测试首次执行通过，无需自愈。总耗时 ${formatDuration(totalDuration)}，共 ${totalStepNodes} 个操作节点。`
          : `测试执行失败，进入自愈推理流程。` },
    ];
    if (testStatus === 'passed') {
      logs.push({ ts: endTimeIso || new Date().toISOString(), type: 'success', title: '执行完成',
        detail: '所有断言通过，用例执行成功。视频已嵌入报告，步骤截图已内联。' });
    }
  }

  const typeMeta = {
    init:     { label: '初始化', color: 'var(--purple-600)', bg: 'var(--purple-100)' },
    analyze:  { label: '分析',   color: 'var(--purple-700)', bg: 'var(--purple-100)' },
    generate: { label: '生成',   color: '#0891b2',           bg: '#cffafe' },
    execute:  { label: '执行',   color: '#c026d3',           bg: '#fae8ff' },
    heal:     { label: '自愈',   color: '#d97706',           bg: 'var(--warn-100)' },
    fix:      { label: '修复',   color: 'var(--ok-600)',      bg: 'var(--ok-100)' },
    success:  { label: '完成',   color: 'var(--ok-600)',     bg: 'var(--ok-100)' },
    error:    { label: '错误',   color: 'var(--err-600)',    bg: 'var(--err-100)' },
    retry:    { label: '重试',   color: '#d97706',           bg: 'var(--warn-100)' },
  };

  const entries = logs.map((log, i) => {
    const meta = typeMeta[log.type] || typeMeta.execute;
    const tsDate = parseLogTs(log.ts);
    const time = tsDate ? tsDate.toLocaleTimeString('zh-CN', { hour12: false }) : '';
    return `<div class="heal-entry">
      <div class="heal-dot" style="background:${meta.bg};border-color:${meta.color}"></div>
      <div class="heal-content">
        <div class="heal-header">
          <span class="heal-tag" style="background:${meta.bg};color:${meta.color}">${meta.label}</span>
          <span class="heal-title">${escapeHtml(log.title || '')}</span>
          ${time ? `<span class="heal-time">${time}</span>` : ''}
        </div>
        ${log.detail ? `<div class="heal-detail">${escapeHtml(log.detail)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<section class="card heal-card">
    <h2><span class="h-ico">${ICONS.lightbulb}</span>AI 推理日志<span class="h-hint">自愈推理过程记录</span></h2>
    <div class="heal-timeline">${entries}</div>
  </section>`;
}

function generateInsightsHTML() {
  const ops = collectOps();
  if (!ops.length && !steps.length) return '';

  const mainSteps = steps.filter(s => !HOOK_RE.test(s.title));
  const opDur = ops.reduce((n, s) => n + (s.duration || 0), 0) || 1;

  const cats = OP_CATS.map(c => {
    const list = ops.filter(s => c.re.test(s.title));
    return { name: c.name, color: c.color, count: list.length, duration: list.reduce((n, s) => n + (s.duration || 0), 0) };
  }).filter(c => c.count > 0);
  const maxCatCount = Math.max(...cats.map(c => c.count), 1);

  const slowest = [...mainSteps].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  const wait = cats.find(c => c.name === '等待') || { count: 0, duration: 0 };
  const interact = cats.find(c => c.name === '交互操作') || { count: 0 };
  const expectCat = cats.find(c => c.name === '断言校验') || { count: 0 };
  const avgOp = ops.length ? opDur / ops.length : 0;
  const slowPct = slowest ? pctOf(slowest.duration || 0, totalDuration) : '0.0';
  const waitPct = Number(pctOf(wait.duration, opDur));

  const insights = [
    { ico: testStatus === 'passed' ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1.5A6.5 6.5 0 1014.5 8 6.51 6.51 0 008 1.5zm3.04 4.6L7.1 10.03 4.94 7.87a.5.5 0 01.7-.7L7.1 8.62l3.23-3.24a.5.5 0 01.71.72z"/></svg>' : '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1.5A6.5 6.5 0 1014.5 8 6.51 6.51 0 008 1.5zm3.04 4.6L7.1 10.03 4.94 7.87a.5.5 0 01.7-.7L7.1 8.62l3.23-3.24a.5.5 0 01.71.72z"/></svg>', title: '执行结论',
      text: `测试${testStatus === 'passed' ? '全部通过' : '执行失败'}，共 <b>${mainStepCount}</b> 个步骤 / <b>${ops.length}</b> 个子操作，总耗时 <b>${formatDuration(totalDuration)}</b>。` },
    { ico: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2a.5.5 0 01.5.5v3a3.5 3.5 0 007 0v-3a.5.5 0 011 0v3a4.5 4.5 0 01-9 0v-3A.5.5 0 014 2zm-.5 11a.5.5 0 01.5-.5h8a.5.5 0 010 1H4a.5.5 0 01-.5-.5z"/></svg>', title: '耗时瓶颈',
      text: slowest ? `最慢步骤为 <b>${escapeHtml(slowest.title)}</b>，耗时 <b>${formatDuration(slowest.duration)}</b>，占总时长 <b>${slowPct}%</b>。` : '无步骤数据。' },
    { ico: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1.5A6.5 6.5 0 1014.5 8 6.51 6.51 0 008 1.5zm.5 2a.5.5 0 00-1 0v4.8a.5.5 0 00.25.43l3 1.7a.5.5 0 00.5-.86l-2.75-1.56z"/></svg>', title: '等待开销',
      text: `等待类操作 <b>${wait.count}</b> 次，累计 <b>${formatDuration(wait.duration)}</b>，占子操作耗时 <b>${pctOf(wait.duration, opDur)}%</b>${waitPct > 50 ? '，等待占比偏高，建议排查可优化项' : '，等待占比合理'}。` },
    { ico: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 3a.5.5 0 011 0v3.5l2.5 1.5a.5.5 0 01-.5.86l-2.75-1.62A.5.5 0 017.5 8V4z"/></svg>', title: '断言覆盖',
      text: `共执行 <b>${expectCat.count}</b> 处断言校验，关键界面元素${expectCat.count > 0 ? '已覆盖' : '未覆盖，建议补充断言'}。` },
    { ico: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8.5.5a.5.5 0 00-1 0v5H7a4.5 4.5 0 100 9 .5.5 0 00.5-.5V9h1v5a.5.5 0 00.5.5 4.5 4.5 0 100-9h-.5v-4z"/></svg>', title: '执行效率',
      text: `交互类操作 <b>${interact.count}</b> 次，子操作平均耗时 <b>${formatDuration(Math.round(avgOp))}</b>。` },
  ];

  const distRows = cats.map(c => `
      <div class="dist-row" title="${c.name}：${c.count} 次 · ${formatDuration(c.duration)}">
        <span class="dist-name">${c.name}</span>
        <span class="dist-track"><span class="dist-fill" style="width:${(c.count / maxCatCount * 100).toFixed(1)}%;background:${c.color}"></span></span>
        <span class="dist-val">${c.count} 次 · ${formatDuration(c.duration)}</span>
      </div>`).join('');

  return `<section class="card">
    <h2><span class="h-ico">${ICONS.lightbulb}</span>报告分析<span class="h-hint">基于本次运行数据自动生成</span></h2>
    <div class="analysis">
      <ul class="insights">
        ${insights.map(i => `<li><span class="ins-ico">${i.ico}</span><div class="ins-body"><b>${i.title}</b><p>${i.text}</p></div></li>`).join('')}
      </ul>
      <div class="dist">
        <div class="chart-title">操作类型分布</div>
        ${distRows}
      </div>
    </div>
  </section>`;
}

const { ensureFittedVideo } = require('./video-fit');
const { buildFullRunVideo } = require('./video-merge');

// 读入视频并转 base64；若录制画布比实际视口大（四周有灰边），先裁剪成铺满版
function embedVideo(file) {
  const fitted = ensureFittedVideo(file);
  return `data:video/webm;base64,${fs.readFileSync(fitted).toString('base64')}`;
}

let ffmpegBin = null;
try { ffmpegBin = require('ffmpeg-static'); } catch { /* 可选依赖 */ }

// 抽取视频首帧作为封面，避免未播放时显示一片黑
// 读取视频时长（ffmpeg -i 会打印 Duration）
function probeDuration(file) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(ffmpegBin, ['-i', file], { encoding: 'utf8' });
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr || '');
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  } catch { return 0; }
}

function makePoster(file) {
  try {
    if (!ffmpegBin || !fs.existsSync(ffmpegBin)) return null;
    const framed = ensureFittedVideo(file);
    const tmp = path.join(reportDir, '.poster-frame.png');
    const { spawnSync } = require('child_process');
    const dur = probeDuration(framed);
    // 优先取视频中后段（内容已加载）的帧，再退化到开头几个时间点
    const times = dur > 4 ? [dur * 0.4, dur * 0.6, dur * 0.25, 5, 2, 1] : [2, 1, 0.5];
    let best = null;
    for (const t of times) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      const r = spawnSync(ffmpegBin, ['-y', '-ss', String(t.toFixed(2)), '-i', framed, '-frames:v', '1', '-update', '1', tmp], { stdio: 'ignore' });
      if (r.status !== 0 || !fs.existsSync(tmp)) continue;
      const size = fs.statSync(tmp).size;
      if (!best || size > best.size) best = { size, b64: fs.readFileSync(tmp).toString('base64') };
      if (size > 40000) break; // 已是一帧有内容的画面，不再继续尝试
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    return best ? `data:image/png;base64,${best.b64}` : null;
  } catch { return null; }
}

// 把主录像与各分页录像拼成一份完整录像（分享页/详情页操作只存在于分页视频里）。
// 优先无损 stream copy（同源录制、编码参数一致）；失败则用 libvpx 重编码兜底。
function concatVideos(files, outPath) {
  if (!ffmpegBin || !fs.existsSync(ffmpegBin) || files.length < 2) return null;
  const { spawnSync } = require('child_process');
  const listPath = path.join(reportDir, '.concat-list.txt');
  try {
    fs.writeFileSync(listPath, files
      .map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n'), 'utf8');
    let r = spawnSync(ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath], { stdio: 'ignore' });
    let ok = r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    if (!ok) {
      r = spawnSync(ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libvpx', '-b:v', '2M', '-an', outPath], { stdio: 'ignore' });
      ok = r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    }
    return ok ? outPath : null;
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(listPath)) fs.unlinkSync(listPath); } catch {}
  }
}

// 从 test-out 收集原始录像（video.webm 为主，video-N.webm 为分页）。
// 原生报告附件里的分页录像在生成结束时会被清理，故重跑生成器时必须回到 test-out 取源。
function collectTestOutVideos() {
  const outRoot = path.resolve(__dirname, '..', 'test-out');
  if (!fs.existsSync(outRoot)) return null;
  try {
    for (const d of fs.readdirSync(outRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(outRoot, d.name);
      const main = path.join(dir, 'video.webm');
      if (!fs.existsSync(main)) continue;
      const extras = fs.readdirSync(dir)
        .filter(n => /^video-\d+\.webm$/i.test(n))
        .map(n => path.join(dir, n));
      return { main, extras };
    }
  } catch { /* ignore */ }
  return null;
}

let videoFilePath = null;
const video = (() => {
  // 1) 优先把「主录像 + 各分页录像」按录制时间内联合并：
  //    分页录像用 (mtime - 时长) 推算真实开始时刻，去掉开头黑屏后插到主录像对应时间点；
  //    若内联失败则回退到旧的「末尾追加」逻辑。
  const testOutVideos = collectTestOutVideos();
  if ((testOutVideos && testOutVideos.extras.length) || extraVideoFiles.length > 0) {
    const all = (testOutVideos && testOutVideos.extras.length
      ? [testOutVideos.main, ...testOutVideos.extras]
      : [videoPath ? path.join(reportDir, videoPath) : null, ...extraVideoFiles])
      .filter(f => f && fs.existsSync(f));
    if (all.length >= 2) {
      const outPath = path.join(reportDir, '.full-run.webm');
      let out = null;
      try {
        out = buildFullRunVideo({ main: all[0], extras: all.slice(1), outPath });
      } catch (e) {
        console.log('  ⚠️ 内联拼接异常，回退到末尾追加:', e.message);
      }
      if (!out) out = concatVideos(all, outPath);
      if (out) {
        console.log(`  🎬 完整运行录像已生成（${all.length} 段分页录像按时间内联/拼接）`);
        videoFilePath = out;
        return embedVideo(out);
      }
    }
  }
  // 2) 后处理视频（一般不存在，兼容历史）
  const enhancedPath = path.join(reportDir, 'enhanced-video.webm');
  if (fs.existsSync(enhancedPath)) {
    console.log('  🎬 使用录制视频（字幕 + 红框高亮）');
    videoFilePath = enhancedPath;
    return embedVideo(enhancedPath);
  }
  // 3) 回退到主录像
  if (videoPath) {
    const p = path.join(reportDir, videoPath);
    if (fs.existsSync(p)) { videoFilePath = p; return embedVideo(p); }
  }
  // 回退：从 test-out-* 目录递归查找 .webm 视频文件
  const rootDir = path.resolve(__dirname, '..');
  try {
    const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('test-out'))
      .map(d => path.join(rootDir, d.name));
    function findWebm(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          const found = findWebm(fullPath);
          if (found) return found;
        } else if (item.name.endsWith('.webm')) {
          return fullPath;
        }
      }
      return null;
    }
    for (const dir of dirs) {
      const found = findWebm(dir);
      if (found) {
        console.log('  🎬 从 test-out 目录回退加载视频:', path.basename(found));
        videoFilePath = found;
        return embedVideo(found);
      }
    }
  } catch (e) { /* ignore */ }
  return null;
})();

const poster = videoFilePath ? makePoster(videoFilePath) : null;

// 统计：执行步骤数量（顶层业务步骤，不含 Before/After Hooks）
const mainStepCount = steps.filter(s => !HOOK_RE.test(s.title)).length;
// 全部节点数（含子操作与 Hooks），用于日志
function countSteps(list) {
  return list.reduce((n, s) => n + 1 + countSteps(Array.isArray(s.steps) ? s.steps : []), 0);
}
const totalStepNodes = countSteps(steps);

// ── 概要看板派生指标 ──
const endTimeIso = startTime ? new Date(new Date(startTime).getTime() + (totalDuration || 0)).toISOString() : null;

// 概要小卡
function sumItem(svgIcon, label, value, small) {
  const isNum = typeof value === 'number' || /^\d+$/.test(String(value));
  return `<div class="sum-item">
      <span class="si-ico">${svgIcon}</span>
      <span class="si-body">
        <span class="si-k">${escapeHtml(label)}</span>
        <span class="si-v${small ? ' small' : ''}"${isNum ? ` data-count="${escapeHtml(String(value))}"` : ''}>${escapeHtml(String(value))}</span>
      </span>
    </div>`;
}

// SVG 图标常量
const ICONS = {
  steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  browser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  summary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  lightbulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v1.2h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  timer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6M12 5V2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
};

// 报告品牌 Logo（渐变圆角方块 + 播放三角，呼应「UI 运行录像」主题）
const REPORT_LOGO = `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-label="UI Report logo">
  <defs><linearGradient id="rg-logo" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#6d28d9"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#rg-logo)"/>
  <path d="M20 15.5l12 8.5-12 8.5z" fill="#fff"/>
</svg>`;
const REPORT_LOGO_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(REPORT_LOGO);

// ── 6. 生成完整 HTML ──
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="${REPORT_LOGO_FAVICON}">
<title>UI Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    /* 浅紫白色基调 */
    --ink:        #1e1b2e;
    --ink-2:      #4a4458;
    --muted:      #918ca0;
    --line:       #ede9f6;
    --bg:         #f5f3ff;
    --card:       #ffffff;

    /* 主色：紫色 */
    --purple-900: #4c1d95;
    --purple-700: #6d28d9;
    --purple-600: #7c3aed;
    --purple-500: #8b5cf6;
    --purple-400: #a78bfa;
    --purple-300: #c4b5fd;
    --purple-200: #ddd6fe;
    --purple-100: #ede9fe;
    --purple-50:  #f5f3ff;
    --purple-25:  #faf8ff;

    /* 状态：通过绿 / 失败红 / 警告橙 */
    --ok-700:     #15803d;
    --ok-600:     #16a34a;
    --ok-500:     #22c55e;
    --ok-100:     #dcfce7;
    --ok-50:      #f0fdf4;
    --err-700:    #b91c1c;
    --err-600:    #dc2626;
    --err-500:    #ef4444;
    --err-100:    #fee2e2;
    --err-50:     #fef2f2;
    --warn-600:   #d97706;
    --warn-100:   #fef3c7;

    --r-lg: 16px;
    --r-md: 12px;
    --r-sm: 8px;
    --sh-1: 0 1px 3px rgba(76,29,149,.06), 0 1px 2px rgba(76,29,149,.04);
    --sh-2: 0 8px 28px -10px rgba(76,29,149,.15);
    --sh-glow: 0 0 20px rgba(124,58,237,.12);
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', Consolas, Monaco, ui-monospace, monospace;
  }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    font-family: var(--font);
    color: var(--ink);
    line-height: 1.6;
    background:
      radial-gradient(900px 400px at 15% -5%, var(--purple-100) 0%, transparent 55%),
      radial-gradient(700px 350px at 95% 5%, var(--purple-50) 0%, transparent 50%),
      var(--bg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Hero ── */
  .hero {
    position: relative;
    padding: 32px 40px 28px;
    color: var(--ink);
    background: linear-gradient(135deg, var(--purple-100) 0%, var(--purple-50) 50%, #fff 100%);
    overflow: hidden;
    border-bottom: 1px solid var(--purple-200);
  }
  .hero::after {
    content: '';
    position: absolute; inset: 0;
    background: radial-gradient(500px 250px at 88% 20%, rgba(124,58,237,.08), transparent 70%);
    pointer-events: none;
  }
  .hero-inner { position: relative; max-width: 1120px; margin: 0 auto; }
  .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .hero-brand { display: flex; align-items: flex-start; gap: 14px; }
  .report-logo {
    flex: 0 0 auto; width: 46px; height: 46px; border-radius: 12px;
    box-shadow: 0 6px 16px rgba(124,58,237,.35);
    overflow: hidden;
  }
  .report-logo svg { display: block; width: 100%; height: 100%; }
  .hero h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -.2px; line-height: 1.35; max-width: 780px; color: var(--ink); }
  .hero .subtitle { margin-top: 6px; font-size: 13px; color: var(--muted); font-family: var(--mono); }
  .badge-status {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .5px;
    white-space: nowrap;
    color: #fff;
  }
  .badge-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: .9; }
  .badge-status.passed { background: var(--ok-600); box-shadow: 0 2px 8px rgba(22,163,74,.3); }
  .badge-status.failed { background: var(--err-600); box-shadow: 0 2px 8px rgba(220,38,38,.3); }

  .hero-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .meta-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px; border-radius: 999px;
    font-size: 12px; color: var(--ink-2);
    background: rgba(255,255,255,.7);
    border: 1px solid var(--purple-200);
    backdrop-filter: blur(4px);
  }
  .meta-chip svg { width: 14px; height: 14px; flex: 0 0 auto; color: var(--purple-600); opacity: .8; }
  .meta-chip b { font-weight: 600; color: var(--ink); }

  /* ── Layout ── */
  .container { max-width: 1120px; margin: -20px auto 64px; padding: 0 20px; position: relative; z-index: 2; }

  .card {
    background: var(--card);
    border-radius: var(--r-lg);
    box-shadow: var(--sh-1);
    border: 1px solid var(--line);
    padding: 24px 28px;
    margin-bottom: 18px;
    transition: box-shadow .2s ease;
  }
  .card:hover { box-shadow: var(--sh-2); }
  .card h2 {
    margin: 0 0 18px;
    font-size: 14px; font-weight: 700; letter-spacing: .2px;
    color: var(--ink);
    display: flex; align-items: center; gap: 9px;
  }
  .card h2 .h-ico {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 7px;
    background: var(--purple-100); color: var(--purple-700);
  }
  .card h2 .h-ico svg { width: 15px; height: 15px; }
  .card h2 .h-hint { margin-left: auto; font-size: 11.5px; font-weight: 400; color: var(--muted); }
  .s-expand-all {
    margin-left: auto; padding: 6px 14px;
    border: 1px solid var(--purple-300); border-radius: 999px;
    background: var(--purple-50); color: var(--purple-700);
    font-size: 12px; font-weight: 600; cursor: pointer;
    white-space: nowrap; transition: background .15s ease, border-color .15s ease;
  }
  .s-expand-all:hover { background: var(--purple-100); border-color: var(--purple-400); }
  .s-expand-all:active { transform: translateY(1px); }

  /* ── 测试概要看板 ── */
  .summary { display: flex; flex-direction: column; gap: 14px; }

  .sum-hero {
    position: relative; overflow: hidden;
    display: flex; align-items: center; gap: 20px;
    padding: 22px 26px; border-radius: var(--r-lg);
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--purple-200);
  }
  .sum-hero::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(500px 200px at 90% 10%, var(--purple-50), transparent 70%);
  }
  .sum-hero-icon {
    position: relative; flex: 0 0 auto;
    width: 44px; height: 44px; border-radius: 12px;
    display: inline-flex; align-items: center; justify-content: center;
    color: #fff;
  }
  .sum-hero-icon svg { width: 24px; height: 24px; }
  .sum-hero.passed .sum-hero-icon { background: var(--ok-600); box-shadow: 0 4px 12px rgba(22,163,74,.25); }
  .sum-hero.failed .sum-hero-icon { background: var(--err-600); box-shadow: 0 4px 12px rgba(220,38,38,.25); }
  .sum-hero-body { position: relative; flex: 1; min-width: 0; }
  .sum-hero-label { font-size: 11px; letter-spacing: .8px; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .sum-hero-value {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 22px; font-weight: 800; line-height: 1.3; margin-top: 2px;
    color: var(--ink);
  }
  .sum-hero-value::after {
    content: attr(data-status);
    display: inline-flex; align-items: center;
    padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .3px;
  }
  .sum-hero.passed .sum-hero-value::after { content: 'PASSED'; background: var(--ok-600); color: #fff; }
  .sum-hero.failed .sum-hero-value::after { content: 'FAILED'; background: var(--err-600); color: #fff; }
  .sum-hero-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .sum-hero-metric {
    position: relative; flex: 0 0 auto; text-align: right;
    padding-left: 22px; border-left: 1px solid var(--line);
  }
  .sum-hero-metric span { display: block; font-size: 12px; letter-spacing: 0; color: var(--ink); font-weight: 700; }
  .sum-hero-metric b { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--ink); }

  .sum-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 12px; }

  /* 概要看板：结果分布环形图 */
  .sum-pie { margin-top: 20px; padding-top: 16px; border-top: 1px dashed var(--purple-200); }
  .sum-pie-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .sum-pie-title {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px; font-weight: 700; letter-spacing: .3px; color: var(--ink-2);
  }
  .sum-pie-title::before {
    content: ''; width: 3px; height: 12px; border-radius: 2px;
    background: linear-gradient(180deg, var(--purple-400), var(--purple-600));
  }
  .sum-pie-note { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .sum-pie-body { display: flex; align-items: center; gap: 26px; flex-wrap: wrap; }

  .sum-pie-chart {
    position: relative; flex: 0 0 auto;
    width: 172px; height: 172px; border-radius: 50%;
    animation: pie-pop .55s cubic-bezier(.22,1,.36,1) both;
  }
  @keyframes pie-pop { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: none; } }
  .sum-pie-chart svg { display: block; width: 100%; height: 100%; overflow: visible; }
  .sum-pie-chart .pie-arc { transition: stroke-width .18s ease, filter .18s ease; }
  .sum-pie-chart .pie-arc:hover { stroke-width: 22; filter: brightness(1.06); }

  .sum-pie-center {
    position: absolute; inset: 0; pointer-events: none;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    animation: pie-pop .6s .1s cubic-bezier(.22,1,.36,1) both;
  }
  .sum-pie-center b {
    font-size: 30px; font-weight: 800; line-height: 1;
    letter-spacing: -1.2px; font-variant-numeric: tabular-nums;
  }
  .sum-pie-center b em { font-style: normal; font-size: 15px; font-weight: 700; letter-spacing: 0; margin-left: 1px; }
  .sum-pie-center > span {
    margin-top: 4px; font-size: 10.5px; font-weight: 600;
    letter-spacing: 1px; text-transform: uppercase; color: var(--muted);
  }
  .sum-pie-center i {
    font-style: normal; margin-top: 7px; padding: 1px 8px; border-radius: 999px;
    font-size: 10.5px; line-height: 1.6; color: var(--ink-2); background: #fff;
    border: 1px solid var(--purple-100); font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .sum-pie-legend {
    list-style: none; margin: 0; padding: 0; flex: 1 1 320px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .sum-pie-legend .sp-item {
    display: grid; align-items: center; gap: 12px;
    grid-template-columns: auto auto minmax(60px, 1fr) auto auto;
    padding: 9px 14px; border-radius: 11px;
    background: linear-gradient(90deg, var(--bg, var(--purple-25)) 0%, #fff 64%);
    border: 1px solid var(--line);
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
  }
  .sum-pie-legend .sp-item:hover {
    transform: translateX(2px); border-color: var(--c);
    box-shadow: 0 12px 24px -18px rgba(30,27,46,.5);
  }
  .sp-ring { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 auto; background: var(--c); box-shadow: 0 0 0 3px var(--bg); }
  .sp-name { min-width: 42px; font-size: 12.5px; font-weight: 600; color: var(--ink-2); white-space: nowrap; }
  .sp-pct { min-width: 44px; text-align: right; font-size: 13px; font-weight: 800; color: var(--c); font-variant-numeric: tabular-nums; }
  .sp-meta { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sp-meta b { font-size: 13px; font-weight: 800; color: var(--ink); margin-right: 1px; }
  .sp-bar { display: block; height: 6px; border-radius: 999px; background: rgba(30,27,46,.06); overflow: hidden; }
  .sp-bar i {
    display: block; height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--c), var(--c-end, var(--c)));
    transform-origin: left; animation: sp-bar-in .8s cubic-bezier(.22,1,.36,1) both;
  }
  @keyframes sp-bar-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }

  .sum-item {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 16px; border-radius: var(--r-md);
    background: var(--purple-25);
    border: 1px solid var(--purple-100);
    transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
  }
  .sum-item:hover { border-color: var(--purple-300); box-shadow: var(--sh-2); transform: translateY(-1px); }
  .si-ico {
    flex: 0 0 auto; width: 32px; height: 32px; border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--purple-100); color: var(--purple-700);
  }
  .si-ico svg { width: 16px; height: 16px; }
  .si-body { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .si-k { font-size: 11.5px; color: var(--muted); letter-spacing: .3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .si-v { font-size: 16px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.3; word-break: break-all; }
  .si-v.small { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }

  /* ── 步骤树 ── */
  .s {
    position: relative;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    transition: background .16s ease, border-color .16s ease;
  }
  /* 步骤列表：固定高度，超出内部滚动 */
  .steps {
    max-height: min(900px, 90vh);
    overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
    padding-right: 10px; scrollbar-width: thin;
    scrollbar-color: var(--purple-300) var(--purple-50);
  }
  .steps:hover { scrollbar-color: var(--purple-400) var(--purple-50); }
  .steps::-webkit-scrollbar { width: 6px; }
  .steps::-webkit-scrollbar-track { background: var(--purple-50); border-radius: 999px; }
  .steps::-webkit-scrollbar-thumb { background: var(--purple-300); border-radius: 999px; }
  .steps::-webkit-scrollbar-thumb:hover { background: var(--purple-400); }

  /* 顶层步骤 */
  .s-lv0 {
    background: #fff;
    border-color: var(--line);
    box-shadow: var(--sh-1);
    margin-bottom: 8px;
    overflow: hidden;
  }
  .s-lv0.expandable:hover { border-color: var(--purple-300); box-shadow: var(--sh-2); }
  .s-head {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px;
    user-select: none;
  }
  .s.expandable > .s-head { cursor: pointer; }
  .s-chev {
    flex: 0 0 auto; color: var(--muted);
    transition: transform .18s ease;
  }
  .s.open > .s-head .s-chev { transform: rotate(90deg); color: var(--purple-600); }
  .s.static > .s-head { padding-left: 18px; }

  .s-badge {
    flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 24px; height: 24px; padding: 0 7px;
    border-radius: 6px;
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: #fff; background: var(--purple-600);
  }
  .s-badge.hook { background: var(--muted); }

  .s-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .s-row1 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 9px; }
  .s-title { font-weight: 600; font-size: 14px; color: var(--ink); }
  .s-subtitle { font-family: var(--mono); font-size: 12px; color: var(--purple-600); word-break: break-all; }
  .s-row2 { display: flex; gap: 10px; flex-wrap: wrap; }
  .s-loc { font-family: var(--mono); font-size: 11px; color: var(--muted); }

  .s-dur {
    flex: 0 0 auto;
    padding: 3px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--purple-700); background: var(--purple-50);
    border: 1px solid var(--purple-100);
  }

  .s-body { display: none; padding: 0 18px 16px; }
  .s.open > .s-body { display: block; animation: reveal .3s cubic-bezier(.4,0,.2,1); }
  @keyframes reveal { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }

  /* ── 动画特效 ── */
  /* 卡片入场动画 */
  .card, .heal-card {
    opacity: 0; transform: translateY(24px);
    transition: opacity .5s ease, transform .5s ease;
  }
  .card.in-view, .heal-card.in-view { opacity: 1; transform: none; }

  /* 推理日志逐条入场 */
  .heal-entry {
    opacity: 0; transform: translateX(-12px);
    transition: opacity .4s ease, transform .4s ease;
  }
  .heal-entry.in-view { opacity: 1; transform: none; }

  /* 推理日志"分析中"光标闪烁 */
  .heal-cursor {
    display: inline-block; width: 7px; height: 14px;
    background: var(--purple-600); border-radius: 2px;
    margin-left: 2px; vertical-align: text-bottom;
    animation: cursor-blink .8s steps(2) infinite;
  }
  @keyframes cursor-blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }

  /* sum-hero 数值计数动画 */
  .count-up { display: inline-block; }

  /* 步骤展开增强 */
  .s-lv0 { transition: box-shadow .3s ease, border-color .3s ease; }
  .s-lv0.in-view { animation: card-slide-in .4s ease; }
  @keyframes card-slide-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  /* 概要看板 badge 弹出 */
  .sum-hero-value::after { animation: badge-pop .4s cubic-bezier(.34,1.56,.64,1); }
  @keyframes badge-pop { 0% { opacity: 0; transform: scale(.6); } 100% { opacity: 1; transform: scale(1); } }

  /* 状态图标弹入 */
  .sum-hero-icon { animation: icon-bounce .5s cubic-bezier(.34,1.56,.64,1); }
  @keyframes icon-bounce { 0% { opacity: 0; transform: scale(.3); } 100% { opacity: 1; transform: scale(1); } }

  /* 子节点容器 */
  .s-children { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .s-lv1 > .s-head { padding: 10px 14px; }
  .s-lv1 {
    background: var(--purple-25);
    border-color: var(--purple-100);
    border-radius: var(--r-sm);
  }
  .s-lv1.expandable:hover { background: var(--purple-50); border-color: var(--purple-300); }
  .s-lv1 > .s-body { padding: 0 14px 12px; }
  .s-lv1 .s-title { font-size: 13px; font-weight: 600; font-family: var(--mono); color: var(--purple-700); }
  .s-lv1 .s-subtitle { color: var(--muted); }
  .s-lv1 > .s-head .s-badge,
  .s-lv2 > .s-head .s-badge,
  .s-lv3 > .s-head .s-badge {
    background: transparent; color: var(--muted);
    box-shadow: none; min-width: auto; padding: 0;
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
  }

  .s-lv2 > .s-head { padding: 9px 13px; }
  .s-lv2 { background: #fff; border-color: var(--purple-100); }
  .s-lv2 .s-title { font-size: 12.5px; color: var(--purple-700); }
  .s-lv2 .s-subtitle { color: var(--muted); }

  /* 嵌套子节点左侧引导线 */
  .s-lv0 > .s-body > .s-children { border-left: 2px solid var(--purple-200); padding-left: 14px; margin-left: 12px; }

  /* 源码块 */
  .code {
    margin: 10px 0 0;
    padding: 12px 15px;
    background: #1e1b2e;
    border: 1px solid var(--purple-900);
    border-radius: var(--r-sm);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.65;
    color: #c4b5fd;
    white-space: pre;
    tab-size: 2;
    scrollbar-color: var(--purple-700) transparent;
    scrollbar-width: thin;
  }
  .code::-webkit-scrollbar { height: 0; }
  .code:hover::-webkit-scrollbar { height: 5px; }
  .code::-webkit-scrollbar-track { background: transparent; }
  .code::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
  .code:hover::-webkit-scrollbar-thumb { background: var(--purple-700); }
  .code code { font-family: inherit; }

  .shot { margin: 12px 0 0; }
  .shot img {
    width: 100%; display: block;
    border-radius: var(--r-sm);
    border: 1px solid var(--purple-200);
    box-shadow: var(--sh-1);
    cursor: zoom-in;
    transition: transform .18s ease, box-shadow .18s ease;
  }
  .shot img:hover { transform: translateY(-2px); box-shadow: var(--sh-2); }
  .shot-tip { margin-top: 6px; font-size: 11.5px; color: var(--muted); text-align: right; }
  .shot-tip::before { content: '🔍 '; font-size: 11px; }

  /* 步骤截图折叠字段 */
  .shot-field {
    margin: 0; overflow: hidden;
    border: 1px solid var(--purple-100); border-radius: var(--r-sm);
    background: #fff;
  }
  .shot-field > summary {
    list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    font-size: 12.5px; font-weight: 600; color: var(--purple-700);
    transition: background .15s ease;
  }
  .shot-field > summary::-webkit-details-marker { display: none; }
  .shot-field > summary:hover { background: var(--purple-50); }
  .shot-field .sf-chev { flex: 0 0 auto; color: var(--muted); transition: transform .18s ease; }
  .shot-field[open] .sf-chev { transform: rotate(90deg); color: var(--purple-600); }
  .shot-field .sf-hint { margin-left: auto; font-size: 11.5px; font-weight: 500; color: var(--muted); }
  .shot-field[open] .sf-hint { display: none; }
  .shot-field > .shot { margin: 0; padding: 0 14px 14px; }
  .shot-caption {
    padding: 10px 2px 8px;
    font-size: 12px; font-weight: 600; color: var(--purple-700);
  }
  .shot-caption::before { content: '📸 '; font-size: 11px; }

  /* 图片放大预览 */
  .lightbox {
    position: fixed; inset: 0; z-index: 999;
    display: none; align-items: center; justify-content: center;
    padding: 30px;
    overflow: hidden;
    background: rgba(28,18,52,.88);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    overscroll-behavior: contain;
  }
  .lightbox.open { display: flex; animation: lb-in .18s ease; }
  @keyframes lb-in { from { opacity: 0; } to { opacity: 1; } }
  .lightbox img {
    max-width: 94vw; max-height: 88vh; display: block;
    border-radius: 10px; background: #fff;
    box-shadow: 0 30px 80px -20px rgba(0,0,0,.75);
    cursor: grab;
    transform-origin: center center;
    will-change: transform;
    user-select: none; -webkit-user-drag: none;
    touch-action: none;
  }
  .lightbox img.grabbing { cursor: grabbing; }
  .lightbox-tools {
    position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: 999px;
    background: rgba(255,255,255,.14);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.16);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  }
  .lightbox-tools button {
    width: 32px; height: 32px; border-radius: 50%;
    border: none; cursor: pointer; color: #fff; font-size: 16px; line-height: 1;
    background: rgba(255,255,255,.14);
    transition: background .15s ease;
  }
  .lightbox-tools button:hover { background: rgba(255,255,255,.3); }
  .lightbox-tools .zoom-val {
    min-width: 48px; text-align: center; color: #fff;
    font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums;
  }
  .lightbox-close {
    position: absolute; top: 20px; right: 22px;
    width: 42px; height: 42px; border-radius: 50%;
    border: none; cursor: pointer; font-size: 18px; color: #fff;
    background: rgba(255,255,255,.16);
    transition: background .15s ease;
  }
  .lightbox-close:hover { background: rgba(255,255,255,.3); }
  .lightbox-hint {
    position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
    color: rgba(255,255,255,.72); font-size: 12.5px; white-space: nowrap;
  }

  /* ── 报告分析 ── */
  .analysis { display: grid; grid-template-columns: 1fr 320px; gap: 28px; align-items: start; }
  .insights { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .insights li {
    display: flex; gap: 12px; padding: 12px 15px;
    border-radius: var(--r-md);
    background: var(--purple-25);
    border: 1px solid var(--purple-100);
  }
  .ins-ico {
    flex: 0 0 auto; width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; font-size: 14px;
    background: var(--purple-100); color: var(--purple-700);
  }
  .ins-body { min-width: 0; }
  .ins-body b { display: block; font-size: 12px; color: var(--ink); margin-bottom: 2px; letter-spacing: .1px; }
  .ins-body p { margin: 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.6; }
  .ins-body p b { display: inline; font-weight: 700; color: var(--purple-700); }

  .dist { display: flex; flex-direction: column; gap: 10px; }
  .dist-row { display: grid; grid-template-columns: 62px 1fr auto; align-items: center; gap: 10px; }
  .dist-name { font-size: 12px; color: var(--ink-2); white-space: nowrap; }
  .dist-track { position: relative; height: 8px; background: var(--purple-50); border-radius: 999px; overflow: hidden; }
  .dist-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 999px; transition: width .3s ease; }
  .dist-val { font-family: var(--mono); font-size: 11px; color: var(--muted); white-space: nowrap; }

  /* ── 图表 ── */
  .charts { display: grid; grid-template-columns: 320px 1fr; gap: 28px; align-items: stretch; }
  .chart { display: flex; flex-direction: column; min-width: 0; }
  .chart-title {
    font-size: 11px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; color: var(--muted); margin-bottom: 16px;
  }

  /* 环形图 */
  .donut-wrap { position: relative; width: 180px; height: 180px; margin: 0 auto 18px; }
  .donut { display: block; }
  .donut circle { transition: stroke-width .16s ease, opacity .16s ease; }
  .donut circle:hover { stroke-width: 28; }
  .donut-center {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; pointer-events: none;
  }
  .donut-center b { font-size: 18px; font-weight: 800; color: var(--purple-700); letter-spacing: -.3px; }
  .donut-center span { font-size: 10.5px; color: var(--muted); }

  .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .legend li { display: flex; align-items: center; gap: 9px; font-size: 12px; }
  .lg-dot { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 auto; box-shadow: 0 0 0 1px rgba(124,58,237,.1); }
  .lg-label { flex: 1; min-width: 0; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lg-val { flex: 0 0 auto; font-family: var(--mono); font-size: 11px; color: var(--muted); }

  /* 瀑布时间线 */
  .chart-title { display: flex; align-items: center; gap: 8px; }
  .chart-count {
    margin-left: auto; font-weight: 600; letter-spacing: 0;
    text-transform: none; font-size: 11px; color: var(--purple-500);
  }
  .wf-wrap { position: relative; flex: 1 1 auto; }
  .wf { display: flex; flex-direction: column; gap: 8px; }
  /* 自适应填满左侧环形图列的高度：只有内容超出才内部滚动 */
  .wf-wrap.scrollable {
    min-height: 0; max-height: min(480px, 70vh);
    overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
    padding-right: 10px; scrollbar-width: thin;
    scrollbar-color: var(--purple-300) var(--purple-50);
  }
  .wf-wrap.scrollable:hover { scrollbar-color: var(--purple-400) var(--purple-50); }
  .wf-wrap.scrollable::-webkit-scrollbar { width: 6px; }
  .wf-wrap.scrollable::-webkit-scrollbar-track { background: var(--purple-50); border-radius: 999px; }
  .wf-wrap.scrollable::-webkit-scrollbar-thumb { background: var(--purple-300); border-radius: 999px; }
  .wf-wrap.scrollable::-webkit-scrollbar-thumb:hover { background: var(--purple-400); }

  .wf-row { display: grid; grid-template-columns: 170px 1fr 74px; align-items: center; gap: 12px; }
  .wf-name {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 12px; color: var(--ink-2);
    overflow: hidden;
  }
  .wf-txt {
    min-width: 0; flex: 0 1 auto;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wf-name i {
    font-style: normal; font-family: var(--mono); font-weight: 700;
    font-size: 10.5px; color: var(--purple-500); min-width: 16px;
  }
  .wf-track { position: relative; height: 10px; background: var(--purple-50); border-radius: 999px; overflow: hidden; }
  .wf-bar {
    position: absolute; top: 0; bottom: 0; border-radius: 999px;
    background: linear-gradient(90deg, var(--purple-500), var(--purple-400));
    transition: background .15s ease, transform .15s ease;
  }
  .wf-row:hover .wf-bar { background: linear-gradient(90deg, var(--purple-700), var(--purple-500)); transform: scaleY(1.18); }
  .wf-dur {
    text-align: right; font-family: var(--mono); font-size: 11px;
    font-weight: 600; color: var(--purple-700);
  }

  /* ── 附件 ── */
  .att-list {
    display: flex; flex-direction: column; gap: 6px;
    max-height: min(360px, 50vh);
    overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
    padding-right: 8px; scrollbar-width: thin;
    scrollbar-color: var(--purple-300) var(--purple-50);
  }
  .att-list:hover { scrollbar-color: var(--purple-400) var(--purple-50); }
  .att-list::-webkit-scrollbar { width: 6px; }
  .att-list::-webkit-scrollbar-track { background: var(--purple-50); border-radius: 999px; }
  .att-list::-webkit-scrollbar-thumb { background: var(--purple-300); border-radius: 999px; }
  .att-list::-webkit-scrollbar-thumb:hover { background: var(--purple-400); }
  .att {
    display: flex; align-items: center; gap: 11px;
    padding: 10px 14px;
    background: var(--purple-25);
    border: 1px solid var(--purple-100);
    border-radius: var(--r-sm);
    font-size: 12.5px;
  }
  .att-icon { font-size: 14px; }
  .att-name { font-weight: 600; color: var(--ink); }
  .att-type { font-size: 10.5px; color: var(--purple-700); background: var(--purple-50); border: 1px solid var(--purple-100); padding: 1px 7px; border-radius: 5px; }
  .att-size { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .empty { color: var(--muted); text-align: center; padding: 18px; font-size: 13px; }

  /* ── AI 推理日志 ── */
  .heal-card { border-color: var(--purple-200); }
  .heal-timeline {
    position: relative; padding-left: 8px;
    display: flex; flex-direction: column; gap: 0;
  }
  .heal-entry {
    position: relative; display: flex; gap: 14px; padding: 0 0 20px 0;
  }
  .heal-entry:last-child { padding-bottom: 0; }
  .heal-entry::before {
    content: ''; position: absolute; left: 5px; top: 18px; bottom: -4px;
    width: 2px; background: var(--purple-100);
  }
  .heal-entry:last-child::before { display: none; }
  .heal-dot {
    flex: 0 0 auto; width: 12px; height: 12px; border-radius: 50%;
    margin-top: 4px; border: 2px solid; z-index: 1;
  }
  .heal-content { flex: 1; min-width: 0; }
  .heal-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .heal-tag {
    display: inline-flex; align-items: center;
    padding: 2px 9px; border-radius: 999px;
    font-size: 10.5px; font-weight: 700; letter-spacing: .3px;
  }
  .heal-title { font-size: 13.5px; font-weight: 600; color: var(--ink); }
  .heal-time { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .heal-detail {
    margin-top: 6px; padding: 10px 14px;
    background: var(--purple-25); border: 1px solid var(--purple-100);
    border-radius: var(--r-sm);
    font-size: 12.5px; color: var(--ink-2); line-height: 1.65;
  }

  /* ── 错误 ── */
  .error-card { border-color: var(--err-100); background: var(--err-50); }
  .error-card h2 { color: var(--err-700); }
  .error-card h2 .h-ico { background: var(--err-600); color: #fff; }
  .error-stack {
    margin: 10px 0 0; padding: 12px 15px;
    background: #fff; border: 1px solid var(--err-100); border-radius: var(--r-sm);
    font-family: var(--mono); font-size: 12px; color: var(--err-700);
    white-space: pre-wrap; overflow-x: auto;
  }

  /* ── 视频 ── */
  .video-card { padding: 0; overflow: hidden; }
  .video-head {
    display: flex; align-items: center; gap: 9px;
    padding: 18px 28px; cursor: pointer;
    font-size: 14px; font-weight: 700; color: var(--ink);
  }
  .video-head .s-chev { transition: transform .18s ease; }
  .video-card.open .video-head .s-chev { transform: rotate(90deg); }
  .video-body { display: none; padding: 0 28px 28px; }
  .video-card.open .video-body { display: block; }
  .video-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 0; }
  .video-name { font-size: 12px; color: var(--muted); font-family: var(--mono); }
  .btn-fs {
    border: 1px solid var(--purple-200);
    background: var(--purple-50); color: var(--purple-700);
    font-size: 12px; font-weight: 600;
    padding: 6px 14px; border-radius: 999px; cursor: pointer;
    transition: background .15s ease, color .15s ease, border-color .15s ease;
  }
  .btn-fs:hover { background: var(--purple-600); border-color: var(--purple-600); color: #fff; }
  .video-stage {
    position: relative; width: 100%; max-width: 980px; margin: 0 auto;
    aspect-ratio: 16 / 9; border-radius: 14px; overflow: hidden;
    background: #0b0b12;
    box-shadow: 0 12px 32px rgba(24,16,64,.18), 0 0 0 1px var(--purple-200);
  }
  .video-stage video {
    display: block; width: 100%; height: 100%; object-fit: contain;
    background: #000; border: none;
  }
  video::backdrop { background: #000; }

  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 8px 0 32px; }

  /* 回到顶部按钮 */
  #back-to-top {
    position: fixed; right: 28px; bottom: 28px; z-index: 900;
    width: 44px; height: 44px; border-radius: 50%;
    border: none; cursor: pointer;
    background: var(--purple-600); color: #fff;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 16px rgba(124,58,237,.35);
    opacity: 0; visibility: hidden; transform: translateY(10px);
    transition: opacity .25s ease, visibility .25s ease, transform .25s ease, background .15s ease;
  }
  #back-to-top.visible { opacity: 1; visibility: visible; transform: translateY(0); }
  #back-to-top:hover { background: var(--purple-700); box-shadow: 0 6px 20px rgba(124,58,237,.45); }
  #back-to-top:active { transform: translateY(1px); }

  @media (max-width: 900px) {
    .charts { grid-template-columns: 1fr; }
    .analysis { grid-template-columns: 1fr; }
  }
  @media (max-width: 640px) {
    .hero { padding: 28px 20px 26px; }
    .hero h1 { font-size: 20px; }
    .container { margin-top: -18px; }
    .card { padding: 20px 16px; }
    .s-head { padding: 12px 14px; }
    .s-lv0 > .s-body > .s-children { margin-left: 4px; padding-left: 10px; }
    .wf-row { grid-template-columns: 88px 1fr 58px; gap: 8px; }
    .wf-name { font-size: 11.5px; }
    .sum-hero { flex-wrap: wrap; gap: 14px; padding: 18px 18px; }
    .sum-hero-metric { padding-left: 14px; }
    .sum-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  }
</style>
</head>
<body>
  <header class="hero ${testStatus === 'passed' ? 'passed' : 'failed'}">
    <div class="hero-inner">
      <div class="hero-top">
        <div class="hero-brand">
          <div class="report-logo">${REPORT_LOGO}</div>
          <div>
            <h1>${escapeHtml(reportTitle)}</h1>
            ${test.title ? `<div class="subtitle">原用例：${escapeHtml(test.title)}</div>` : ''}
          </div>
        </div>
        <span class="badge-status ${testStatus === 'passed' ? 'passed' : 'failed'}">${testStatus.toUpperCase()}</span>
      </div>
      <div class="hero-meta">
        <span class="meta-chip">${ICONS.file}<b>${escapeHtml(fileInfo.fileName)}</b></span>
        <span class="meta-chip">${ICONS.globe}<b>${escapeHtml(projectName)}</b></span>
        <span class="meta-chip">${ICONS.timer}<b>${formatDuration(totalDuration)}</b></span>
        <span class="meta-chip">${ICONS.calendar}<b>${formatTime(startTime)}</b></span>
        ${retryCount > 0 ? `<span class="meta-chip">${ICONS.refresh}重试 <b>${retryCount}</b></span>` : ''}
      </div>
    </div>
  </header>

  <main class="container">
    <section class="card">
      <h2><span class="h-ico">${ICONS.summary}</span>测试概要</h2>
      <div class="summary">
        <div class="sum-hero ${testStatus === 'passed' ? 'passed' : 'failed'}">
          <div class="sum-hero-icon">${testStatus === 'passed' ? ICONS.check : ICONS.x}</div>
          <div class="sum-hero-body">
            <div class="sum-hero-label">执行状态</div>
            <div class="sum-hero-value">${testStatus === 'passed' ? '通过' : '失败'}</div>
            <div class="sum-hero-sub">${testStatus === 'passed' ? '全部断言通过，用例执行成功' : '存在失败断言或运行异常'}</div>
          </div>
          <div class="sum-hero-metric">
            <span>总耗时</span>
            <b>${formatDuration(totalDuration)}</b>
          </div>
          <div class="sum-hero-metric">
            <span>重试</span>
            <b>${retryCount}</b>
          </div>
        </div>

        <div class="sum-grid">
          ${sumItem(ICONS.steps, '执行步骤', mainStepCount)}
          ${sumItem(ICONS.browser, '运行浏览器', projectName, true)}
          ${sumItem(ICONS.clock, '开始时间', formatTime(startTime), true)}
          ${sumItem(ICONS.flag, '结束时间', endTimeIso ? formatTime(endTimeIso) : '-', true)}
        </div>

        ${(() => {
          // 测试结果分布饼图（通过/失败/跳过/不稳定）
          const passed = steps.filter(s => !HOOK_RE.test(s.title) && s.error == null).length;
          const failed = steps.filter(s => !HOOK_RE.test(s.title) && s.error != null).length;
          const flaky = 0; // Playwright JSON 中不稳定标记需从 annotations 获取，暂默认 0
          const skipped = mainStepCount - passed - failed - flaky;
          const total = mainStepCount || 1;
          const PALETTE = {
            ok:   { from: '#4ade80', to: '#15803d', bg: '#f0fdf4' },
            err:  { from: '#fb7185', to: '#b91c1c', bg: '#fef2f2' },
            warn: { from: '#fbbf24', to: '#b45309', bg: '#fffbeb' },
            mute: { from: '#cbd5e1', to: '#71717a', bg: '#f8fafc' },
          };
          const segments = [
            { name: '通过',   count: passed,  ...PALETTE.ok },
            { name: '失败',   count: failed,  ...PALETTE.err },
            { name: '不稳定', count: flaky,   ...PALETTE.warn },
            { name: '跳过',   count: skipped < 0 ? 0 : skipped, ...PALETTE.mute },
          ].filter(s => s.count > 0);
          if (segments.length === 0) return '';

          const CX = 90, CY = 90, R = 64, SW = 17;
          const CIRC = 2 * Math.PI * R;
          const multi = segments.length > 1;
          const gapLen = multi ? SW + 6 : 0;
          let acc = 0;

          const defs = segments.map((s, i) =>
            `<linearGradient id="pieGrad${i}" x1="0" y1="0" x2="0.75" y2="1">`
            + `<stop offset="0%" stop-color="${s.from}"/><stop offset="100%" stop-color="${s.to}"/></linearGradient>`
          ).join('') + `<filter id="pieArcShadow" x="-30%" y="-30%" width="160%" height="160%">`
            + `<feDropShadow dx="0" dy="2.5" stdDeviation="3" flood-color="#1e1b2e" flood-opacity=".18"/></filter>`;

          const arcs = segments.map((s, i) => {
            const frac = s.count / total;
            const raw = frac * CIRC;
            const len = Math.max(3, raw - gapLen);
            const seg = `<circle class="pie-arc" cx="${CX}" cy="${CY}" r="${R}" fill="none" `
              + `stroke="url(#pieGrad${i})" stroke-width="${SW}" stroke-linecap="${multi ? 'round' : 'butt'}" `
              + `stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" `
              + `transform="rotate(-90 ${CX} ${CY})" filter="url(#pieArcShadow)">`
              + `<title>${s.name} · ${s.count} 步 · ${Math.round(frac * 100)}%</title></circle>`;
            acc += raw;
            return seg;
          }).join('');

          const legend = segments.map(s => {
            const p = Math.round((s.count / total) * 100);
            return `<li class="sp-item" style="--c:${s.to};--c-end:${s.from};--bg:${s.bg}">
                <span class="sp-ring"></span>
                <span class="sp-name">${s.name}</span>
                <span class="sp-bar"><i style="width:${p}%"></i></span>
                <span class="sp-meta"><b>${s.count}</b>/ ${total}</span>
                <span class="sp-pct">${p}%</span>
              </li>`;
          }).join('');

          const statusColor = testStatus === 'passed' ? 'var(--ok-600)' : 'var(--err-600)';
          const pct = Math.round((passed / total) * 100);
          return `<div class="sum-pie">
            <div class="sum-pie-head">
              <span class="sum-pie-title">测试结果分布</span>
              <span class="sum-pie-note">共 ${total} 个步骤 · ${segments.length} 种状态</span>
            </div>
            <div class="sum-pie-body">
              <div class="sum-pie-chart">
                <svg viewBox="0 0 180 180" role="img" aria-label="测试结果分布">
                  <defs>${defs}</defs>
                  <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--purple-50)" stroke-width="${SW}" />
                  ${arcs}
                </svg>
                <div class="sum-pie-center">
                  <b style="color:${statusColor}">${pct}<em>%</em></b>
                  <span>通过率</span>
                  <i>${passed}/${total} 步通过</i>
                </div>
              </div>
              <ul class="sum-pie-legend">${legend}</ul>
            </div>
          </div>`;
        })()}
      </div>
    </section>

    ${generateHealingLogHTML()}

    ${generateInsightsHTML()}

    ${generateChartsHTML()}

    ${generateErrorsHTML()}

    <section class="card">
      <h2><span class="h-ico">${ICONS.steps}</span>执行步骤<span class="h-hint">含源码的步骤可点击展开</span><button type="button" class="s-expand-all" onclick="toggleAllSteps(this)">全部展开</button></h2>
      <div class="steps">
        ${generateStepsHTML()}
      </div>
    </section>

    ${video ? `
    <section class="card video-card">
      <div class="video-head" onclick="this.parentElement.classList.toggle('open')">
        <svg class="s-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="h-ico" style="background:var(--ink);color:#fff;width:22px;height:22px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center">${ICONS.video}</span>
        完整运行录像
      </div>
      <div class="video-body">
        <div class="video-bar">
          <span class="video-name">运行录像 · webm</span>
          <button type="button" class="btn-fs" onclick="toggleVideoFullscreen(this)">全屏播放</button>
        </div>
        <div class="video-stage">
          <video id="run-video" controls playsinline preload="metadata"${poster ? ` poster="${poster}"` : ''}>
            <source src="${video}" type="video/webm">
            您的浏览器不支持视频播放。
          </video>
        </div>
      </div>
    </section>` : ''}

    <section class="card">
      <h2><span class="h-ico">${ICONS.attach}</span>附件 (${visibleAttachments.length})</h2>
      ${generateAttachmentsHTML()}
    </section>

    <footer>由自定义报告生成器输出 · 数据来源于 Playwright 原生报告</footer>
  </main>

  <!-- 图片放大预览 -->
  <div class="lightbox" id="lightbox">
    <div class="lightbox-tools">
      <button type="button" onclick="zoomBy(-1)" title="缩小">−</button>
      <span class="zoom-val" id="zoom-value">100%</span>
      <button type="button" onclick="zoomBy(1)" title="放大">＋</button>
      <button type="button" onclick="resetZoom()" title="重置">⟲</button>
    </div>
    <button type="button" class="lightbox-close" onclick="closeLightbox()" aria-label="关闭">✕</button>
    <img id="lightbox-img" alt="" />
    <div class="lightbox-hint">滚轮缩放 · 拖动平移 · 双击复位 · Esc 关闭</div>
  </div>

  <!-- 回到顶部 -->
  <button type="button" id="back-to-top" aria-label="回到顶部" title="回到顶部">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
  </button>

  <script>
    // 页面加载时强制滚到顶部
    window.addEventListener('DOMContentLoaded', function() { window.scrollTo(0, 0); });
    window.addEventListener('load', function() { window.scrollTo(0, 0); });
    if (document.readyState === 'complete') { window.scrollTo(0, 0); }

    // 回到顶部按钮
    (function() {
      var btn = document.getElementById('back-to-top');
      if (!btn) return;
      window.addEventListener('scroll', function() {
        if (window.scrollY > 300) {
          btn.classList.add('visible');
        } else {
          btn.classList.remove('visible');
        }
      }, { passive: true });
      btn.addEventListener('click', function() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    })();

    // ── 卡片入场动画（IntersectionObserver）──
    (function() {
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

      document.querySelectorAll('.card, .heal-entry, .s-lv0').forEach(function(el) {
        observer.observe(el);
      });
    })();

    // ── 推理日志逐条延迟入场 ──
    (function() {
      var entries = document.querySelectorAll('.heal-entry');
      entries.forEach(function(el, i) {
        el.style.transitionDelay = (i * 120) + 'ms';
      });
    })();

    // ── 数值计数动画 ──
    (function() {
      function countUp(el, target, duration) {
        var start = 0;
        var startTime = null;
        function step(ts) {
          if (!startTime) startTime = ts;
          var progress = Math.min((ts - startTime) / duration, 1);
          var eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(start + (target - start) * eased);
          if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      }
      document.querySelectorAll('[data-count]').forEach(function(el) {
        var target = parseInt(el.getAttribute('data-count'), 10);
        if (!isNaN(target) && target > 0) {
          var observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
              if (entry.isIntersecting) {
                countUp(el, target, 800);
                observer.unobserve(entry.target);
              }
            });
          }, { threshold: 0.5 });
          observer.observe(el);
        }
      });
    })();

    // ── 推理日志末尾光标闪烁（2.5秒后消失）──
    (function() {
      var lastDetail = document.querySelector('.heal-entry:last-child .heal-detail');
      if (lastDetail) {
        var cursor = document.createElement('span');
        cursor.className = 'heal-cursor';
        lastDetail.appendChild(cursor);
        setTimeout(function() { cursor.remove(); }, 2500);
      }
    })();

    function toggleStep(head) {
      var el = head.parentElement;
      if (!el.classList.contains('expandable')) return;
      el.classList.toggle('open');
    }

    // 执行步骤：全部展开 / 收起
    function toggleAllSteps(btn) {
      var cards = Array.prototype.slice.call(document.querySelectorAll('.steps > .s-lv0.expandable'));
      if (!cards.length) return;
      var anyCollapsed = cards.some(function (c) { return !c.classList.contains('open'); });
      cards.forEach(function (c) { c.classList.toggle('open', anyCollapsed); });
      btn.textContent = anyCollapsed ? '全部收起' : '全部展开';
    }

    // ── 图片放大预览（滚轮缩放 / 拖动平移 / 双击复位） ──
    var lbView = { scale: 1, x: 0, y: 0, dragging: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
    var MIN_SCALE = 0.3, MAX_SCALE = 10;

    function lbEls() {
      return {
        lb: document.getElementById('lightbox'),
        img: document.getElementById('lightbox-img'),
        val: document.getElementById('zoom-value')
      };
    }
    function applyView() {
      var e = lbEls();
      if (!e.img) return;
      e.img.style.transform = 'translate(' + lbView.x.toFixed(2) + 'px,' + lbView.y.toFixed(2) + 'px) scale(' + lbView.scale.toFixed(4) + ')';
      if (e.val) e.val.textContent = Math.round(lbView.scale * 100) + '%';
    }
    function zoomAt(px, py, k) {
      var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, lbView.scale * k));
      k = next / lbView.scale;
      if (k === 1) return;
      // px/py 为相对容器中心的坐标，缩放时保持光标下的点不动
      lbView.x += (px - lbView.x) * (1 - k);
      lbView.y += (py - lbView.y) * (1 - k);
      lbView.scale = next;
      applyView();
    }
    function zoomBy(dir) {
      var e = lbEls();
      var r = e.lb.getBoundingClientRect();
      zoomAt(0, 0, dir > 0 ? 1.25 : 1 / 1.25);
    }
    function resetZoom() { lbView.scale = 1; lbView.x = 0; lbView.y = 0; applyView(); }

    function openLightbox(src, alt) {
      var e = lbEls();
      e.img.src = src;
      e.img.alt = alt || '';
      lbView = { scale: 1, x: 0, y: 0, dragging: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
      applyView();
      e.lb.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeLightbox() {
      var e = lbEls();
      if (!e.lb) return;
      e.lb.classList.remove('open');
      e.img.src = '';
      e.img.style.transform = '';
      document.body.style.overflow = '';
      lbView.moved = true; // 防止关闭后触发背景点击
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeLightbox();
    });

    (function initLightbox() {
      var e = lbEls();
      if (!e.lb) return;
      // 滚轮缩放（阻止页面滚动）
      e.lb.addEventListener('wheel', function (ev) {
        if (!e.lb.classList.contains('open')) return;
        ev.preventDefault();
        var r = e.lb.getBoundingClientRect();
        var px = ev.clientX - r.left - r.width / 2;
        var py = ev.clientY - r.top - r.height / 2;
        zoomAt(px, py, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
      }, { passive: false });

      // 拖动平移
      e.img.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        lbView.dragging = true; lbView.moved = false;
        lbView.sx = ev.clientX; lbView.sy = ev.clientY;
        lbView.ox = lbView.x; lbView.oy = lbView.y;
        e.img.classList.add('grabbing');
      });
      window.addEventListener('mousemove', function (ev) {
        if (!lbView.dragging) return;
        var dx = ev.clientX - lbView.sx, dy = ev.clientY - lbView.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) lbView.moved = true;
        lbView.x = lbView.ox + dx;
        lbView.y = lbView.oy + dy;
        applyView();
      });
      window.addEventListener('mouseup', function () {
        if (!lbView.dragging) return;
        lbView.dragging = false;
        e.img.classList.remove('grabbing');
      });

      // 双击：放大到 2.5x / 复位
      e.img.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        if (lbView.scale > 1.01) { resetZoom(); return; }
        var r = e.lb.getBoundingClientRect();
        zoomAt(ev.clientX - r.left - r.width / 2, ev.clientY - r.top - r.height / 2, 2.5);
      });

      // 点击空白处关闭
      e.lb.addEventListener('click', function (ev) {
        if (ev.target === e.lb && !lbView.moved) closeLightbox();
      });

      // 触摸：单指平移 / 双指捏合缩放
      var touch = null;
      e.img.addEventListener('touchstart', function (ev) {
        if (ev.touches.length === 1) {
          touch = { mode: 'pan', x: ev.touches[0].clientX, y: ev.touches[0].clientY, ox: lbView.x, oy: lbView.y };
        } else if (ev.touches.length === 2) {
          var d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
          touch = { mode: 'pinch', dist: d || 1, scale: lbView.scale };
        }
      }, { passive: true });
      e.img.addEventListener('touchmove', function (ev) {
        if (!touch) return;
        ev.preventDefault();
        if (touch.mode === 'pan' && ev.touches.length === 1) {
          lbView.x = touch.ox + (ev.touches[0].clientX - touch.x);
          lbView.y = touch.oy + (ev.touches[0].clientY - touch.y);
          applyView();
        } else if (touch.mode === 'pinch' && ev.touches.length === 2) {
          var d2 = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
          lbView.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, touch.scale * (d2 / touch.dist)));
          applyView();
        }
      }, { passive: false });
      e.img.addEventListener('touchend', function () { touch = null; });
    })();

    // 视频全屏
    function toggleVideoFullscreen(btn) {
      var v = document.getElementById('run-video');
      if (!v) return;
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (v.requestFullscreen) {
        v.requestFullscreen();
      } else if (v.webkitRequestFullscreen) {
        v.webkitRequestFullscreen();
      } else if (v.webkitEnterFullscreen) {
        v.webkitEnterFullscreen();
      }
    }
    document.addEventListener('fullscreenchange', function () {
      var btn = document.querySelector('.btn-fs');
      if (btn) btn.textContent = document.fullscreenElement ? '退出全屏' : '全屏播放';
    });
  </script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, html, 'utf8');
console.log(`✅ 自定义报告已生成: ${outputFile}`);
console.log(`   - 顶层步骤: ${steps.length}，节点总数: ${totalStepNodes}`);
console.log(`   - 附件数: ${visibleAttachments.length}`);
console.log(`   - 视频: ${video ? '已嵌入' : '未找到'}`);

// 清理多余的录制视频（新标签页产生的短视频），磁盘上只留最终录像
extraVideoAttachments.forEach(a => {
  if (!a.path) return;
  const p = path.join(reportDir, a.path);
  try {
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`   - 🧹 已删除多余录像: ${a.path}`); }
  } catch { /* ignore */ }
});
