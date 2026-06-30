const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const EventEmitter = require('events');
const {
  setLogCallback,
  fetchAllKbs,
  fetchKbInfo,
  buildDedupMap,
  getPathToDoc,
  getAllDocNodes,
  downloadDoc,
  downloadResourcesForMd,
  buildHeaders,
  safeName,
  ensureDir,
} = require('./yuque_download');

const app = express();
const PORT = 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// 测试页面
app.use('/test/folder', express.static(path.join(__dirname, '..', '临时文件夹', '代码测试', '文件夹选择测试')));

// 任务管理
const tasks = new Map();
const taskEmitter = new EventEmitter();

function emitLog(taskId, msg) {
  taskEmitter.emit(taskId, msg);
}

// ========== API: 获取知识库列表 ==========
app.post('/api/kbs', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: '缺少 token' });

    const kbs = await fetchAllKbs(token);
    res.json({ ok: true, kbs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== API: 获取知识库 TOC ==========
app.post('/api/toc', async (req, res) => {
  try {
    const { token, kbUrl } = req.body;
    if (!token || !kbUrl) return res.status(400).json({ ok: false, error: '缺少参数' });

    const kbInfo = await fetchKbInfo(kbUrl, token);
    const nameMap = buildDedupMap(kbInfo.toc);

    // 构建完整嵌套树
    function buildTree(parentUuid) {
      const children = kbInfo.toc.filter(item => {
        const pid = item.parent_uuid || '';
        const targetPid = parentUuid || '';
        return pid === targetPid;
      });
      children.sort((a, b) => (a.order || 0) - (b.order || 0));

      return children.map(item => ({
        uuid: item.uuid,
        title: item.title,
        type: item.type,
        url: item.url || null,
        child_uuid: item.child_uuid || null,
        displayName: nameMap.get(item.uuid) || safeName(item.title),
        isDeduped: (nameMap.get(item.uuid) || safeName(item.title)) !== safeName(item.title),
        children: buildTree(item.uuid),
      }));
    }

    res.json({
      ok: true,
      kb: { bookId: kbInfo.bookId, bookName: kbInfo.bookName, host: kbInfo.host },
      tree: buildTree(null),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== API: 下载选定文档 ==========
app.post('/api/download', async (req, res) => {
  try {
    const { token, kbUrl, uuids, downloadResources, outputDir: customDir } = req.body;
    if (!token || !kbUrl || !uuids || !uuids.length) {
      return res.status(400).json({ ok: false, error: '缺少参数' });
    }

    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    setLogCallback((msg) => emitLog(taskId, msg));
    emitLog(taskId, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 开始下载...`);

    tasks.set(taskId, { status: 'running', startTime: Date.now() });

    // 异步执行下载
    (async () => {
      try {
        const kbInfo = await fetchKbInfo(kbUrl, token);
        const nameMap = buildDedupMap(kbInfo.toc);
        const kbDir = customDir
          ? path.join(customDir, safeName(kbInfo.bookName))
          : path.join(__dirname, 'yuque_output', safeName(kbInfo.bookName));
        const outputDir = kbDir;

        // 清理旧输出
        if (fs.existsSync(outputDir)) {
          emitLog(taskId, `清理旧输出目录...`);
          fs.rmSync(outputDir, { recursive: true, force: true });
        }

        let success = 0, fail = 0;
        const uuidSet = new Set(uuids);

        // 收集所有要下载的文档（包括子文档）
        const allDocs = getAllDocNodes(kbInfo.toc);
        const docsToDownload = allDocs.filter(doc => uuidSet.has(doc.uuid));

        for (let i = 0; i < docsToDownload.length; i++) {
          const doc = docsToDownload[i];
          const docName = nameMap.get(doc.uuid) || safeName(doc.title);
          emitLog(taskId, `[${i + 1}/${docsToDownload.length}] ${docName}`);

          const docPath = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
          const result = await downloadDoc(doc, kbInfo.bookId, kbInfo.host, token, outputDir, docPath, nameMap, !!downloadResources);

          if (result.ok) success++;
          else fail++;
        }

        emitLog(taskId, `\n完成! 成功: ${success}, 失败: ${fail}`);
        emitLog(taskId, `文件保存在: ${outputDir}`);
        emitLog(taskId, '__DONE__');
        tasks.set(taskId, { status: 'done', outputDir });
      } catch (e) {
        emitLog(taskId, `\n❌ 出错: ${e.message}`);
        emitLog(taskId, '__DONE__');
        tasks.set(taskId, { status: 'error', error: e.message });
      }
    })();

    res.json({ ok: true, taskId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== SSE 日志推送 ==========
app.get('/api/logs/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const listener = (msg) => {
    res.write(`data: ${msg}\n\n`);
    if (msg === '__DONE__') {
      res.end();
      taskEmitter.removeListener(taskId, listener);
    }
  };

  taskEmitter.on(taskId, listener);

  req.on('close', () => {
    taskEmitter.removeListener(taskId, listener);
  });
});

// ========== API: 获取文档内容（供浏览器侧写入） ==========
app.post('/api/fetch-docs', async (req, res) => {
  try {
    const { token, kbUrl, uuids } = req.body;
    if (!token || !kbUrl || !uuids?.length) return res.status(400).json({ ok: false, error: '缺少参数' });

    const kbInfo = await fetchKbInfo(kbUrl, token);
    const nameMap = buildDedupMap(kbInfo.toc);
    const allDocs = getAllDocNodes(kbInfo.toc);
    const uuidSet = new Set(uuids);
    const selected = allDocs.filter(d => uuidSet.has(d.uuid));

    const results = [];
    for (const doc of selected) {
      try {
        const articleUrl = doc.url;
        if (!articleUrl) continue;

        const apiUrl = `${kbInfo.host}/api/docs/${articleUrl}?book_id=${String(kbInfo.bookId)}&mode=markdown&merge_dynamic_data=false`;
        const headers = buildHeaders(token);
        const resp = await axios.get(apiUrl, { headers, timeout: 30000 });
        const docData = resp.data;

        let body = '';
        if (docData?.data?.sourcecode) body = docData.data.sourcecode;
        else if (docData?.data?.body) body = docData.data.body;
        else {
          try {
            const altUrl = `${kbInfo.host}/api/docs/${articleUrl}?book_id=${String(kbInfo.bookId)}`;
            const altResp = await axios.get(altUrl, { headers, timeout: 30000 });
            if (altResp.data?.data?.content) body = altResp.data.data.content;
          } catch (e) {}
        }

        const docName = nameMap.get(doc.uuid) || safeName(doc.title);
        const docPath = getPathToDoc(kbInfo.toc, doc.uuid, nameMap);
        const content = '# ' + doc.title + '\n\n' + (body || '');
        results.push({
          uuid: doc.uuid,
          title: doc.title,
          docName: docName,
          dirPath: docPath.join('/'),
          content: content,
          size: content.length,
        });
      } catch (e) {
        results.push({ uuid: doc.uuid, title: doc.title, error: e.message });
      }
    }

    res.json({ ok: true, kbName: kbInfo.bookName, total: results.length, docs: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== API: 原生文件夹选择对话框 ==========
app.post('/api/select-folder', (req, res) => {
  const cp = require('child_process');
  // 调用 PowerShell 弹出原生文件夹对话框（无 cmd 窗口）
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择下载目录'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq 'OK') {
      Write-Output $dialog.SelectedPath
    }
  `;
  const child = cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    windowsHide: true,
    timeout: 120000,
  });
  let stdout = '';
  child.stdout.on('data', d => stdout += d);
  child.on('close', code => {
    const p = stdout.trim();
    if (p) {
      res.json({ ok: true, path: p });
    } else {
      res.json({ ok: false, error: '用户取消或选择失败' });
    }
  });
});

// ========== 启动 ==========
app.listen(PORT, () => {
  console.log(`yuque2md GUI 已启动: http://localhost:${PORT}`);
});
