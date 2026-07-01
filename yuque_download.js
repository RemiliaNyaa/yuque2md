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
            items_count: book.items_count || 0,
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

// ========== 同名去重 ==========

/**
 * 构建去重名称映射
 * 同目录下同名节点统一使用 uuid 后缀
 */
function buildDedupMap(toc) {
  const nameMap = new Map(); // uuid → deduped safeName

  const byParent = {};
  for (const node of toc) {
    const pid = node.parent_uuid || '__root__';
    if (!byParent[pid]) byParent[pid] = [];
    byParent[pid].push(node);
  }

  for (const [, children] of Object.entries(byParent)) {
    const nameCount = {};
    for (const child of children) {
      const key = child.type + '||' + child.title;
      nameCount[key] = (nameCount[key] || 0) + 1;
    }

    for (const child of children) {
      const key = child.type + '||' + child.title;
      let name = safeName(child.title);

      if (nameCount[key] > 1) {
        name = name + '_' + child.uuid.slice(-8);
      }
      nameMap.set(child.uuid, name);
    }
  }

  return nameMap;
}

// ========== 静态资源下载（统一接口） ==========

// 资源类型匹配规则
const RESOURCE_RULES = [
  {
    // 图片: cdn.nlark.com/yuque/...png|jpg等
    name: 'image',
    regex: /https:\/\/cdn\.nlark\.com\/yuque\/[^\s)"'<>]+\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?[^\s)"'<>]*)?/gi,
    getInfo: (match) => {
      const url = match[0];
      const urlObj = new URL(url);
      const parts = urlObj.pathname.split('/');
      return { url, filename: parts[parts.length - 1] };
    },
  },
  {
    // 附件: [filename](https://www.yuque.com/attachments/...)
    name: 'attachment',
    regex: /\[([^\]]*?)\]\((https:\/\/www\.yuque\.com\/attachments\/[^)]+)\)/g,
    getInfo: (match) => ({ url: match[2], filename: match[1] }),
  },
];

// 修复跨行公式：从 HTML 提取 __latex SVG，替换 markdown 中的 $...$
async function fixFormulas(body, htmlBody, resourcesDir, docName, downloadResources) {
  if (!htmlBody) return body;
  const latexRe = /cdn\.nlark\.com\/yuque\/__latex\/([a-f0-9]+\.svg)/g;
  const hashes = [];
  let lm;
  while ((lm = latexRe.exec(htmlBody)) !== null) {
    hashes.push(lm[1]);
  }
  if (hashes.length === 0) return body;

  let fi = 0, fixedCount = 0;
  const newBody = body.replace(/\$[\s\S]+?\$/g, (match) => {
    if (!match.includes('\n')) return match;
    if (fi >= hashes.length) return '（公式）';
    const hash = hashes[fi++];
    if (downloadResources) {
      const url = 'https://cdn.nlark.com/yuque/__latex/' + hash;
      const localPath = path.join(resourcesDir, hash);
      if (!fs.existsSync(localPath)) {
        axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } })
          .then(r => { ensureDir(resourcesDir); fs.writeFileSync(localPath, Buffer.from(r.data)); })
          .catch(() => {});
      }
      fixedCount++;
      return '![公式](./resources/' + docName + '/' + hash + ')';
    } else {
      fixedCount++;
      return '![公式](https://cdn.nlark.com/yuque/__latex/' + hash + ')';
    }
  });

  if (fixedCount > 0) {
    log('    📐 修复了 ' + fixedCount + ' 个公式为' + (downloadResources ? '本地 SVG' : '远程 SVG'));
  }
  return newBody;
}

