const path = require('path');
const fs = require('fs');
const axios = require('axios');

// ========== 工具函数 ==========

let logCallback = null;

function setLogCallback(cb) {
  logCallback = cb;
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const formatted = `[${ts}] ${msg}`;
  console.log(formatted);
  if (logCallback) {
    logCallback(formatted);
  }
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

// ========== URL 解析 ==========

function parseDocUrl(url) {
  // https://www.yuque.com/{namespace}/{kb_slug}/{doc_slug}
  const match = url.match(/yuque\.com\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return {
    namespace: match[1],
    kbSlug: match[2],
    docSlug: match[3],
  };
}

function parseKbUrl(url) {
  // https://www.yuque.com/{namespace}/{kb_slug}
  const match = url.match(/yuque\.com\/([^/]+)\/([^/?#]+)$/);
  if (!match) return null;
  return { namespace: match[1], kbSlug: match[2] };
}

// ========== 请求头 ==========

function buildHeaders(token) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    cookie: `_yuque_session=${token};`,
  };
}

// ========== 知识库 TOC 获取 ==========

async function fetchKbInfo(kbUrl, token) {
  const resp = await axios.get(kbUrl, { headers: buildHeaders(token) });
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
    bookId: json.book.id,
    bookName: json.book.name || '',
    host: (json.space && json.space.host) || 'https://www.yuque.com',
    toc: json.book.toc || [],
  };
}

// ========== 获取用户所有知识库列表 ==========

async function fetchAllKbs(token) {
  const headers = buildHeaders(token);

  // 方式1: /api/mine/book_stacks
  try {
    const resp = await axios.get('https://www.yuque.com/api/mine/book_stacks', {
      headers,
      timeout: 10000,
    });
    if (resp.data && resp.data.data) {
      const books = [];
      const stacks = Array.isArray(resp.data.data) ? resp.data.data : [];
      for (const stack of stacks) {
        for (const book of (stack.books || [])) {
          books.push({
            id: book.id,
            name: book.name,
            slug: book.slug || book.namespace,
            namespace: book.namespace || (book.user && book.user.login) || '',
          });
        }
      }
      if (books.length > 0) {
        log(`  通过 book_stacks API 获取到 ${books.length} 个知识库`);
        return books;
      }
    }
  } catch (e) {
    log(`  book_stacks API 不可用: ${e.message}`);
  }

  // 方式2: /api/mine/personal_books
  try {
    const resp = await axios.get('https://www.yuque.com/api/mine/personal_books', {
      headers,
      timeout: 10000,
    });
    if (resp.data && resp.data.data) {
      const books = [];
      const list = Array.isArray(resp.data.data) ? resp.data.data : [];
      for (const book of list) {
        books.push({
          id: book.id,
          name: book.name,
          slug: book.slug || book.namespace,
          namespace: book.namespace || (book.user && book.user.login) || '',
        });
      }
      if (books.length > 0) {
        log(`  通过 personal_books API 获取到 ${books.length} 个知识库`);
        return books;
      }
    }
  } catch (e) {
    log(`  personal_books API 不可用: ${e.message}`);
  }

  throw new Error('无法获取知识库列表，所有方式均失败');
}

// ========== 图片下载 ==========

const IMG_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

// 匹配 cdn.nlark.com/yuque 的图片链接
const YUQUE_IMG_PATTERN = new RegExp(
  `https://cdn\\.nlark\\.com/yuque/[^\\s)"'<>]+?\\.(${IMG_EXTENSIONS.join('|')})(?:\\?[^\\s)"'<>]*)?`,
  'gi'
);

async function downloadImagesForMd(body, mdDirPath, token) {
  const imagesDir = path.join(mdDirPath, 'images');
  const matches = Array.from(body.matchAll(YUQUE_IMG_PATTERN));

  if (matches.length === 0) return body;

  ensureDir(imagesDir);
  let newBody = body;
  const seen = new Set();
  let downloadedCount = 0;

  for (const match of matches) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      // 从 URL 提取唯一文件名
      const pathname = new URL(url).pathname;
      const urlParts = pathname.split('/');
      const rawFilename = urlParts[urlParts.length - 1];
      const localFilename = rawFilename.includes('.') ? rawFilename : rawFilename + '.png';

      const localPath = path.join(imagesDir, localFilename);

      if (!fs.existsSync(localPath)) {
        const resp = await axios.get(url, {
          headers: buildHeaders(token),
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        fs.writeFileSync(localPath, Buffer.from(resp.data));
        downloadedCount++;
      }

      // 替换为相对路径
      newBody = newBody.replaceAll(url, `./images/${localFilename}`);
    } catch (e) {
      log(`    ⚠ 图片下载失败 (保留原始链接): ${url} - ${(e.message || '').slice(0, 50)}`);
    }
  }

  if (downloadedCount > 0) {
    log(`    🖼 下载了 ${downloadedCount} 张图片到 ${path.relative(process.cwd(), imagesDir)}`);
  }
  return newBody;
}

// ========== 文档下载 ==========

async function downloadDoc(docNode, bookId, host, token, outputDir, pathPrefix = [], downloadImages = false) {
  const headers = buildHeaders(token);
  const articleUrl = docNode.url;

  if (!articleUrl) {
    log(`  ⚠ 跳过 "${docNode.title}"（无 url 字段）`);
    return { ok: false, reason: 'no_url' };
  }

  const apiUrl = `${host}/api/docs/${articleUrl}?book_id=${String(bookId)}&mode=markdown&merge_dynamic_data=false`;

  // 构建输出路径
  const dirParts = [...pathPrefix, docNode.title].map(safeName);
  const dirPath = path.join(outputDir, ...dirParts.slice(0, -1));
  const filePath = path.join(outputDir, ...dirParts) + '.md';

  // 跳过已下载的文件
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    log(`  ✓ 跳过（已存在） "${docNode.title}"`);
    return { ok: true, cached: true, path: filePath, size: existing.length };
  }

  try {
    const resp = await axios.get(apiUrl, { headers });
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
        const altResp = await axios.get(altUrl, { headers });
        const altData = altResp.data;
        if (altData && altData.data && altData.data.content) {
          body = altData.data.content;
        }
      } catch (altErr) {
        // 忽略备用请求的错误
      }
    }

    if (!body) {
      body = '';
    }

    // 下载图片到本地
    if (downloadImages) {
      ensureDir(dirPath);
      body = await downloadImagesForMd(body, dirPath, token);
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
  return parts.length > 1 ? parts.slice(0, -1) : [];
}

function getAllDocNodes(toc) {
  return toc.filter(item => item.type === 'DOC');
}

// ========== 整个知识库下载 ==========

async function downloadEntireKb(kbUrl, token, outputDir, downloadImages = false) {
  const parsed = parseKbUrl(kbUrl);
  if (!parsed) {
    log('❌ 知识库 URL 格式不正确');
    return { ok: false, reason: 'invalid_url' };
  }

  log(`  知识库 URL: ${kbUrl}`);
  log(`  解析: namespace=${parsed.namespace}  kbSlug=${parsed.kbSlug}`);

  let kbInfo;
  try {
    kbInfo = await fetchKbInfo(kbUrl, token);
  } catch (e) {
    log(`  ❌ 获取知识库信息失败: ${e.message}`);
    return { ok: false, reason: 'fetch_kb_failed', detail: e.message };
  }

  log(`  知识库: ${kbInfo.bookName} (ID: ${kbInfo.bookId}), 共 ${kbInfo.toc.length} 个 TOC 节点`);

  const allDocs = getAllDocNodes(kbInfo.toc);
  log(`  文档节点: ${allDocs.length}`);
  log('');

  if (allDocs.length === 0) {
    log('  ⚠ 知识库中无文档');
    return { ok: true, downloaded: 0, total: 0 };
  }

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i];
    log(`  [${i + 1}/${allDocs.length}] ${doc.title}`);

    const docPath = getPathToDoc(kbInfo.toc, doc.uuid);
    const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPath, downloadImages);

    if (result.ok && result.cached) skipCount++;
    else if (result.ok) successCount++;
    else failCount++;

    if (i < allDocs.length - 1) {
      await sleep(300);
    }
  }

  const total = allDocs.length;
  log(`\n  知识库 "${kbInfo.bookName}" 完成! 成功: ${successCount}  跳过: ${skipCount}  失败: ${failCount}`);
  return { ok: true, total, successCount, skipCount, failCount };
}

