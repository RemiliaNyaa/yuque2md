/**
 * 语雀文档下载工具 - Web 界面服务端
 * 用法: node server.js
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { EventEmitter } = require('events');
const {
  setLogCallback,
  downloadAllKbs,
  downloadEntireKb,
  downloadSingleDoc,
  parseKbUrl,
  parseDocUrl,
} = require('./yuque_download');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 活跃任务
const tasks = new Map();

function createTask() {
  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const emitter = new EventEmitter();
  const logs = [];
  tasks.set(taskId, { emitter, logs, status: 'pending', result: null });
  return taskId;
}

function finishTask(taskId, result) {
  const task = tasks.get(taskId);
  if (task) {
    task.status = 'done';
    task.result = result;
    task.emitter.emit('done', result);
    task.emitter.emit('log', '═══════════════════════════════════════');
    task.emitter.emit('log', result.summary || '✅ 下载完成');
  }
  // 5 分钟后清理
  setTimeout(() => tasks.delete(taskId), 5 * 60 * 1000);
}

function failTask(taskId, error) {
  const task = tasks.get(taskId);
  if (task) {
    task.status = 'error';
    task.result = { error: error.message };
    task.emitter.emit('log', '═══════════════════════════════════════');
    task.emitter.emit('log', `❌ 运行出错: ${error.message}`);
    task.emitter.emit('done', { error: error.message });
  }
  setTimeout(() => tasks.delete(taskId), 5 * 60 * 1000);
}

// SSE 日志流
app.get('/api/logs/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = tasks.get(taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 发送已有日志
  for (const log of task.logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`);
  }

  const onLog = (msg) => {
    res.write(`data: ${JSON.stringify({ type: 'log', message: msg })}\n\n`);
  };

  const onDone = (result) => {
    res.write(`data: ${JSON.stringify({ type: 'done', result })}\n\n`);
    res.end();
  };

  task.emitter.on('log', onLog);
  task.emitter.on('done', onDone);

  req.on('close', () => {
    task.emitter.off('log', onLog);
    task.emitter.off('done', onDone);
  });
});

// 下载 API
app.post('/api/download', async (req, res) => {
  const { token, url, mode, withSub, downloadImages, outputDir } = req.body;

  if (!token) {
    return res.status(400).json({ error: '请提供 token' });
  }

  const taskId = createTask();
  const task = tasks.get(taskId);
  res.json({ taskId });

  // 设置本任务的日志回调
  setLogCallback((msg) => {
    task.logs.push(msg);
    task.emitter.emit('log', msg);
  });

  try {
    let result;

    // 确定实际输出目录
    const baseOut = outputDir || path.join(__dirname, 'yuque_output');
    const actualOut = path.resolve(baseOut);

    task.emitter.emit('log', `输出目录: ${actualOut}`);
    task.emitter.emit('log', `下载图片: ${downloadImages ? '是' : '否'}`);
    task.emitter.emit('log', '');

    if (mode === 'all') {
      task.emitter.emit('log', '模式: 全部知识库下载');
      task.emitter.emit('log', '');
      result = await downloadAllKbs(token, actualOut, downloadImages);
      result.title = '全部知识库下载';
    } else if (mode === 'kb') {
      task.emitter.emit('log', '模式: 整个知识库下载');
      task.emitter.emit('log', `URL: ${url}`);
      task.emitter.emit('log', '');
      result = await downloadEntireKb(url, token, actualOut, downloadImages);
    } else if (mode === 'doc') {
      task.emitter.emit('log', `模式: 单文档下载${withSub ? '（含子文档）' : ''}`);
      task.emitter.emit('log', `URL: ${url}`);
      task.emitter.emit('log', '');
      await downloadSingleDoc(url, token, actualOut, withSub, downloadImages);
    } else {
      throw new Error(`未知模式: ${mode}`);
    }

    finishTask(taskId, { ...(result || {}), outputDir: actualOut });
  } catch (e) {
    failTask(taskId, e);
  } finally {
    setLogCallback(null);
  }
});

// 打开系统文件夹选择对话框，返回选中路径
app.post('/api/select-dir', (req, res) => {
  const { exec, spawn } = require('child_process');
  const os = require('os');

  if (process.platform === 'win32') {
    // 使用 IFileOpenDialog COM 接口（Vista+ 现代化文件夹选择对话框）
    const csFile = path.join(__dirname, 'test', 'FolderPicker.cs');
    const resultFile = path.join(os.tmpdir(), 'yq_fp_result.txt');
    const psFile = path.join(os.tmpdir(), 'yq_picker.ps1');

    // 清理旧结果
    try { fs.unlinkSync(resultFile); } catch (_) {}

    // 生成临时 PS 脚本（路径用单引号，反斜杠是字面量）
    const psScript =
`$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$outFile = '${resultFile}'
Add-Type -Path '${csFile}' | Out-Null
$desktop = [Environment]::GetFolderPath("Desktop")
try {
    $p = [FolderPicker.Dialog]::PickFolder("\u6d4f\u89c8", $desktop)
    if ($p) {
        [System.IO.File]::WriteAllText($outFile, "OK:" + $p, [System.Text.Encoding]::UTF8)
    } else {
        [System.IO.File]::WriteAllText($outFile, "CANCEL", [System.Text.Encoding]::UTF8)
    }
} catch {
    [System.IO.File]::WriteAllText($outFile, "ERROR:" + $_.Exception.Message, [System.Text.Encoding]::UTF8)
}`;
    fs.writeFileSync(psFile, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]), // UTF-8 BOM
      Buffer.from(psScript, 'utf8')
    ]));

    // 用 start 打开可见窗口
    exec(`cmd /c start "SelectFolder" powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, (launchErr) => {
      if (launchErr) {
        try { fs.unlinkSync(psFile); } catch (_) {}
        return res.json({ path: null, error: launchErr.message });
      }

      // 轮询结果文件（最长等 120 秒）
      const startTime = Date.now();
      const maxWait = 120000;
      const check = setInterval(() => {
        try {
          const data = fs.readFileSync(resultFile, 'utf8').trim();
          clearInterval(check);
          // 清理临时文件
          try { fs.unlinkSync(psFile); } catch (_) {}
          try { fs.unlinkSync(resultFile); } catch (_) {}

          if (data.startsWith('OK:')) {
            return res.json({ path: data.substring(3) });
          } else if (data.startsWith('ERROR:')) {
            return res.json({ path: null, error: data.substring(6) });
          } else {
            return res.json({ path: null });
          }
        } catch (_) {
          if (Date.now() - startTime > maxWait) {
            clearInterval(check);
            try { fs.unlinkSync(psFile); } catch (_) {}
            try { fs.unlinkSync(resultFile); } catch (_) {}
            return res.json({ path: null, error: '操作超时' });
          }
        }
      }, 500);
    });

  } else if (process.platform === 'darwin') {
    exec(`osascript -e 'POSIX path of (choose folder with prompt "选择输出目录")'`,
      { timeout: 60000, encoding: 'buffer' }, (err, stdout) => {
        if (err && err.killed) return res.json({ path: null, error: '操作超时' });
        const result = stdout ? stdout.toString('utf8').trim() : '';
        res.json({ path: result || null });
      });
  } else {
    exec(`zenity --file-selection --directory --title="选择输出目录" 2>/dev/null || echo ""`,
      { timeout: 60000, encoding: 'buffer' }, (err, stdout) => {
        if (err && err.killed) return res.json({ path: null, error: '操作超时' });
        const result = stdout ? stdout.toString('utf8').trim() : '';
        res.json({ path: result || null });
      });
  }
});

// 主页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🌐 语雀文档下载工具 - Web 界面`);
  console.log(`  📍 http://localhost:${PORT}`);
  console.log(`  ⏹ 按 Ctrl+C 停止服务\n`);
});