async function downloadResourcesForMd(body, mdDirPath, docName, token, htmlBody = '') {
  const resourcesDir = path.join(mdDirPath, 'resources', docName);
  let newBody = body;
  const seen = new Set();
  const replacements = [];
  let totalDownloaded = 0;

  // 处理语雀卡片：从 HTML 中提取 audio/video 资源 + 补全文档链接
  const cardReplacements = [];
  if (htmlBody) {
    // 从 HTML 中提取文档基础 URL
    const docBaseUrl = (htmlBody.match(/href="(https:\/\/www\.yuque\.com\/[^"]+)#/) || [])[1] || '';

    // 1. 补全 about:blank 为真实文档链接
    if (docBaseUrl) {
      newBody = newBody.replace(/\[此处为语雀卡片，点击链接查看\]\(about:blank(#\w+)\)/g,
        `[此处为语雀卡片，点击链接查看](${docBaseUrl}$1)`);
    }

    // 2. 提取 data-audio-src / data-video-src，下载资源并直接替换卡片链接
    const mediaRegex = /id="(\w+)"[^>]*data-(audio|video)-src="([^"]+)"/g;
    let m;
    while ((m = mediaRegex.exec(htmlBody)) !== null) {
      const anchor = m[1];
      const mediaType = m[2];
      const srcPath = m[3];
      const url = `https://www.yuque.com/attachments/${srcPath}`;
      const ext = srcPath.split('.').pop();
      const filename = `${anchor}.${ext}`;

      if (!seen.has(url)) {
        seen.add(url);
        const localPath = path.join(resourcesDir, filename);
        let downloaded = fs.existsSync(localPath);
        if (!downloaded) {
          try {
            const resp = await axios.get(url, {
              responseType: 'arraybuffer', timeout: 30000,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            ensureDir(resourcesDir);
            fs.writeFileSync(localPath, Buffer.from(resp.data));
            downloaded = true;
            totalDownloaded++;
          } catch (e) {
            log(`    ⚠ ${mediaType}资源下载失败: ${filename} - ${(e.message||'').slice(0,40)}`);
          }
        }
        if (downloaded) {
          const relativePath = `./resources/${docName}/${filename}`;
          // 直接替换 markdown 中的卡片链接
          const emoji = mediaType === 'audio' ? '🎵' : '🎬';
          newBody = newBody.replace(
            new RegExp(`\\[此处为语雀卡片，点击链接查看\\]\\([^)]+#${anchor}\\)`, 'g'),
            `[${emoji} ${mediaType}: ${filename}](${relativePath})`
          );
          cardReplacements.push({ label: `${mediaType}: ${filename}`, path: relativePath, anchor: '#' + anchor });
        }
      }
    }
  }

  // 未下载的卡片：做提醒标注
  if (cardReplacements.length > 0) {
    // 卡片已经在上面的循环中直接替换了，这里记录日志
    log(`    🎬 下载了 ${cardReplacements.length} 个嵌入音频/视频`);
  }


  for (const rule of RESOURCE_RULES) {
    let match;
    rule.regex.lastIndex = 0;
    while ((match = rule.regex.exec(body)) !== null) {
      const info = rule.getInfo(match);
      if (seen.has(info.url)) continue;
      seen.add(info.url);

      const localPath = path.join(resourcesDir, info.filename);
      const relativePath = `./resources/${docName}/${info.filename}`;

      if (!fs.existsSync(localPath)) {
        try {
          const resp = await axios.get(info.url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          ensureDir(resourcesDir);
          fs.writeFileSync(localPath, Buffer.from(resp.data));
          totalDownloaded++;
        } catch (e) {
          log(`    ⚠ 资源下载失败 (保留原始链接): ${info.filename} - ${(e.message || '').slice(0, 50)}`);
          continue;
        }
      }

      replacements.push({ old: info.url, new: relativePath });
    }
  }

  // 替换链接（按长度降序避免部分匹配）
  replacements.sort((a, b) => b.old.length - a.old.length);
  for (const { old: oldUrl, new: newUrl } of replacements) {
    newBody = newBody.split(oldUrl).join(newUrl);
  }

  if (totalDownloaded > 0) {
    log(`    📦 下载了 ${totalDownloaded} 个资源到 resources/${docName}/`);
  }
  return newBody;
}

// ========== 文档下载 ==========

async function downloadDoc(docNode, bookId, host, token, outputDir, pathPrefix = [], nameMap = null, downloadResources = false, skipExisting = true) {
  const headers = buildHeaders(token);
  const articleUrl = docNode.url;

  if (!articleUrl) {
    log(`  ⚠ 跳过 "${docNode.title}"（无 url 字段）`);
    return { ok: false, reason: 'no_url' };
  }

  const apiUrl = `${host}/api/docs/${articleUrl}?book_id=${String(bookId)}&mode=markdown&merge_dynamic_data=false`;

  // 使用去重后的名称
  const docName = nameMap ? (nameMap.get(docNode.uuid) || safeName(docNode.title)) : safeName(docNode.title);
  const filePath = path.join(outputDir, ...pathPrefix, docName + '.md');
  const dirPath = path.dirname(filePath);

  // 断点续传：跳过已下载的文件
  if (skipExisting && fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    log(`  ✓ 跳过（已存在） "${docName}"`);
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

    if (!body) body = '';

    // 如果正文包含公式（跨行 $...$），获取 HTML 版本用于提取 __latex SVG
    const hasFormulas = /\$[\s\S]*\n[\s\S]*\$/.test(body);
    let htmlBody = '';
    if (hasFormulas || downloadResources) {
      try {
        const htmlApiUrl = `${host}/api/docs/${articleUrl}?book_id=${String(bookId)}&mode=html`;
        const htmlResp = await axios.get(htmlApiUrl, { headers });
        htmlBody = htmlResp.data?.data?.body || htmlResp.data?.data?.sourcecode || '';
        if (htmlBody && downloadResources) log(`    📄 获取 HTML 版本 (${htmlBody.length} 字符) 用于提取隐藏资源`);
      } catch (e) {
        // HTML 获取失败不影响主流程
      }
    }

    // 下载静态资源到本地
    if (downloadResources && body) {
      ensureDir(dirPath);
      body = await downloadResourcesForMd(body, dirPath, docName, token, htmlBody);
    }

    // 修复公式（无论是否下载资源，无资源模式用 CDN 链接）
    if (hasFormulas && htmlBody) {
      body = await fixFormulas(body, htmlBody, path.join(dirPath, 'resources', docName), docName, downloadResources);
    }

    const content = `# ${docNode.title}\n\n${body}`;
    ensureDir(dirPath);
    fs.writeFileSync(filePath, content, 'utf-8');
    log(`  ✓ 已保存 "${docName}" (${body.length} 字符)`);
    return { ok: true, path: filePath, size: body.length };
  } catch (e) {
    log(`  ✗ "${docName}" 下载失败: ${(e.message || '').slice(0, 100)}`);
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

function getPathToDoc(toc, docUuid, nameMap = null) {
  const lookup = new Map();
  for (const item of toc) {
    lookup.set(item.uuid, item);
  }

  const parts = [];
  let cur = lookup.get(docUuid);
  const visited = new Set();
  while (cur && !visited.has(cur.uuid)) {
    visited.add(cur.uuid);
    // 使用去重后的名称
    const name = nameMap ? (nameMap.get(cur.uuid) || safeName(cur.title)) : safeName(cur.title);
    parts.unshift(name);
    if (!cur.parent_uuid) break;
    cur = lookup.get(cur.parent_uuid);
  }
  return parts.length > 1 ? parts.slice(0, -1) : [];
}

function getAllDocNodes(toc) {
  return toc.filter(item => item.type === 'DOC');
}

// ========== 整个知识库下载 ==========

async function downloadEntireKb(kbUrl, token, outputDir, downloadResources = false, skipExisting = true) {
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

  // 构建同名去重映射
  const nameMap = buildDedupMap(kbInfo.toc);

  // 强制模式：清理旧目录；断点模式：保留做续传
  if (!skipExisting && fs.existsSync(outputDir)) {
    log(`  清理旧输出目录: ${outputDir}`);
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch (e) {
      try {
        function forceRmdir(dir) {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) forceRmdir(p);
            else { try { fs.unlinkSync(p); } catch (_) {} }
          }
          try { fs.rmdirSync(dir); } catch (_) {}
        }
        forceRmdir(outputDir);
      } catch (_) {
        log(`  ⚠ 部分文件被占用，将直接覆盖`);
      }
    }
  } else if (skipExisting) {
    log(`  📌 断点续传模式：跳过已下载文档`);
  }

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
    const docName = nameMap.get(doc.uuid) || safeName(doc.title);
    log(`  [${i + 1}/${allDocs.length}] ${docName}`);

    const docPath = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
    const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPath, nameMap, downloadResources, skipExisting);

    if (result.ok && result.cached) skipCount++;
    else if (result.ok) successCount++;
    else failCount++;
  }

  const total = allDocs.length;
  log(`\n  知识库 "${kbInfo.bookName}" 完成! 成功: ${successCount}  跳过: ${skipCount}  失败: ${failCount}`);
  return { ok: true, total, successCount, skipCount, failCount };
}

// ========== 全部知识库下载 ==========

async function downloadAllKbs(token, outputDir, downloadResources = false, skipExisting = true) {
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
      const kbResult = await downloadEntireKb(kbUrl, token, kbOutDir, downloadResources, skipExisting);
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
      log('');
    }
  }

  log(`\n全部下载完成! 知识库: ${kbs.length}  文档: ${grandTotal}  成功: ${grandSuccess}  跳过: ${grandSkip}  失败: ${grandFail}`);
  return { ok: true, totalKbs: kbs.length, grandTotal, grandSuccess, grandSkip, grandFail };
}