// ========== 全部知识库下载 ==========

async function downloadAllKbs(token, outputDir, downloadImages = false) {
  log('正在获取全部知识库列表...');

  let kbs;
  try {
    kbs = await fetchAllKbs(token);
  } catch (e) {
    log(`❌ 获取知识库列表失败: ${e.message}`);
    return { ok: false, reason: 'fetch_kbs_failed', detail: e.message };
  }

  if (kbs.length === 0) {
    log('⚠ 账号下没有知识库');
    return { ok: true, totalKbs: 0 };
  }

  log(`\n找到 ${kbs.length} 个知识库:`);
  for (const kb of kbs) {
    log(`  - [${kb.id}] ${kb.name}  (${kb.namespace}/${kb.slug})`);
  }
  log('');

  let grandTotal = 0;
  let grandSuccess = 0;
  let grandFail = 0;
  let grandSkip = 0;

  for (let ki = 0; ki < kbs.length; ki++) {
    const kb = kbs[ki];
    log(`[知识库 ${ki + 1}/${kbs.length}]: ${kb.name}`);
    log(`${'─'.repeat(50)}`);

    const kbUrl = `https://www.yuque.com/${kb.namespace}/${kb.slug}`;
    const kbOutDir = path.join(outputDir, safeName(kb.name));

    try {
      const kbResult = await downloadEntireKb(kbUrl, token, kbOutDir, downloadImages);
      if (kbResult.ok) {
        grandTotal += (kbResult.total || 0);
        grandSuccess += (kbResult.successCount || 0);
        grandSkip += (kbResult.skipCount || 0);
        grandFail += (kbResult.failCount || 0);
      }
    } catch (e) {
      log(`  ❌ 知识库 "${kb.name}" 下载出错: ${e.message}`);
    }

    if (ki < kbs.length - 1) {
      await sleep(500);
      log('');
    }
  }

  log(`\n全部下载完成! 知识库: ${kbs.length}  文档: ${grandTotal}  成功: ${grandSuccess}  跳过: ${grandSkip}  失败: ${grandFail}`);
  return { ok: true, totalKbs: kbs.length, grandTotal, grandSuccess, grandSkip, grandFail };
}

