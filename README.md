# 语雀文档下载工具

下载语雀文档，按知识库目录结构保存为本地 markdown 文件。支持 **命令行** 和 **Web 图形界面** 两种使用方式。

## 环境要求

- Node.js >= 14

## 安装

```bash
git clone https://github.com/RemiliaNyaa/yuque2md.git
cd yuque2md
npm install
```

或者直接下载 `yuque_download.js`，手动安装 axios：

```bash
npm install axios
```

## 使用方法

### 方式一：Web 图形界面（推荐）

```bash
npm run start:web
```

浏览器访问 `http://localhost:3456`。

**新版 GUI 特性：**
- 🔑 **仅需 Token**：无需手动输入 URL，自动列出所有知识库
- 🌲 **文档树浏览**：点击展开知识库，层层浏览文档结构
- ☑ **自由勾选**：选中任意文档即可下载，支持递归勾选
- 📦 **资源下载开关**：可选是否下载图片和附件到本地
- 📟 **实时日志**：SSE 推送下载进度，深色终端风格面板

> 点击知识库旁的 ▶ 按钮即可加载文档树，勾选需要的文档后点击「下载已选文档」。

### 方式二：命令行

```bash
node yuque_download.js [模式] -t <token> [选项]
```

三种模式由 URL 格式自动判断：

| 模式 | 命令 | 说明 |
|---|---|---|
| 全部知识库 | `--all -t <token>` | 下载账号下所有知识库 |
| 单知识库 | `<知识库URL> -t <token>` | 下载整个知识库 |
| 单文档 | `<文档URL> -t <token> [--sub]` | 下载单篇文档（可选子文档） |

### 选项

| 参数 | 说明 |
|---|---|
| `-t, --token <token>` | 语雀 cookie token（必填，也可设置环境变量 `YUQUE_TOKEN`） |
| `-s, --sub` | 单文档模式: 同时下载所有子文档 |
| `-o, --output <dir>` | 输出目录（默认: `./yuque_output`） |
| `-r, --download-resources` | 下载文档中的静态资源到本地（默认保持远程链接） |
| `-f, --force` | 强制重新下载，不跳过已存在的文档 |
| `--all` | 下载全部知识库 |
| `-h, --help` | 显示帮助 |

> **默认行为**: 断点续传模式，自动跳过已下载完成的文档。如需强制全部重新下载，添加 `-f` / `--force` 参数。
> 
> **⚠ 注意**: 如果切换了 `-r` 开关（从下载资源切到不下载，或反过来），建议使用 `-f` 强制重下，因为已下载的文档不会自动更新为带资源/不带资源的版本。

### 示例

```bash
# 下载全部知识库
node yuque_download.js --all -t "你的token"

# 下载全部知识库，并将静态资源保存到本地
node yuque_download.js --all -t "你的token" -r

# 下载整个知识库
node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "你的token"

# 只下载单篇文档
node yuque_download.js "https://www.yuque.com/xxx/kb/doc-slug" -t "你的token"

# 下载文档及其所有子文档，并将静态资源保存到本地
node yuque_download.js "https://www.yuque.com/xxx/kb/doc-slug" -t "你的token" --sub -r

# 强制重新下载（不跳过已存在文档）
node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "你的token" -f

# 指定输出目录
node yuque_download.js "https://www.yuque.com/xxx/kb-slug" -t "你的token" -o "./my_docs"
```

## 获取 token

打开语雀网页 → F12 → Application → Cookies → 找到 `_yuque_session`，复制它的值。

![获取token](./如何获取语雀的token.png)

> ⚠️ token 是你个人登录凭证，请勿泄露给他人。

## 特性

- 支持公开和私有知识库（私有需 token）
- 支持单篇下载或递归下载子树
- 按知识库原始目录结构保存文件
- 已下载的文件自动跳过（断点续传）
- 零配置，单文件即可运行
- 支持下载文档中的静态资源到本地（`-r` 参数）
- 自动处理同名文档/分组冲突（uuid 后缀去重）

### 静态资源下载

使用 `-r` 或 `--download-resources` 参数可将文档中引用的所有静态资源下载到本地：

- **支持类型**: 图片（png、jpg、jpeg、gif、webp、svg、bmp，来源 `cdn.nlark.com`）+ 附件（所有格式，来源 `yuque.com/attachments`）+ **语雀嵌入本地文件、音频、视频**（通过 HTML 源自动提取 `data-audio-src` / `data-video-src` 并下载，文档末尾追加本地资源索引）
- **文件组织**: 每级目录下统一使用 `resources/` 根文件夹，按文档名分子目录存放所有资源文件
- **链接替换**: 文档中的远程链接自动替换为 `./resources/{文档名}/` 相对路径

> 📌 不加 `-r` 参数时，所有资源链接保持语雀云端链接形式。

### 同名文档/分组处理

语雀允许同目录下存在同名文档或分组（内部通过 uuid 区分）。本工具自动检测并处理冲突，对于同名文档或分组，统一使用 `_uuid` 后 8 位作为后缀：

- **同名文档**: `资源文档_svjUKM_8.md`
- **同名分组**: `分组_zCk9b7u0/`

## License

MIT