// ========== 单篇文档下载（现有逻辑，保留兼容） ==========

async function downloadSingleDoc(url, token, outputDir, withSub, downloadResources = false, skipExisting = true) {
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

  // 构建同名去重映射
  const nameMap = buildDedupMap(kbInfo.toc);

  // 查找目标文档
  log(`\n[2/3] 查找目标文档...`);
  const targetDoc = kbInfo.toc.find(
    item => item.type === 'DOC' && item.url === parsed.docSlug
  );

  if (!targetDoc) {
    log(`❌ 未在知识库中找到文档 "${parsed.docSlug}"`);
    return;
  }

  const pathToDoc = getPathToDoc(kbInfo.toc, targetDoc.uuid, nameMap);
  const targetName = nameMap.get(targetDoc.uuid) || safeName(targetDoc.title);
  log(`  找到: ${[...pathToDoc, targetName].join(' > ')}`);

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
    const docName = nameMap.get(doc.uuid) || safeName(doc.title);
    const idx = `[${i + 1}/${docsToDownload.length}]`;
    log(`  ${idx} ${docName}`);

    let docPathPrefix;
    if (withSub && i > 0) {
      docPathPrefix = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
    } else {
      docPathPrefix = pathToDoc;
    }

    const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPathPrefix, nameMap, downloadResources, skipExisting);

    if (result.ok && result.cached) skipCount++;
    else if (result.ok) successCount++;
    else failCount++;
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
  -t, --token <token>        语雀 cookie token（必填，也可通过环境变量 YUQUE_TOKEN 传入）
  -s, --sub                  单文档模式: 同时下载所有子文档
  -o, --output <dir>         输出目录（默认: ./yuque_output）
  -r, --download-resources   下载文档中的静态资源到本地（图片+附件+嵌入音频视频，默认保持远程链接）
  -f, --force                强制重新下载，不跳过已存在的文档（默认: 断点续传模式，跳过已下载）
  --all                      下载所有知识库
  -h, --help                 显示帮助