// ========== 单篇文档下载（现有逻辑，保留兼容） ==========

async function downloadSingleDoc(url, token, outputDir, withSub, downloadImages = false) {
  const parsed = parseDocUrl(url);
  if (!parsed) {
    log('❌ 文档 URL 格式不正确');
    return;
  }

  const kbUrl = `https://www.yuque.com/${parsed.namespace}/${parsed.kbSlug}`;
  log(`[1/3] 获取知识库 "${parsed.kbSlug}" 的 TOC...`);

  let kbInfo;
  try {
    kbInfo = await fetchKbInfo(kbUrl, token);
  } catch (e) {
    log(`❌ 获取知识库信息失败: ${e.message}`);
    log('   请检查 token 是否有效');
    return;
  }

  log(`  知识库: ${kbInfo.bookName} (ID: ${kbInfo.bookId})`);
  log(`  文档总数: ${kbInfo.toc.length}`);

  // 查找目标文档
  log(`\n[2/3] 查找目标文档...`);
  const targetDoc = kbInfo.toc.find(
    item => item.type === 'DOC' && item.url === parsed.docSlug
  );

  if (!targetDoc) {
    log(`❌ 未在知识库中找到文档 "${parsed.docSlug}"`);
    return;
  }

  const pathToDoc = getPathToDoc(kbInfo.toc, targetDoc.uuid);
  log(`  找到: ${[...pathToDoc, targetDoc.title].join(' > ')}`);

  // 收集要下载的文档列表
  const docsToDownload = [targetDoc];
  if (withSub) {
    const subDocs = collectSubtree(kbInfo.toc, targetDoc.uuid);
    docsToDownload.push(...subDocs);
    log(`  含子文档共 ${docsToDownload.length} 篇`);
  } else {
    log(`  单篇下载模式`);
  }

  // 下载
  log(`\n[3/3] 开始下载...`);
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < docsToDownload.length; i++) {
    const doc = docsToDownload[i];
    const idx = `[${i + 1}/${docsToDownload.length}]`;
    log(`  ${idx} ${doc.title}`);

    let docPathPrefix;
    if (withSub && i > 0) {
      docPathPrefix = getPathToDoc(kbInfo.toc, doc.uuid);
    } else {
      docPathPrefix = pathToDoc;
    }

    const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPathPrefix, downloadImages);

    if (result.ok && result.cached) skipCount++;
    else if (result.ok) successCount++;
    else failCount++;

    if (i < docsToDownload.length - 1) {
      await sleep(300);
    }
  }

  log(`\n  完成! 成功: ${successCount}  跳过: ${skipCount}  失败: ${failCount}`);
}

// ========== 帮助 ==========

