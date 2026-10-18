// Real-browser layout regression test for rendered Markdown/LaTeX.
//
// The page is built exactly like the frontend tests do (actual index.html,
// actual pinned markdown-it/DOMPurify/KaTeX/texmath, simulated Supabase with
// SYNTHETIC research-style content only), expanded, serialized, and then laid
// out by a locally installed Chrome/Chromium in headless mode at desktop and
// phone widths. A measuring script reports clipping and overflow.
// jsdom cannot do layout, so these checks need a real browser: set CHROME_PATH
// if Chrome is not found automatically. Without a browser the test reports
// SKIPPED instead of passing.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,cp,access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const require = createRequire(join(resolve(process.env.TRACKER_TEST_DEPS || '.'),'package.json'));
const {JSDOM} = require('jsdom');

const candidates = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
let chrome = null;
for (const path of candidates) { try { await access(path); chrome = path; break; } catch {} }
if (!chrome) { console.log('SKIPPED: layout checks need Chrome/Chromium (set CHROME_PATH). Nothing was verified.'); process.exit(0); }

const katexDir = dirname(require.resolve('katex'));
const libraryScripts = await Promise.all([
  join(dirname(require.resolve('markdown-it')),'browser/markdown-it.umd.min.js'),
  join(dirname(require.resolve('dompurify')),'purify.min.js'),
  join(katexDir,'katex.min.js'),
  require.resolve('markdown-it-texmath')
].map(path => readFile(path,'utf8')));
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
let checks = 0;
function check(actual,expected,label) { assert.deepEqual(actual,expected,label); checks++; }

// Synthetic content shaped like real research ideas: long Chinese paragraphs,
// bold labels, nested lists, Markdown-escaped stars inside math, long inline
// formulas, \( \) / \[ \] delimiters, a wide display equation, a wide table,
// a long code line and long unbreakable tokens. No real research text.
const longChinese = '这是一个用于回归测试的合成段落，模拟包含中文长句、英文术语与数学记号混排的研究想法说明。'.repeat(6);
const markdown = `# 合成测试想法：数据无关的知识蒸馏与重建

**Target task:** ML/CV 框架下的 data-free 下游任务：(i) 公开 benchmark 上的 training-data reconstruction，对齐公开 setup 与 \`synthetic-repo\` 代码库；(ii) data-free knowledge distillation（例如 DeepInversion 类方法）。全部单 GPU 可跑，不需要 domain collaborator、私有数据或湿实验。${longChinese}

**Must preserve:**

- 未知量是**测度**，不是有限个点。任何把方法退化成 "优化 $M$ 张候选图" 的实现都不算实现本方法。${longChinese}
- KKT stationarity 以**精确等式约束**进入，不作为 loss 上再加一项的 soft regularizer。
- 总质量 $\\nu(\\mathcal{M}) = \\|\\theta^{\\*}\\|^2/L$ 由 Euler 恒等式给定，不许当超参拟合。
  - 嵌套：reference prior $\\pi$ 必须显式声明且可替换；全部未被矩约束决定的自由度都归到 $\\pi$ 上。
    - 第三层：残差证书 (moment residual + margin residual，含 held-out sketch 方向) 必须在无任何训练数据访问下可计算。
- 诚实边界：被 $\\theta^\\*$ 约束的只有 margin measure (support vectors)，内点样本不受约束。
- 长行内公式：$\\mathcal{L}(\\theta)=\\sum_{i=1}^{n}\\lambda_i\\,\\ell\\big(y_i f_\\theta(x_i)\\big)+\\frac{\\beta}{2}\\|\\theta\\|_2^2+\\gamma\\,\\mathrm{KL}\\big(q_\\phi(z\\mid x)\\,\\|\\,p(z)\\big)+\\sum_{k=1}^{K}\\mu_k\\big(\\langle\\phi_k,\\nu\\rangle-m_k\\big)^2+\\sum_{j=1}^{J}\\eta_j\\,\\mathbb{E}_{x\\sim\\nu}\\big[g_j(x)\\big]$ 之后继续中文说明。
- 不可断行公式：$\\underbrace{\\text{这是一个很长的不可断行的数学说明文本，用于测试窄屏下的溢出处理与横向滚动行为}}_{\\text{unbreakable}}$ 后面的文字仍应可读。
- 括号定界：行内 \\(\\nu \\ll \\pi\\) 与 \\(\\int_{\\mathcal{M}} \\phi\\,d\\nu = m\\) 都应渲染。
- 长链接 https://example.org/a/very/long/path/without/natural/break/points/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 与长单词 supercalifragilisticexpialidocioussupercalifragilisticexpialidocioussupercalifragilisticexpialidocious。

\\[
\\int_{\\mathcal{M}} \\phi_k \\, d\\nu = m_k, \\qquad k = 1, \\dots, K
\\]

$$
\\theta^{*} = \\sum_{j=1}^{J} \\alpha_j \\nabla_\\theta f(x_j;\\theta^{*}) \\quad\\text{s.t.}\\quad \\alpha_j \\ge 0,\\ \\sum_{j}\\alpha_j = 1,\\ \\|\\theta^{*}\\|_2^2 = L\\,\\nu(\\mathcal{M}) + \\epsilon_{\\mathrm{res}} + \\delta_{\\mathrm{margin}} + \\zeta_{\\mathrm{sketch}} + \\xi_{\\mathrm{held\\text{-}out}} + \\omega_{\\mathrm{prior}}
$$

| 组件 | 说明 | 约束 | 备注 | 额外列一 | 额外列二 | 额外列三 |
| --- | --- | --- | --- | --- | --- | --- |
| 先验 $\\pi$ | 可替换的参考先验，必须显式声明 | 无 | 这是一段很长的表格单元格内容，用于测试表格横向滚动 | aaaaaaaaaaaa | bbbbbbbbbbbb | cccccccccccc |

\`\`\`python
synthetic_configuration = {"learning_rate": 0.001, "batch_size": 256, "num_steps": 100000, "prior": "gaussian", "residual_tolerance": 1e-6}
\`\`\`
`;
const comment = `回复：${longChinese} 关键量 $\\|\\theta^{\\*}\\|$ 与 \\(\\nu(\\mathcal{M})\\) 已核对；$\\text{评论里同样很长的不可断行公式文本，用于测试溢出处理}$。`;