示例:
  # 下载全部知识库（断点续传模式，跳过已下载）
  node yuque_download.js --all -t "xxx"

  # 下载全部知识库并下载资源
  node yuque_download.js --all -t "xxx" -r

  # 强制重新下载整个知识库（不跳过已下载）
  node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "xxx" -f

  # 下载整个知识库
  node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "xxx"

  # 下载单篇文档
  node yuque_download.js "https://www.yuque.com/xxx/kb/doc-slug" -t "xxx"

  # 下载文档及其所有子文档，并将静态资源保存到本地
  node yuque_download.js "https://www.yuque.com/xxx/kb/doc-slug" -t "xxx" --sub -r

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
  let downloadResources = false;
  let skipExisting = true;
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
    } else if (arg === '-r' || arg === '--download-resources') {
      downloadResources = true;
    } else if (arg === '-f' || arg === '--force') {
      skipExisting = false;
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
    log(`  下载资源: ${downloadResources ? '是' : '否（默认保持远程链接）'}`);
    log(`  覆盖模式: ${skipExisting ? '断点续传（跳过已下载）' : '强制重新下载'}`);
    log('');

  // 模式1: 全部知识库
  if (downloadAll) {
    log('模式: 全部知识库下载');
    log('');
    await downloadAllKbs(token, outputDir, downloadResources, skipExisting);
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
    await downloadSingleDoc(url, token, outputDir, withSub, downloadResources, skipExisting);
  } else if (isKbUrl) {
    // 模式2: 整个知识库下载
    log('模式: 整个知识库下载');
    log('');
    await downloadEntireKb(url, token, outputDir, downloadResources, skipExisting);
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
  downloadDoc,
  downloadResourcesForMd,
  fetchAllKbs,
  fetchKbInfo,
  buildDedupMap,
  getPathToDoc,
  getAllDocNodes,
  parseKbUrl,
  parseDocUrl,
  safeName,
  ensureDir,
  buildHeaders,
};
