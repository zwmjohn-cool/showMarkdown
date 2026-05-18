# Show Markdown

Show Markdown 是一个 Zotero 插件，用来配合 MinerU 的 OCR/PDF 解析结果使用。它可以把 MinerU 生成的 Markdown 加到 Zotero 条目里，也可以在 Zotero PDF 阅读器中显示 MinerU 的版面框和翻译结果。

## 主要功能

- 从 MinerU 缓存目录读取 Markdown，并在 Zotero 条目中生成/显示对应的 Markdown 附件。
- 在 Zotero PDF 阅读器右侧栏提供 `MinerU` 工具入口。
- 读取 MinerU 结果目录中的 `layout.json`，在 PDF 页面上绘制 bounding box。
- `Toggle` 按钮控制 bounding box 显示/隐藏。
- 使用本地 OpenAI-compatible 大模型接口翻译 OCR 文本。
- 翻译配置支持：
  - URL
  - 模型名
  - 提示词 Prompt
  - 要从翻译结果中删除的字符串
  - 翻译页码范围
  - 跳过页码范围
  - 并行数
- `Translate` 按钮开始翻译，`Stop` 按钮终止当前翻译任务。
- 翻译结果会保存到 MinerU 结果目录中的 `show-markdown-translations.json`，下次打开会自动复用。
- 翻译完成一个 bounding box 后会立即显示到对应框内。
- 有翻译文字的框支持：
  - 白色背景
  - 可配置边框颜色
  - 可配置字体颜色和字体大小
  - 渲染 `$...$` 和 `$$...$$` 形式的公式
  - 框内滚动
  - 选择和复制翻译文字
- 没有翻译文字的框只显示边框，并允许点穿到底层 PDF 原文。

## 本地大模型

默认配置：

- URL: `http://127.0.0.1:1234`
- Model: `qwen/qwen3.6-27b`

接口需要兼容 OpenAI Chat Completions：

```text
POST /v1/chat/completions
```

## 安装

从 GitHub Release 下载 `.xpi` 文件，然后在 Zotero 中安装：

1. 打开 Zotero。
2. 进入插件管理页面。
3. 选择从文件安装插件。
4. 选择下载的 `show-markdown-*.xpi`。

Release 页面：

https://github.com/zwmjohn-cool/showMarkdown/releases

## 开发

安装依赖：

```bash
npm ci
```

构建 XPI：

```bash
npm run build
```

构建产物位于：

```text
.scaffold/build/show-markdown.xpi
```

开发模式：

```bash
npm run start
```

## 自动发布

仓库包含 GitHub Actions workflow：

```text
.github/workflows/release.yml
```

推送 `v*` tag 时会自动：

1. 安装依赖。
2. 构建插件。
3. 生成 `.xpi`。
4. 创建 GitHub Release。
5. 上传 XPI 到 Release assets。

示例：

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```