const profiles = [{id:'member-0',display_name:'Shibo',role:'pi',active:true}];
const idea = {id:'idea-layout',idea_number:1000,title:'合成测试想法：一个很长的标题用于检查卡片标题在窄屏上的换行与可读性 data-free distillation',
  description:markdown,week_start:'2026-10-12',priority:'high',created_by:'member-0',revision:1,created_at:'2026-10-12T14:00:00Z',updated_at:'2026-10-12T14:00:00Z'};
const comments = [{id:'comment-layout',idea_id:idea.id,author_id:'member-0',body:comment,client_request_id:'00000000-0000-4000-8000-000000000001',
  created_at:'2026-10-13T00:00:00Z',removed_at:null,removed_by:null,parent_comment_id:null}];
const rows = {profiles,ideas:[idea],idea_participants:[],idea_comments:comments,idea_events:[]};
const query = table => { const builder = {select(){return this;},order(){return this;},eq(){return this;},lt(){return this;},range(){return this;},limit(){return this;},maybeSingle(){this.single=true;return this;},
  then(done){ const data = JSON.parse(JSON.stringify(rows[table] || [])); done({data:this.single ? data[0] || null : data,error:null}); }}; return builder; };
const client = {from:query,realtime:{async setAuth(){}},async removeChannel(){},async rpc(){throw new Error('no RPC in layout test');},
  channel(){return {on(){return this;},subscribe(callback){setTimeout(() => callback('SUBSCRIBED'),0);return this;}};},
  auth:{onAuthStateChange(callback){setTimeout(() => callback('INITIAL_SESSION',{user:{id:'member-0'},access_token:'synthetic'}),0);},async getSession(){return {data:{session:null},error:null};}}};

const dom = new JSDOM(html,{url:'http://127.0.0.1:8765/autoresearch-idea-tracker/',runScripts:'outside-only',pretendToBeVisual:true});
const w = dom.window, d = w.document;
w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
libraryScripts.forEach((source,index) => w.eval(source + (index === 3 ? '\nwindow.texmath=texmath;' : '')));
w.HTMLDialogElement.prototype.showModal = function(){this.open = true;};
w.HTMLDialogElement.prototype.close = function(){this.open = false;};
w.supabase = {createClient:() => client};
w.eval(script + '\nwindow.__app = {state,fitInlineMath};');
for (let n = 0; n < 200 && !(w.__app.state.loaded && d.querySelector('.idea')); n++) await new Promise(r => setTimeout(r,5));
d.getElementById('expand-all').click();
await new Promise(r => setTimeout(r,50));
check(!!d.querySelector('.idea[open] .description .katex-display'),true,'synthetic idea rendered with display math');
w.clearInterval(w.__app.state.pollTimer);