function showHelp() {
  console.log(`
语雀文档下载工具

用法:
  node yuque_download.js --all -t <token>           下载全部知识库
  node yuque_download.js <知识库URL> -t <token>      下载整个知识库
  node yuque_download.js <文档URL> -t <token> [--sub] 下载单篇文档

选项:
  -t, --token <token>      语雀 cookie token（必填，也可通过环境变量 YUQUE_TOKEN 传入）
  -s, --sub                单文档模式: 同时下载所有子文档
  -o, --output <dir>       输出目录（默认: ./yuque_output）
  -i, --download-images    下载文档中的图片到本地（默认保持远程链接）
  --all                    下载所有知识库
  -h, --help               显示帮助

示例:
  # 下载全部知识库
  node yuque_download.js --all -t "xxx"

  # 下载全部知识库并下载图片
  node yuque_download.js --all -t "xxx" -i

  # 下载整个知识库
  node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "xxx"

  # 下载单篇文档
  node yuque_download.js "https://www.yuque.com/xxx/kb/doc-slug" -t "xxx"

  # 下载文档及其所有子文档，并将图片保存到本地
  node yuque_download.js "https://www.yuque.com/xxx/kb/doc-slug" -t "xxx" --sub -i

  # 指定输出目录
  node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "xxx" -o "./my_docs"

获取 token: 打开语雀 → F12 → Application → Cookies → _yuque_session 的值
`);
}

// ========== 主流程 ==========

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  // 解析参数
  let url = '';
  let token = process.env.YUQUE_TOKEN || '';
  let withSub = false;
  let downloadAll = false;
  let downloadImages = false;
  let outputDir = path.resolve(__dirname, 'yuque_output');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-t' || arg === '--token') {
      token = args[++i] || '';
    } else if (arg === '-s' || arg === '--sub') {
      withSub = true;
    } else if (arg === '-o' || arg === '--output') {
      outputDir = path.resolve(args[++i] || outputDir);
    } else if (arg === '--all') {
      downloadAll = true;
    } else if (arg === '-i' || arg === '--download-images') {
      downloadImages = true;
    } else if (!arg.startsWith('-') && !url) {
      url = arg;
    }
  }

  // 校验
  if (!downloadAll && !url) {
    console.error('❌ 请提供 URL 或使用 --all 参数');
    console.error('用法: node yuque_download.js <URL> -t <token>  或  node yuque_download.js --all -t <token>');
    process.exit(1);
  }
  if (!token) {
    console.error('❌ 请提供 token（-t 参数 或 环境变量 YUQUE_TOKEN）');
    console.error('从语雀 Cookie 中的 _yuque_session 值获取');
    process.exit(1);
  }

  log('═══════════════════════════════════════');
  log('  语雀文档下载工具 v3.0');
  log('═══════════════════════════════════════');
    log(`  输出目录: ${outputDir}`);
    log(`  下载图片: ${downloadImages ? '是' : '否（默认保持远程链接）'}`);
    log('');

  // 模式1: 全部知识库
  if (downloadAll) {
    log('模式: 全部知识库下载');
    log('');
    await downloadAllKbs(token, outputDir, downloadImages);
    log(`\n文件保存在: ${outputDir}`);
    return;
  }

  // 判断 URL 类型: 3段=文档, 2段=知识库
  const isDocUrl = parseDocUrl(url);
  const isKbUrl = !isDocUrl && parseKbUrl(url);

  if (isDocUrl) {
    // 模式3: 单文档下载
    log(`模式: 单文档下载${withSub ? '（含子文档）' : ''}`);
    log(`  URL: ${url}`);
    log('');
    await downloadSingleDoc(url, token, outputDir, withSub, downloadImages);
  } else if (isKbUrl) {
    // 模式2: 整个知识库下载
    log('模式: 整个知识库下载');
    log('');
    await downloadEntireKb(url, token, outputDir, downloadImages);
  } else {
    console.error('❌ URL 格式不正确');
    console.error('支持格式:');
    console.error('  知识库: https://www.yuque.com/{namespace}/{kbSlug}');
    console.error('  文档:   https://www.yuque.com/{namespace}/{kbSlug}/{docSlug}');
    process.exit(1);
  }

  log(`\n文件保存在: ${outputDir}`);
}

// CLI 入口（仅在直接运行时执行）
if (require.main === module) {
  main().catch(e => {
    console.error(`\n❌ 运行出错: ${e.message || e}`);
    process.exit(1);
  });
}

// ========== 模块导出 ==========

module.exports = {
  setLogCallback,
  downloadAllKbs,
  downloadEntireKb,
  downloadSingleDoc,
  parseKbUrl,
  parseDocUrl,
};
