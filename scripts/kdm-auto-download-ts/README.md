# KDM 密钥查询与导出工具 TypeScript 版

这是 KDM 自动下载工具的 TypeScript/Node.js 版本：

- 自动登录并保存 `cookies.json`
- 使用 Cookie 查询账号、影片筛选项和密钥列表
- 支持按 PID、下载状态、影片类型、场次类型、关键词筛选
- 支持下载单个密钥包或批量下载
- 支持导出下载链接、Cookie 和 Header
- 支持 `--json` 输出
- 使用 `onnxruntime-node` 加载 `best.onnx` 识别网易易盾滑块缺口

## 安装

```powershell
cd C:\Users\11058\codexProjects\TMS\scripts\kdm-auto-download-ts
npm install
npx playwright install chromium
```

默认使用当前目录下的 `best.onnx`。

也可以指定模型：

```powershell
$env:KDM_YOLO_MODEL="C:\path\to\best.onnx"
```

## 使用

通过 `npm run` 传递 CLI 参数时，推荐在脚本分隔符后再加一个 `--`：

```powershell
npm run --silent kdm -- -- list --compact
```

这样可以避免 npm 吞掉 `--dir`、`--no-auth` 等长参数。

登录：

```powershell
npm run --silent kdm -- -- login "账号" "密码"
```

查看当前账号：

```powershell
npm run --silent kdm -- -- user
```

查询影片：

```powershell
npm run --silent kdm -- -- films
npm run --silent kdm -- -- films --keyword "影片名或PID"
```

查询密钥列表：

```powershell
npm run --silent kdm -- -- list --compact
npm run --silent kdm -- -- list --page 1 --pagesize 50 --downloaded 0 --compact
npm run --silent kdm -- -- list --pid HX202606043 --compact
```

搜索：

```powershell
npm run --silent kdm -- -- search "关键词" --limit 10
```

下载：

```powershell
npm run --silent kdm -- -- download 276320075
npm run --silent kdm -- -- download --all --downloaded 0 --limit 5
```

导出下载链接：

```powershell
npm run --silent kdm -- -- link 276320075
npm run --silent kdm -- -- link 276320075 --no-auth
```

JSON 输出：

```powershell
npm run --silent kdm:json -- list --compact
npm run --silent kdm:json -- download 276320075
```

如果直接调用 CLI，格式也和 Python 版一致：

```powershell
npx tsx src/cli.ts --json list --compact
```

## 调试

显示浏览器窗口：

```powershell
$env:KDM_HEADLESS="0"
npm run --silent kdm -- -- login "账号" "密码"
```

离线测试 YOLO：

```powershell
npm run test:model -- C:\path\to\captcha_bg.png
```

## 环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KDM_STATE_DIR` | 当前 TS 项目目录 | Cookie、passcode、下载文件、验证码样本保存目录 |
| `KDM_HEADLESS` | `1` | 设为 `0`、`false`、`no` 或 `off` 可显示浏览器 |
| `KDM_YOLO_MODEL` | `best.onnx` | YOLO ONNX 模型路径 |
| `KDM_YOLO_CONF` | `0.5` | YOLO 检测置信度阈值 |
| `KDM_YOLO_X_OFFSET` | `10` | 缺口检测结果 X 方向补偿 |
| `KDM_CHROME_VERSION` | 自动读取 | 用于拼接 API 请求 User-Agent |
| `KDM_USER_AGENT` | 自动生成 | 指定 API 请求 User-Agent |
| `KDM_CHROME_PATH` | Playwright Chromium | 指定浏览器可执行文件 |

## 注意

`cookies.json`、`passcode.json` 和下载的密钥包都属于敏感数据，不要提交或发送给他人。
