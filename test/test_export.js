/**
 * 语雀导出功能测试脚本
 *
 * 测试三种导出场景:
 *   场景3: 单文档下载 (已支持)
 *   场景2: 整个知识库下载 (新增)
 *   场景1: 全部知识库下载 (新增)
 *
 * 用法:
 *   set YUQUE_TOKEN=xxx
 *   node test/test_export.js
 *
 * token 通过环境变量传入，不写入代码中。
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

// ========== 配置 ==========

const TOKEN = process.env.YUQUE_TOKEN;
const OUTPUT = path.resolve(__dirname, 'test_output');

const TEST_KB_URL  = 'https://www.yuque.com/u67872272/wgrk7u';
const TEST_DOC_URL = 'https://www.yuque.com/u67872272/wgrk7u/ry8o3fc5gttwtgc4';

// ========== 工具函数 ==========

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeName(name) {
  return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getHeaders() {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    cookie: `_yuque_session=${TOKEN};`,
  };
}

// ========== URL 解析 ==========

function parseKbUrl(url) {
  const match = url.match(/yuque\.com\/([^/]+)\/([^/?#]+)$/);
  if (!match) return null;
  return { namespace: match[1], kbSlug: match[2] };
}

function parseDocUrl(url) {
  const match = url.match(/yuque\.com\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return { namespace: match[1], kbSlug: match[2], docSlug: match[3] };
}

// ========== 知识库 TOC 获取 (复用现有逻辑) ==========

async function fetchKbInfo(kbUrl) {
  const resp = await axios.get(kbUrl, { headers: getHeaders() });
  const html = resp.data;

  const prefix = 'decodeURIComponent("';
  const startIdx = html.indexOf(prefix);
  if (startIdx === -1) throw new Error('页面中未找到 TOC 数据');

  const dataStart = startIdx + prefix.length;
  const closeIdx = html.indexOf('"', dataStart);
  if (closeIdx === -1) throw new Error('无法解析 TOC 数据边界');

  const encoded = html.slice(dataStart, closeIdx);
  const decoded = decodeURIComponent(encoded);
  const json = JSON.parse(decoded);

  return {
    bookId:  json.book.id,
    bookName: json.book.name || '',
    host:    (json.space && json.space.host) || 'https://www.yuque.com',
    toc:     json.book.toc || [],
  };
}

// ========== 获取用户所有知识库列表 ==========

async function fetchAllKbs() {
  log('正在获取知识库列表...');

  // 方式1: 尝试内部 API /api/mine/book_stacks
  try {
    const resp = await axios.get('https://www.yuque.com/api/mine/book_stacks', {
      headers: getHeaders(),
      timeout: 10000,
    });
    if (resp.data && resp.data.data) {
      const books = [];
      const stacks = Array.isArray(resp.data.data) ? resp.data.data : [];
      for (const stack of stacks) {
        const stackBooks = stack.books || [];
        for (const book of stackBooks) {
            books.push({
              id:   book.id,
              name: book.name,
              slug: book.slug || book.namespace,
              namespace: book.namespace || (book.user && book.user.login) || '',
            });
        }
      }
      log(`  通过 book_stacks API 获取到 ${books.length} 个知识库`);
      return books;
    }
  } catch (e) {
    log(`  book_stacks API 失败: ${e.message}`);
  }

  // 方式2: 尝试内部 API /api/mine/personal_books
  try {
    const resp = await axios.get('https://www.yuque.com/api/mine/personal_books', {
      headers: getHeaders(),
      timeout: 10000,
    });
    if (resp.data && resp.data.data) {
      const books = [];
      const list = Array.isArray(resp.data.data) ? resp.data.data : [];
      for (const book of list) {
        books.push({
          id:   book.id,
          name: book.name,
          slug: book.slug || book.namespace,
          namespace: book.namespace || (book.user && book.user.login) || '',
        });
      }
      log(`  通过 personal_books API 获取到 ${books.length} 个知识库`);
      return books;
    }
  } catch (e) {
    log(`  personal_books API 失败: ${e.message}`);
  }

  // 方式3: 尝试v2 API
  try {
    // 先获取当前用户信息
    const userResp = await axios.get('https://www.yuque.com/api/v2/user', {
      headers: { ...getHeaders(), 'X-Auth-Token': TOKEN },
      timeout: 10000,
    });
    if (userResp.data && userResp.data.data) {
      const login = userResp.data.data.login;
      const reposResp = await axios.get(`https://www.yuque.com/api/v2/users/${login}/repos`, {
        headers: { ...getHeaders(), 'X-Auth-Token': TOKEN },
        timeout: 10000,
      });
      if (reposResp.data && reposResp.data.data) {
        const books = reposResp.data.data.map(r => ({
          id:   r.id,
          name: r.name,
          slug: r.slug,
          namespace: login,
        }));
        log(`  通过 v2 API 获取到 ${books.length} 个知识库`);
        return books;
      }
    }
  } catch (e) {
    log(`  v2 API 失败: ${e.message}`);
  }

  // 方式4: 抓取 dashboard 页面
  try {
    const resp = await axios.get('https://www.yuque.com/dashboard', {
      headers: getHeaders(),
      timeout: 10000,
    });
    const html = resp.data;

    // 尝试在 HTML 中找 window.__INITIAL_STATE__ 或嵌入的 JSON
    const patterns = [
      /window\.__INITIAL_STATE__\s*=\s*({.*?});/s,
      /"bookStacks"\s*:\s*(\[.*?\])\s*[,}]/s,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          // 尝试从不同结构中提取知识库列表
          let books = [];
          if (Array.isArray(data)) {
            for (const stack of data) {
              const stackBooks = stack.books || [];
              for (const book of stackBooks) {
                books.push({
                  id: book.id,
                  name: book.name,
                  slug: book.slug || '',
                  namespace: (book.user && book.user.login) || '',
                });
              }
            }
          }
          if (books.length > 0) {
            log(`  通过 dashboard 页面找到 ${books.length} 个知识库`);
            return books;
          }
        } catch (parseErr) {
          // 继续尝试下一个模式
        }
      }
    }
  } catch (e) {
    log(`  dashboard 页面抓取失败: ${e.message}`);
  }

  throw new Error('无法获取知识库列表，所有方式均失败');
}

// ========== 文档下载 ==========

async function downloadDoc(docNode, bookId, host, outputDir, pathPrefix = []) {
  const articleUrl = docNode.url;
  if (!articleUrl) {
    log(`  ⚠ 跳过 "${docNode.title}"（无 url 字段）`);
    return { ok: false, reason: 'no_url' };
  }

  const apiUrl = `${host}/api/docs/${articleUrl}?book_id=${String(bookId)}&mode=markdown&merge_dynamic_data=false`;

  const dirParts = [...pathPrefix, docNode.title].map(safeName);
  const dirPath  = path.join(outputDir, ...dirParts.slice(0, -1));
  const filePath = path.join(outputDir, ...dirParts) + '.md';

  if (fs.existsSync(filePath)) {
    log(`  ✓ 跳过（已存在） "${docNode.title}"`);
    return { ok: true, cached: true, path: filePath };
  }

  try {
    const resp = await axios.get(apiUrl, { headers: getHeaders() });
    const docData = resp.data;

    let body = '';
    if (docData && docData.data && docData.data.sourcecode) {
      body = docData.data.sourcecode;
    } else if (docData && docData.data && docData.data.body) {
      body = docData.data.body;
    }

    // lake 格式文档: sourcecode 为空时，尝试不用 mode=markdown 获取 content
    if (!body) {
      try {
        const altUrl = `${host}/api/docs/${articleUrl}?book_id=${String(bookId)}`;
        const altResp = await axios.get(altUrl, { headers: getHeaders() });
        const altData = altResp.data;
        if (altData && altData.data && altData.data.content) {
          body = altData.data.content;
        }
      } catch (altErr) {
        // 忽略备用请求的错误
      }
    }

    if (!body) {
      log(`  ✗ "${docNode.title}" 内容为空 (可能是空白文档)`);
      return { ok: false, reason: 'empty_content' };
    }

    const content = `# ${docNode.title}\n\n${body}`;
    ensureDir(dirPath);
    fs.writeFileSync(filePath, content, 'utf-8');
    log(`  ✓ 已保存 "${docNode.title}" (${body.length} 字符)`);
    return { ok: true, path: filePath, size: body.length };
  } catch (e) {
    log(`  ✗ "${docNode.title}" 下载失败: ${(e.message || '').slice(0, 100)}`);
    return { ok: false, reason: e.message };
  }
}

// ========== 子树收集 ==========

function collectSubtree(toc, parentUuid) {
  const result = [];
  const children = toc.filter(item => item.parent_uuid === parentUuid);
  for (const child of children) {
    if (child.type === 'DOC') {
      result.push(child);
    }
    result.push(...collectSubtree(toc, child.uuid));
  }
  return result;
}

function getPathToDoc(toc, docUuid) {
  const lookup = new Map();
  for (const item of toc) {
    lookup.set(item.uuid, item);
  }

  const parts = [];
  let cur = lookup.get(docUuid);
  const visited = new Set();
  while (cur && !visited.has(cur.uuid)) {
    visited.add(cur.uuid);
    parts.unshift(cur.title);
    if (!cur.parent_uuid) break;
    cur = lookup.get(cur.parent_uuid);
  }
  return parts.length > 1 ? parts.slice(1, -1) : [];
}

function getAllDocNodes(toc) {
  return toc.filter(item => item.type === 'DOC');
}

// ========== 三个测试场景 ==========

async function scenario3_singleDoc() {
  console.log('\n' + '='.repeat(60));
  console.log('  场景3: 单文档下载测试');
  console.log('='.repeat(60));

  const parsed = parseDocUrl(TEST_DOC_URL);
  if (!parsed) {
    log('❌ URL 解析失败');
    return { success: false, reason: 'url_parse_failed' };
  }
  log(`  解析: namespace=${parsed.namespace}  kb=${parsed.kbSlug}  doc=${parsed.docSlug}`);

  const kbUrl = `https://www.yuque.com/${parsed.namespace}/${parsed.kbSlug}`;
  const kbInfo = await fetchKbInfo(kbUrl);
  log(`  知识库: ${kbInfo.bookName} (ID: ${kbInfo.bookId}), 共 ${kbInfo.toc.length} 个节点`);

  const targetDoc = kbInfo.toc.find(
    item => item.type === 'DOC' && item.url === parsed.docSlug
  );
  if (!targetDoc) {
    log('❌ 未找到目标文档');
    return { success: false, reason: 'doc_not_found' };
  }

  const filePath = getPathToDoc(kbInfo.toc, targetDoc.uuid);
  log(`  文档路径: ${[...filePath, targetDoc.title].join(' > ')}`);

  const outDir = path.join(OUTPUT, 'scenario3_single');
  const result = await downloadDoc(targetDoc, kbInfo.bookId, kbInfo.host, outDir, filePath);

  log(`  结果: ${result.ok ? '✓ 成功' : '✗ 失败'}`);
  return { success: result.ok, docs: 1, result };
}

async function scenario2_entireKb() {
  console.log('\n' + '='.repeat(60));
  console.log('  场景2: 整个知识库下载测试');
  console.log('='.repeat(60));

  const parsed = parseKbUrl(TEST_KB_URL);
  if (!parsed) {
    log('❌ URL 解析失败');
    return { success: false, reason: 'url_parse_failed' };
  }
  log(`  解析: namespace=${parsed.namespace}  kb=${parsed.kbSlug}`);

  const kbInfo = await fetchKbInfo(TEST_KB_URL);
  log(`  知识库: ${kbInfo.bookName} (ID: ${kbInfo.bookId}), 共 ${kbInfo.toc.length} 个节点`);

  const allDocs = getAllDocNodes(kbInfo.toc);
  log(`  文档节点数: ${allDocs.length}`);

  if (allDocs.length === 0) {
    log('⚠ 知识库中无文档');
    return { success: true, docs: 0 };
  }

  log(`  文档列表:`);
  for (const doc of allDocs) {
    const p = getPathToDoc(kbInfo.toc, doc.uuid);
    log(`    - ${[...p, doc.title].join(' > ')}`);
  }

  const outDir = path.join(OUTPUT, 'scenario2_kb');
  let successCount = 0, failCount = 0;

  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i];
    log(`  [${i + 1}/${allDocs.length}] ${doc.title}`);

    const docPath = getPathToDoc(kbInfo.toc, doc.uuid);
    const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, outDir, docPath);

    if (result.ok) successCount++;
    else failCount++;

    if (i < allDocs.length - 1) await sleep(300);
  }

  log(`  完成! 成功: ${successCount}  失败: ${failCount}`);
  return { success: failCount === 0, docs: allDocs.length, successCount, failCount };
}

async function scenario1_allKbs() {
  console.log('\n' + '='.repeat(60));
  console.log('  场景1: 全部知识库下载测试');
  console.log('='.repeat(60));

  let kbs;
  try {
    kbs = await fetchAllKbs();
  } catch (e) {
    log(`❌ 获取知识库列表失败: ${e.message}`);
    return { success: false, reason: 'fetch_kbs_failed', detail: e.message };
  }

  if (kbs.length === 0) {
    log('⚠ 账号下没有知识库');
    return { success: true, docs: 0, kbs: 0 };
  }

  log(`找到 ${kbs.length} 个知识库:`);
  for (const kb of kbs) {
    log(`  - [${kb.id}] ${kb.name}  (${kb.namespace}/${kb.slug})`);
  }

  let totalDocs = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  for (let ki = 0; ki < kbs.length; ki++) {
    const kb = kbs[ki];
    log(`\n--- 知识库 [${ki + 1}/${kbs.length}]: ${kb.name} ---`);

    const kbUrl = `https://www.yuque.com/${kb.namespace}/${kb.slug}`;
    let kbInfo;
    try {
      kbInfo = await fetchKbInfo(kbUrl);
    } catch (e) {
      log(`  ❌ 获取知识库信息失败: ${e.message}`);
      continue;
    }

    const allDocs = getAllDocNodes(kbInfo.toc);
    log(`  文档数: ${allDocs.length}`);
    totalDocs += allDocs.length;

    const outDir = path.join(OUTPUT, 'scenario1_all', safeName(kb.name));

    for (let di = 0; di < allDocs.length; di++) {
      const doc = allDocs[di];
      log(`  [${di + 1}/${allDocs.length}] ${doc.title}`);

      const docPath = getPathToDoc(kbInfo.toc, doc.uuid);
      const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, outDir, docPath);

      if (result.ok) totalSuccess++;
      else totalFail++;

      if (di < allDocs.length - 1) await sleep(300);
    }

    if (ki < kbs.length - 1) await sleep(500);
  }

  log(`\n全部知识库下载完成! 文档: ${totalDocs}  成功: ${totalSuccess}  失败: ${totalFail}`);
  return { success: totalFail === 0, kbs: kbs.length, docs: totalDocs, successCount: totalSuccess, failCount: totalFail };
}

// ========== 主流程 ==========

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     语雀导出功能测试 (三种场景)                   ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (!TOKEN) {
    console.error('\n❌ 请设置环境变量 YUQUE_TOKEN');
    console.error('   PowerShell: $env:YUQUE_TOKEN="your_token"');
    console.error('   CMD:       set YUQUE_TOKEN=your_token');
    console.error('\n然后运行: node test/test_export.js');
    process.exit(1);
  }

  log(`输出根目录: ${OUTPUT}`);

  // 清理旧测试数据
  if (fs.existsSync(OUTPUT)) {
    fs.rmSync(OUTPUT, { recursive: true });
    log('已清理旧的测试输出目录');
  }

  const results = {};

  // 按照从简单到复杂的顺序测试
  results.scenario3 = await scenario3_singleDoc();
  results.scenario2 = await scenario2_entireKb();
  results.scenario1 = await scenario1_allKbs();

  // 汇总
  console.log('\n' + '═'.repeat(60));
  console.log('  测试汇总');
  console.log('═'.repeat(60));
  console.log(`  场景3 (单文档):     ${results.scenario3.success ? '✓ 通过' : '✗ 失败'}`);
  console.log(`  场景2 (单知识库):   ${results.scenario2.success ? '✓ 通过' : '✗ 失败'}  (${results.scenario2.docs || 0} 篇文档)`);
  console.log(`  场景1 (全部知识库): ${results.scenario1.success ? '✓ 通过' : '✗ 失败'}  (${results.scenario1.docs || 0} 篇文档, ${results.scenario1.kbs || 0} 个知识库)`);

  console.log(`\n所有文件保存在: ${OUTPUT}`);
}

main().catch(e => {
  console.error(`\n❌ 测试运行出错: ${e.message || e}`);
  process.exit(1);
});
