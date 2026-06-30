const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const EventEmitter = require('events');
const {
  setLogCallback, fetchAllKbs, fetchKbInfo, buildDedupMap,
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

// ========== 下载 ==========
app.post('/api/download', async (req, res) => {
  try {
    const { token, kbUrl, uuids, downloadResources, outputDir: customDir } = req.body;
    if (!token || !kbUrl || !uuids?.length) return res.status(400).json({ ok: false, error: '缺少参数' });
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setLogCallback((msg) => emitLog(taskId, msg));
    emitLog(taskId, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 开始下载...`);
    tasks.set(taskId, { status: 'running', startTime: Date.now() });

    (async () => {
      try {
        const kbInfo = await fetchKbInfo(kbUrl, token);
        const nameMap = buildDedupMap(kbInfo.toc);
        const outputDir = customDir
          ? path.join(customDir, safeName(kbInfo.bookName))
          : path.join(__dirname, 'yuque_output', safeName(kbInfo.bookName));
        if (fs.existsSync(outputDir)) { emitLog(taskId, '清理旧输出目录...'); fs.rmSync(outputDir, { recursive: true, force: true }); }
        let success = 0, fail = 0;
        const allDocs = getAllDocNodes(kbInfo.toc);
        const docsToDownload = allDocs.filter(doc => uuids.includes(doc.uuid));
        for (let i = 0; i < docsToDownload.length; i++) {
          const doc = docsToDownload[i];
          const docName = nameMap.get(doc.uuid) || safeName(doc.title);
          emitLog(taskId, `[${i + 1}/${docsToDownload.length}] ${docName}`);
          const docPath = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
          const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPath, nameMap, !!downloadResources);
          if (result.ok) success++; else fail++;
        }
        emitLog(taskId, `\n完成! 成功: ${success}, 失败: ${fail}`);
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

// ========== 文件夹选择（独立进程 + 临时文件） ==========
function runDetachedDialog(res) {
  const tmpFile = path.join(os.tmpdir(), 'yuque2md_select_' + Date.now() + '.txt');
  const escapedTmp = tmpFile.replace(/\\/g, '\\\\');
  const script = `\\"[Console]::OutputEncoding=[Text.Encoding]::UTF8;$s=New-Object -ComObject Shell.Application;$f=$s.BrowseForFolder(0,'选择下载目录',0,0);if($f){Set-Content -Path '${escapedTmp}' -Value $f.Self.Path -Encoding UTF8}\\"`;
  require('child_process').exec(`cmd /c start /min powershell -NoProfile -Command ${script}`, { windowsHide: true, timeout: 120000 }, () => {
    setTimeout(() => {
      try { const p = fs.readFileSync(tmpFile, 'utf-8').trim(); fs.unlinkSync(tmpFile); res.json({ ok: true, path: p }); }
      catch (e) { res.json({ ok: false, error: '用户取消或选择失败' }); }
    }, 500);
  });
}

app.post('/api/select-folder', (req, res) => runDetachedDialog(res));
app.post('/api/test-select-folder-1', (req, res) => runDetachedDialog(res));

// ========== 启动 ==========
app.listen(PORT, () => console.log(`yuque2md GUI 已启动: http://localhost:${PORT}`));
