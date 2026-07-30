# TMS Docker 打包与运行

## 直接构建镜像

```powershell
docker build -t tms:latest .
```

如需在侧边栏显示 Docker 构建时间，可传入 `yyyyMMdd-NN` 格式的构建参数：

```powershell
$buildTime = "$(Get-Date -Format yyyyMMdd)-01"
docker build --build-arg BUILD_TIME=$buildTime --build-arg RELEASE_CHANNEL=docker -t tms:latest .
```

镜像会包含中影华夏 KDM 下载所需的 Python 运行时、Chromium、验证码识别模型和 Python 依赖，因此构建时间和镜像体积会比纯 Node 版本更大。

## 一键打包并导出镜像

```powershell
.\package-docker.bat
```

打包脚本会自动写入 Docker 构建时间，格式类似 `20260713-01`。末尾序号表示当天第几次成功打包，记录保存在 `.tms/docker-build-sequence.txt`；构建或导出失败不会增加序号。

构建时间、发布渠道和 Git 提交号只会写入镜像内的 `/app/build-info.json`。运行时不再读取或兼容构建版本环境变量。

默认会生成：

```text
tms-latest.tar
```

复制到其他主机后导入：

```powershell
docker load -i tms-latest.tar
```

## 使用外部 MySQL 运行

```powershell
docker run -d --name tms-web `
  -p 4174:4173 `
  -p 2121:2121 `
  -p 41000-41100:41000-41100 `
  -e PORT=4173 `
  -e FTP_PORT=2121 `
  -e FTP_PASV_MIN=41000 `
  -e FTP_PASV_MAX=41100 `
  -e FTP_PASV_HOST=你的宿主机局域网IP `
  -e KDM_STATE_DIR=/app/.tms/kdm-auto-download `
  -v tms-data:/app/.tms `
  -v ${PWD}/storage:/app/.tms/repository `
  tms:latest
```

打开 `http://localhost:4174` 完成初始化。数据库配置请填写容器能访问到的 MySQL 地址。

## 使用 docker compose 启动 TMS

```powershell
docker compose up -d --build
```

如需让 compose 构建也写入版本构建时间，请把它作为一次性的 Docker build arg 传入：

```powershell
$buildTime = "$(Get-Date -Format yyyyMMdd)-01"
docker compose build --build-arg BUILD_TIME=$buildTime --build-arg RELEASE_CHANNEL=docker
docker compose up -d --no-build
```

访问 `http://localhost:4174`，初始化时填写你已有的外部 MySQL 连接信息。请确保 TMS 容器可以访问该 MySQL 地址。

## FTP 端口说明

TMS 会启动一个只读匿名 FTP 服务，用于内容仓库访问：

- 控制端口：`2121`
- PASV 被动端口：`41000-41100`
- 本地配置持久化在 Docker volume：`tms-data:/app/.tms`
- 内容仓库映射到宿主机目录：`./storage:/app/.tms/repository`
- 中影华夏登录 Cookie、passcode、临时下载目录保存在：`/app/.tms/kdm-auto-download`

如果放映机或其他局域网设备需要访问容器里的 FTP，请把 `FTP_PASV_HOST` 设置成宿主机在局域网中的 IP，例如 `192.168.1.100`。

## 中影华夏 KDM 下载

Docker 镜像内置：

- Playwright Chromium 浏览器内核
- `scripts/kdm-auto-download-ts`
- `best.onnx` 验证码识别模型

默认环境变量：

```text
KDM_AUTO_DOWNLOAD_DIR=/app/scripts/kdm-auto-download-ts
KDM_YOLO_MODEL=/app/scripts/kdm-auto-download-ts/best.onnx
KDM_STATE_DIR=/app/.tms/kdm-auto-download
```

首次使用仍需在 `设置 > 其它设置` 中配置中影华夏账号密码。登录态会随 `tms-data` volume 持久化。

## 常用命令

```powershell
docker compose logs -f tms
docker compose restart tms
docker compose down
```

如需删除所有持久化数据：

```powershell
docker compose down -v
```
