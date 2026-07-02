const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const EventEmitter = require('events');
const {
  setLogCallback, fetchAllKbs, fetchKbInfo, fetchPublicKbInfo, buildDedupMap,
  getPathToDoc, getAllDocNodes, downloadDoc, downloadResourcesForMd,
  buildHeaders, safeName, ensureDir,
} = require('./yuque_download');

const app = express();
const PORT = 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/test/folder', express.static(path.join(__dirname, '..', '临时文件夹', '代码测试', '文件夹选择测试')));

const tasks = new Map();
const taskEmitter = new EventEmitter();
function emitLog(taskId, msg) { taskEmitter.emit(taskId, msg); }

// ========== 知识库列表 ==========
app.post('/api/kbs', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: '缺少 token' });
    const kbs = await fetchAllKbs(token);
    res.json({ ok: true, kbs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== TOC 树 ==========
app.post('/api/toc', async (req, res) => {
  try {
    const { token, kbUrl } = req.body;
    if (!token || !kbUrl) return res.status(400).json({ ok: false, error: '缺少参数' });
    const kbInfo = await fetchKbInfo(kbUrl, token);
    const nameMap = buildDedupMap(kbInfo.toc);
    function buildTree(parentUuid) {
      const children = kbInfo.toc.filter(item => (item.parent_uuid || '') === (parentUuid || ''));
      children.sort((a, b) => (a.order || 0) - (b.order || 0));
      return children.map(item => ({
        uuid: item.uuid, title: item.title, type: item.type, url: item.url || null,
        child_uuid: item.child_uuid || null,
        displayName: nameMap.get(item.uuid) || safeName(item.title),
        isDeduped: (nameMap.get(item.uuid) || safeName(item.title)) !== safeName(item.title),
        children: buildTree(item.uuid),
      }));
    }
    res.json({ ok: true, kb: { bookId: kbInfo.bookId, bookName: kbInfo.bookName, host: kbInfo.host }, tree: buildTree(null) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== 公开文档 TOC（无需 token）==========
app.post('/api/public-toc', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: '缺少文档 URL' });
    const kbInfo = await fetchPublicKbInfo(url);
    const nameMap = buildDedupMap(kbInfo.toc);
    function buildTree(parentUuid) {
      const children = kbInfo.toc.filter(item => (item.parent_uuid || '') === (parentUuid || ''));
      children.sort((a, b) => (a.order || 0) - (b.order || 0));
      return children.map(item => ({
        uuid: item.uuid, title: item.title, type: item.type, url: item.url || null,
        child_uuid: item.child_uuid || null,
        displayName: nameMap.get(item.uuid) || safeName(item.title),
        isDeduped: (nameMap.get(item.uuid) || safeName(item.title)) !== safeName(item.title),
        children: buildTree(item.uuid),
      }));
    }
    res.json({ ok: true, kb: { bookId: kbInfo.bookId, bookName: kbInfo.bookName, host: kbInfo.host }, tree: buildTree(null) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== 公开文档下载 ==========
app.post('/api/public-download', async (req, res) => {
  try {
    const { url: docUrl, uuids, downloadResources, outputDir: customDir, skipExisting } = req.body;
    if (!docUrl || !uuids?.length) return res.status(400).json({ ok: false, error: '缺少参数' });
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setLogCallback((msg) => emitLog(taskId, msg));
    emitLog(taskId, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 开始下载...`);
    tasks.set(taskId, { status: 'running', startTime: Date.now(), cancelled: false });
    emitLog(taskId, '🌐 公开文档模式（无需 token）');

    (async () => {
      try {
        const kbInfo = await fetchPublicKbInfo(docUrl);
        const nameMap = buildDedupMap(kbInfo.toc);
        const outputDir = customDir
          ? path.join(customDir, safeName(kbInfo.bookName))
          : path.join(__dirname, 'yuque_output', safeName(kbInfo.bookName));
        const doSkip = skipExisting !== false;
        if (!doSkip && fs.existsSync(outputDir)) { emitLog(taskId, '清理旧输出目录...'); try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { emitLog(taskId, '目录被占用，将直接覆盖文件'); } }
        if (doSkip) { emitLog(taskId, '📌 断点续传模式'); }
        let success = 0, fail = 0, skip = 0;
        const allDocs = getAllDocNodes(kbInfo.toc);
        const docsToDownload = allDocs.filter(doc => uuids.includes(doc.uuid));
        emitLog(taskId, `共计 ${docsToDownload.length} 篇文档`);
        for (let i = 0; i < docsToDownload.length; i++) {
          if (tasks.get(taskId)?.cancelled) { emitLog(taskId, '⏹ 已手动停止'); emitLog(taskId, '__DONE__'); tasks.set(taskId, { status: 'cancelled' }); return; }
          const doc = docsToDownload[i];
          const docName = nameMap.get(doc.uuid) || safeName(doc.title);
          emitLog(taskId, `[${i + 1}/${docsToDownload.length}] ${docName}`);
          const docPath = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
          const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, '', outputDir, docPath, nameMap, !!downloadResources, doSkip, doc.type);
          if (result.ok) { if (result.cached) skip++; else success++; } else fail++;
        }
        emitLog(taskId, `\n━━━━ 下载完成 ━━━━`);
        emitLog(taskId, `  成功: ${success}  跳过: ${skip}  失败: ${fail}  合计: ${docsToDownload.length}`);
        emitLog(taskId, `文件保存在: ${outputDir}`);
        emitLog(taskId, '__DONE__');
        tasks.set(taskId, { status: 'done', outputDir });
      } catch (e) { emitLog(taskId, `\n❌ 出错: ${e.message}`); emitLog(taskId, '__DONE__'); tasks.set(taskId, { status: 'error', error: e.message }); }
    })();
    res.json({ ok: true, taskId });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== 下载 ==========
app.post('/api/download', async (req, res) => {
  try {
    const { token, kbUrl, uuids, downloadResources, outputDir: customDir, skipExisting } = req.body;
    if (!token || !kbUrl || !uuids?.length) return res.status(400).json({ ok: false, error: '缺少参数' });
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setLogCallback((msg) => emitLog(taskId, msg));
    emitLog(taskId, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 开始下载...`);
    tasks.set(taskId, { status: 'running', startTime: Date.now(), cancelled: false });

    (async () => {
      try {
        const kbInfo = await fetchKbInfo(kbUrl, token);
        const nameMap = buildDedupMap(kbInfo.toc);
        const outputDir = customDir
          ? path.join(customDir, safeName(kbInfo.bookName))
          : path.join(__dirname, 'yuque_output', safeName(kbInfo.bookName));
        // 强制模式：清理旧目录；断点模式：保留
        const doSkip = skipExisting !== false;
        if (!doSkip && fs.existsSync(outputDir)) { emitLog(taskId, '清理旧输出目录...'); try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { emitLog(taskId, '目录被占用，将直接覆盖文件'); } }
        if (doSkip) { emitLog(taskId, '📌 断点续传模式'); }
        let success = 0, fail = 0, skip = 0;
        const allDocs = getAllDocNodes(kbInfo.toc);
        const docsToDownload = allDocs.filter(doc => uuids.includes(doc.uuid));
        emitLog(taskId, `共计 ${docsToDownload.length} 篇文档`);
        for (let i = 0; i < docsToDownload.length; i++) {
          if (tasks.get(taskId)?.cancelled) { emitLog(taskId, '⏹ 已手动停止'); emitLog(taskId, '__DONE__'); tasks.set(taskId, { status: 'cancelled' }); return; }
          const doc = docsToDownload[i];
          const docName = nameMap.get(doc.uuid) || safeName(doc.title);
          emitLog(taskId, `[${i + 1}/${docsToDownload.length}] ${docName}`);
          const docPath = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
          const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPath, nameMap, !!downloadResources, doSkip);
          if (result.ok) { if (result.cached) skip++; else success++; } else fail++;
        }
        emitLog(taskId, `\n━━━━ 下载完成 ━━━━`);
        emitLog(taskId, `  成功: ${success}  跳过: ${skip}  失败: ${fail}  合计: ${docsToDownload.length}`);
        emitLog(taskId, `文件保存在: ${outputDir}`);
        emitLog(taskId, '__DONE__');
        tasks.set(taskId, { status: 'done', outputDir });
      } catch (e) { emitLog(taskId, `\n❌ 出错: ${e.message}`); emitLog(taskId, '__DONE__'); tasks.set(taskId, { status: 'error', error: e.message }); }
    })();
    res.json({ ok: true, taskId });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ========== SSE 日志 ==========
app.get('/api/logs/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const listener = (msg) => { res.write(`data: ${msg}\n\n`); if (msg === '__DONE__') { res.end(); taskEmitter.removeListener(taskId, listener); } };
  taskEmitter.on(taskId, listener);
  req.on('close', () => taskEmitter.removeListener(taskId, listener));
});

// ========== 取消下载 ==========
app.post('/api/cancel/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = tasks.get(taskId);
  if (task && task.status === 'running') {
    task.cancelled = true;
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: '任务不存在或已完成' });
  }
});

// ========== 文件夹选择 ==========
function runDetachedDialog(res) {
  const cp = require('child_process');
  const psScript = `
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $s = New-Object -ComObject Shell.Application
    $f = $s.BrowseForFolder(0, '选择下载目录', 0, 0)
    if ($f) { Write-Output $f.Self.Path }
  `.trim();
  const child = cp.execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 120000 });
  let stdout = '';
  child.stdout.on('data', d => stdout += d);
  child.on('close', () => {
    const p = stdout.trim();
    res.json(p ? { ok: true, path: p } : { ok: false, error: '用户取消' });
  });
}

app.post('/api/select-folder', (req, res) => runDetachedDialog(res));
app.post('/api/test-select-folder-1', (req, res) => runDetachedDialog(res));

// ========== 启动 ==========
app.listen(PORT, () => console.log(`yuque2md GUI 已启动: http://localhost:${PORT}`));