// Serialize the rendered page; KaTeX CSS and fonts are served locally so the
// layout does not depend on network access.
const dir = await mkdtemp(join(tmpdir(),'tracker-layout-'));
const copy = d.documentElement.cloneNode(true);
copy.querySelectorAll('script,meta[http-equiv]').forEach(el => el.remove());
copy.querySelectorAll('link[rel=stylesheet]').forEach(el => el.setAttribute('href','katex.min.css'));
// The app's scripts are not shipped to Chrome (no Supabase or CDN there), so the
// page's own layout-dependent helper is injected verbatim from index.html.
const measure = d.createElement('script');
measure.textContent = `window.fitInlineMath = ${w.__app.fitInlineMath.toString()};\n(${function measureLayout() {
  const report = result => {
    if (window.parent !== window) window.parent.postMessage(JSON.stringify(result),'*');
    else { const out = document.createElement('pre'); out.id = 'layout-result'; out.textContent = JSON.stringify(result); document.body.append(out); }
  };
  const scrollerBetween = (el,stop) => {
    for (let node = el.parentElement; node && node !== stop; node = node.parentElement) {
      if (['auto','scroll'].includes(getComputedStyle(node).overflowX)) return true;
    }
    return false;
  };
  Promise.all([document.fonts.ready,new Promise(r => setTimeout(r,300))]).then(() => {
    window.fitInlineMath(); // the page's own function, as it runs after rendering
    const root = document.documentElement, result = {viewport:root.clientWidth,pageOverflow:root.scrollWidth - root.clientWidth,cards:[]};
    for (const card of document.querySelectorAll('.idea[open]')) {
      const box = card.getBoundingClientRect(), week = card.closest('.week').getBoundingClientRect();
      const clipped = [];
      for (const el of card.querySelectorAll('p,li,h1,h2,h3,blockquote,.katex,.katex-display,pre,table,.comment-main,.idea-title,.composer')) {
        const r = el.getBoundingClientRect();
        if (!r.width || scrollerBetween(el,card)) continue;
        if (r.right > box.right + 1 || r.left < box.left - 1) clipped.push(`${el.tagName.toLowerCase()}.${el.className || ''} +${Math.round(r.right - box.right)}px "${el.textContent.trim().slice(0,30)}"`);
      }
      const wide = [...card.querySelectorAll('.katex-display,pre,table')].filter(el => el.scrollWidth > el.clientWidth + 1)
        .map(el => ({tag:el.tagName.toLowerCase(),scrolls:['auto','scroll'].includes(getComputedStyle(el).overflowX)}));
      const errors = [...card.querySelectorAll('.katex [style*="cc0000"], .katex-error')].map(el => el.textContent);
      result.cards.push({card:{left:Math.round(box.left),right:Math.round(box.right)},week:{left:Math.round(week.left),right:Math.round(week.right)},clipped,wide,errors,
        // The long synthetic Chinese paragraph must wrap onto several lines.
        longParagraphLines:Math.round(([...card.querySelectorAll('.description p')].find(p => p.textContent.startsWith('Target task'))?.getBoundingClientRect().height || 0) / parseFloat(getComputedStyle(card.querySelector('.description')).lineHeight)),
        mathCount:card.querySelectorAll('.description .katex').length,displayCount:card.querySelectorAll('.description .katex-display').length,
        rawDelimiters:/\[[]()]/.test(card.querySelector('.description').textContent.replace(/s+/g,''))});
    }
    report(result);
  });
}})();`;
copy.querySelector('body').append(measure);
await writeFile(join(dir,'page.html'),'<!doctype html>\n' + copy.outerHTML);
await cp(join(katexDir,'katex.min.css'),join(dir,'katex.min.css'));
await cp(join(katexDir,'fonts'),join(dir,'fonts'),{recursive:true});
await writeFile(join(dir,'phone.html'),`<!doctype html><html><body style="margin:0"><iframe src="page.html" style="width:390px;height:3000px;border:0"></iframe>
<pre id="layout-result"></pre><script>addEventListener('message',e=>{document.getElementById('layout-result').textContent=e.data;});</script></body></html>`);
const runChrome = (page,width) => new Promise((done,fail) => execFile(chrome,['--headless=new','--disable-gpu','--no-first-run','--hide-scrollbars','--allow-file-access-from-files',
  `--window-size=${width},3000`,'--virtual-time-budget=8000','--dump-dom',pathToFileURL(join(dir,page)).href],{maxBuffer:64 * 1024 * 1024},(error,stdout) => {
  if (error) return fail(error);
  const match = stdout.match(/<pre id="layout-result">([^<]*)<\/pre>/);
  if (!match || !match[1]) return fail(new Error(`no layout result from ${page}`));
  done(JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>')));
}));
try {
  for (const [label,page,width] of [['desktop','page.html',1280],['phone','phone.html',600]]) {
    const result = await runChrome(page,width);
    if (label === 'phone') check(result.viewport,390,'phone layout measured at 390 CSS px');
    check(result.pageOverflow,0,`${label}: no horizontal page overflow`);
    for (const card of result.cards) {
      check(card.card.right <= card.week.right && card.card.left >= card.week.left,true,`${label}: idea card stays inside its week (${JSON.stringify(card)})`);
      check(card.clipped,[],`${label}: no text, list, heading, math or code clipped at the card edge`);
      check(card.wide.every(item => item.scrolls),true,`${label}: wide equations, tables and code scroll horizontally`);
      check(card.errors,[],`${label}: no unsupported-command or KaTeX error output`);
      check(card.longParagraphLines >= 4,true,`${label}: long Chinese paragraph wraps (${card.longParagraphLines} lines)`);
      check([card.displayCount,card.rawDelimiters],[2,false],`${label}: \[ \] and $$ display math render; no raw delimiters left`);
    }
    check(result.cards.length,1,`${label}: the expanded idea was measured`);
  }
  console.log(`PASS: ${checks} real-browser layout checks (desktop 1280px, phone 390px) with synthetic Chinese/LaTeX Markdown, using ${chrome}.`);
} finally { w.close(); await rm(dir,{recursive:true,force:true}); }
