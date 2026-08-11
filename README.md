# Job Agent

一个在本机运行的求职检索与审阅工具。它通过 Tampermonkey Worker 按顺序操作 LinkedIn、Indeed 和 SEEK，将职位汇总到本地面板，再结合职业画像进行职位名初筛、JD 审阅和每日人工复盘。

项目不会自动投递职位，也不会绕过登录、验证码或平台安全检查。遇到需要人工处理的页面时，任务会暂停并等待用户继续。

## 最快打开方式

需要先安装 [Node.js](https://nodejs.org/) 18 或更高版本。

在 PowerShell 中运行：

```powershell
cd C:\path\to\job_agent
npm start
```

看到下面的信息后，保持这个 PowerShell 窗口打开：

```text
Job Agent is running at http://127.0.0.1:4317
```

然后在浏览器打开：

<http://127.0.0.1:4317>

日常再次使用时，只需要进入项目目录运行 `npm start`，再打开上面的地址。关闭运行 `npm start` 的终端或按 `Ctrl+C` 即可停止服务。

## 首次安装

```powershell
git clone https://github.com/Young501/job_agent.git
cd job_agent
npm start
```

这个项目目前没有第三方 Node.js 依赖，因此不需要额外执行 `npm install`。

启动面板后：

1. 在 Chrome 中安装 Tampermonkey。
2. 打开 Job Agent 左侧的“安装设置”。
3. 点击一键安装，或分别安装 LinkedIn、Indeed、SEEK Worker。
4. 在 Tampermonkey 安装页面确认安装。已有同一 Worker 的旧版本会被更新。
5. 保持三个平台处于登录状态。

Worker 只有在 Job Agent 发出预检或运行任务时才会自动操作网页。平时正常浏览招聘网站不会开始扫描。

## PDF 简历

`.txt`、`.md` 和 `.docx` 可以直接读取。读取文字型 PDF 还需要 Python 3 和 `pypdf`：

```powershell
python -m pip install pypdf
```

如果系统中的 Python 命令不是 `python`，可以在 `.env` 中指定：

```dotenv
JOB_AGENT_PYTHON_PATH=C:\path\to\python.exe
```

扫描版 PDF 没有可提取文字时，可将简历内容粘贴到文本框，或使用职业画像页面提供的 GPT Prompt，在 ChatGPT 中生成画像 JSON 后粘贴回来。

## 配置 AI

AI 是可选的。不配置时，职位名筛选、基础 JD 筛选和复盘仍可使用本地规则运行。

推荐直接在“搜索设置 -> AI 服务”中填写：

- Base URL：OpenAI 兼容接口的地址，通常以 `/v1` 结尾。
- Model：接口支持的模型名称。
- API Key：对应接口的密钥。
- API 格式：根据服务选择 Responses API 或 Chat Completions。

先点击“测试连接”，成功后再点击“保存 AI 配置”。API Key 只保存在本机的 `data/ai-config.json`，不会回显到页面，也不会提交到 Git。

也可以复制 `.env.example` 为 `.env` 后通过环境变量配置。默认已限制输入长度、输出 token 和单次运行调用次数。

## 每日使用流程

1. 在“职业画像”上传或粘贴简历，整理候选标签并确认画像。
2. 在“每日任务”选择预设类别导入队列，或创建自定义类别。
3. 对尚未验证的任务执行统一预检。浏览器会实际填写平台、关键词、地点和时间条件。
4. 预检成功后点击“开始运行”。三个平台严格按顺序执行，不会并行操作同一浏览器。
5. 登录、验证码或页面异常需要人工处理时，根据运行监控中的提示处理并继续。
6. 在“职位审阅”查看本次任务统计、筛选结果和 JD 审阅状态。
7. 对没有帮助的职位点击“没帮助”，可选“分类错了”或“与我无关”，也可以补充原因。
8. 当日审阅结束后点击“完成本次审阅并复盘”。学习结果会影响后续排序和筛选，但不会删除任何职位。

历史职位和复盘结论保存在“历史记录”中。撤销旧反馈后，可以选择对应历史批次重新复盘，以清除已经不适用的偏好。

## 数据与安全

以下内容只保存在本机并已被 `.gitignore` 排除：

- `data/state.json`：任务、职位、画像和复盘记录。
- `data/ai-config.json`：AI 服务配置和 API Key。
- `data/uploads/`：临时上传文件。
- `.env`：本机环境变量。

“安装设置”中提供调试用的一键清除功能，会在二次确认后清除 Agent 记录和三个 Worker 的历史。职业画像、搜索设置和 AI Key 会保留。

## 测试

```powershell
npm test
```

详细功能范围和设计边界见 [PHASE1_SCOPE.md](./PHASE1_SCOPE.md)。

## 常见问题

### 页面打不开

确认运行 `npm start` 的终端仍然打开，并访问 `http://127.0.0.1:4317`。如果端口被占用，先关闭旧的 Node.js/Job Agent 服务再重试。

### 任务一直等待 Worker

确认 Tampermonkey 已启用对应平台的 Job Agent Worker，并刷新平台页面。也可以在“安装设置”重新安装最新版 Worker。

### 预检打开页面后没有继续

检查平台是否已登录、是否出现验证码，以及 Worker 是否启用。处理页面提示后，在每日任务中重新尝试预检。

### AI 不可用

先在“搜索设置”执行连接测试。AI 调用失败时系统会保留职位，并在可以回退的流程中使用本地规则，不会因为一次 AI 错误丢失职位。
