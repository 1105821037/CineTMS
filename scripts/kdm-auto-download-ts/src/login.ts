import fs from "node:fs";
import path from "node:path";
import { chromium, Page, Browser, BrowserContext, Locator, Response } from "playwright";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import {
  CAPTCHA_SAMPLE_DIR,
  COOKIE_FILE,
  headlessEnabled,
  YOLO_CONF_THRESHOLD,
  YOLO_MODEL_FILE,
  YOLO_X_OFFSET
} from "./config.js";
import { LoginPageError, SavedCookie } from "./types.js";
import { sleep } from "./utils.js";

let yoloSession: ort.InferenceSession | null = null;

type LoginSignal = {
  success: boolean;
  error?: string;
  needs?: string;
  module?: string;
};

export class LoginNetworkMonitor {
  signal: LoginSignal = { success: false };
  private handler: (response: Response) => Promise<void>;

  constructor(private page: Page) {
    this.handler = async (response) => {
      await this.handleResponse(response);
    };
    this.page.on("response", this.handler);
  }

  dispose(): void {
    this.page.off("response", this.handler);
  }

  private async handleResponse(response: Response): Promise<void> {
    const url = response.url();
    if (!url.includes("/grant/commit") && !url.includes("/grant/go") && !url.includes("/session/get_session_info")) {
      return;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      return;
    }

    if (url.includes("/session/get_session_info")) {
      if (data?.status === 200 && data.result?.account) {
        this.signal = { success: true, module: "session" };
      }
      return;
    }

    if (url.includes("/grant/commit")) {
      if (process.env.KDM_DEBUG_NETWORK === "1") {
        console.error(`[grant/commit] ${JSON.stringify(data).slice(0, 1000)}`);
      }
      const postData = response.request().postData() || "";
      const isCredentialCommit = postData.includes('"account"') || postData.includes('"password"');
      if (isCredentialCommit && data?.status === 200 && data.result !== "ok") {
        this.signal = { success: false, error: normalizeGrantError(data) };
      }
      return;
    }

    if (url.includes("/grant/go")) {
      if (process.env.KDM_DEBUG_NETWORK === "1") {
        console.error(`[grant/go] ${JSON.stringify(data).slice(0, 1000)}`);
      }
      const moduleName = data?.result?.module;
      if (moduleName && !this.signal.success && !this.signal.error && !this.signal.needs) {
        this.signal = { ...this.signal, module: moduleName };
      }
      if (data?.result === "DONE" || moduleName === "finish" || moduleName === "$homepage") {
        this.signal = { success: true, module: moduleName || "DONE" };
      } else if (moduleName === "totp" || moduleName === "sms") {
        this.signal = { success: false, needs: moduleName };
      } else if (moduleName === "$error") {
        this.signal = { success: false, error: normalizeGrantError(data) };
      }
    }
  }
}

function normalizeGrantError(data: any): string {
  return (
    data?.error ||
    data?.msg ||
    data?.message ||
    data?.result?.message ||
    data?.result?.msg ||
    (typeof data?.result === "string" ? data.result : "") ||
    JSON.stringify(data)
  );
}

export class KdmBrowser {
  constructor(
    public playwright: unknown,
    public browser: Browser,
    public context: BrowserContext,
    public page: Page
  ) {}

  get url(): string {
    return this.page.url();
  }

  async quit(): Promise<void> {
    await this.browser.close();
  }
}

export function saveCookies(page: Page): Promise<void> {
  return page.context().cookies().then((cookies) => {
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf8");
    console.log(`    Cookies已保存 (${cookies.length}条)`);
  });
}

export async function waitForCookieStability(
  page: Page,
  timeoutMs = 5000,
  stableMs = 800
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSignature = "";
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const cookies = await page.context().cookies();
    const signature = cookies
      .map((cookie) => `${cookie.domain}|${cookie.path}|${cookie.name}|${cookie.value}`)
      .sort()
      .join("\n");

    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }

    await sleep(200);
  }
}

export async function saveCookiesAfterLogin(page: Page): Promise<void> {
  await waitForCookieStability(page);
  await saveCookies(page);
}

export function loadCookies(): SavedCookie[] | null {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    return cookies?.length ? cookies : null;
  } catch {
    return null;
  }
}

export async function checkCookiesValid(page: Page): Promise<boolean> {
  const cookies = loadCookies();
  if (!cookies) return false;

  console.log("  尝试使用已保存的Cookies...");
  await page.goto("https://www.zyhxjh.com/console/fe_login/#/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await sleep(2000);

  await page.context().addCookies(
    cookies
      .filter((cookie) => cookie.name && cookie.value !== undefined)
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || ".zyhxjh.com",
        path: cookie.path || "/",
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite
      }))
  );

  await page.goto("https://www.zyhxjh.com/console/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await sleep(3000);
  if (!page.url().includes("fe_login")) {
    console.log("  Cookies有效，跳过登录");
    return true;
  }
  console.log("  Cookies已过期，需要重新登录");
  return false;
}

export function getBrowserDependencyHint(error: unknown): string {
  const message = String(error);
  if (message.includes("Executable doesn't exist") && message.includes("playwright install")) {
    return "Playwright 浏览器内核未安装。请执行:\nnpx playwright install chromium";
  }
  if (message.includes("error while loading shared libraries")) {
    const marker = "error while loading shared libraries:";
    const missingLib = message.includes(marker) ? message.split(marker, 2)[1].split(":", 1)[0].trim() : "未知";
    return (
      `Chromium 缺少系统运行库: ${missingLib}\n` +
      "优先执行: npx playwright install-deps chromium\n" +
      "如果系统不支持 install-deps，请用系统包管理器安装 Chromium 依赖。"
    );
  }
  return "";
}

export async function createBrowser(): Promise<KdmBrowser> {
  const browserPath = process.env.KDM_CHROME_PATH?.trim();
  const launchOptions: any = {
    headless: headlessEnabled(),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-first-run",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  };
  if (browserPath && fs.existsSync(browserPath)) launchOptions.executablePath = browserPath;
  else if (browserPath) console.log(`    忽略不存在的浏览器路径: ${browserPath}`);

  let browser: Browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    const hint = getBrowserDependencyHint(error);
    if (hint) throw new Error(hint);
    throw error;
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  `);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return new KdmBrowser(null, browser, context, page);
}

export async function clickLoginButton(page: Page): Promise<void> {
  await page.locator(".submit-btn").click({ timeout: 3000 });
}

const LOGIN_ERROR_SELECTORS = [
  ".ant-message-notice-content",
  ".ant-notification-notice-message",
  ".ant-notification-notice-description",
  ".ant-form-item-explain-error",
  ".ant-alert-message",
  ".ant-alert-description",
  ".error",
  ".error-message"
];

const LOGIN_ERROR_KEYWORDS = [
  "账号或密码",
  "用户名或密码",
  "账号密码",
  "密码错误",
  "账号错误",
  "用户名错误",
  "账户不存在",
  "账号不存在",
  "用户不存在",
  "账户被禁用",
  "账号被禁用",
  "账户已停用",
  "账号已停用",
  "登录失败"
];

export function normalizePageMessage(text: unknown): string {
  return String(text || "").split(/\s+/).filter(Boolean).join(" ");
}

export function looksLikeLoginError(text: unknown): boolean {
  const message = normalizePageMessage(text);
  if (!message) return false;
  if (LOGIN_ERROR_KEYWORDS.some((keyword) => message.includes(keyword))) return true;
  return (
    (message.includes("密码") || message.includes("账号") || message.includes("用户名")) &&
    (message.includes("错误") ||
      message.includes("不正确") ||
      message.includes("不存在") ||
      message.includes("失败"))
  );
}

export async function readLoginErrorMessage(page: Page, timeoutSeconds = 0.5): Promise<string | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    for (const selector of LOGIN_ERROR_SELECTORS) {
      try {
        const locator = page.locator(selector);
        const count = Math.min(await locator.count(), 5);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          if (!(await item.isVisible({ timeout: 100 }).catch(() => false))) continue;
          const message = normalizePageMessage(await item.innerText({ timeout: 300 }));
          if (looksLikeLoginError(message)) return message;
        }
      } catch {}
    }
    try {
      const bodyText = await page.locator("body").innerText({ timeout: 500 });
      for (const line of bodyText.split(/\r?\n/)) {
        const message = normalizePageMessage(line);
        if (looksLikeLoginError(message)) return message;
      }
    } catch {}
    await sleep(100);
  }
  return null;
}

export async function waitAfterLoginClick(
  page: Page,
  previousBgSrc?: string | null,
  timeoutSeconds = 8,
  monitor?: LoginNetworkMonitor
): Promise<"success" | "captcha" | "error" | "timeout"> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (monitor?.signal.success) return "success";
    if (monitor?.signal.error || monitor?.signal.needs) return "error";
    if (await readLoginErrorMessage(page, 0.05)) return "error";

    try {
      const bg = page.locator(".yidun_bg-img").first();
      if (await bg.isVisible({ timeout: 100 }).catch(() => false)) {
        const src = await bg.getAttribute("src", { timeout: 100 }).catch(() => null);
        if (!previousBgSrc || !src || src !== previousBgSrc) return "captcha";
      }
    } catch {}

    await sleep(100);
  }
  return "timeout";
}

export async function waitForGrantReady(
  monitor: LoginNetworkMonitor,
  timeoutMs = 6000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (monitor.signal.module || monitor.signal.success || monitor.signal.error || monitor.signal.needs) return;
    await sleep(100);
  }
}

export async function loadYoloSession(): Promise<ort.InferenceSession> {
  if (yoloSession) return yoloSession;
  if (!fs.existsSync(YOLO_MODEL_FILE)) throw new Error(`YOLO模型不存在: ${YOLO_MODEL_FILE}`);
  yoloSession = await ort.InferenceSession.create(YOLO_MODEL_FILE, {
    executionProviders: ["cpu"]
  });
  return yoloSession;
}

export async function prepareYoloInput(imgBuffer: Buffer, inputShape: readonly any[]): Promise<{
  tensor: ort.Tensor;
  srcWidth: number;
  srcHeight: number;
  scale: number;
  padX: number;
  padY: number;
}> {
  if (inputShape.length !== 4) throw new Error(`不支持的YOLO输入形状: ${inputShape}`);
  const channels = Number(inputShape[1]);
  const height = Number(inputShape[2]);
  const width = Number(inputShape[3]);
  if (channels !== 3 || !height || !width) throw new Error(`不支持的YOLO输入形状: ${inputShape}`);

  const image = sharp(imgBuffer);
  const metadata = await image.metadata();
  const srcWidth = Number(metadata.width);
  const srcHeight = Number(metadata.height);
  const scale = Math.min(width / srcWidth, height / srcHeight);
  const resizedWidth = Math.round(srcWidth * scale);
  const resizedHeight = Math.round(srcHeight * scale);
  const padX = (width - resizedWidth) / 2;
  const padY = (height - resizedHeight) / 2;

  const raw = await sharp(imgBuffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114 },
      kernel: "linear" as any
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const data = new Float32Array(1 * channels * height * width);
  const area = height * width;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcIndex = (y * width + x) * 3;
      const dstIndex = y * width + x;
      data[dstIndex] = raw[srcIndex] / 255;
      data[area + dstIndex] = raw[srcIndex + 1] / 255;
      data[area * 2 + dstIndex] = raw[srcIndex + 2] / 255;
    }
  }
  return {
    tensor: new ort.Tensor("float32", data, [1, channels, height, width]),
    srcWidth,
    srcHeight,
    scale,
    padX,
    padY
  };
}

export function yoloOutputToBoxes(
  output: ort.Tensor,
  srcSize: { width: number; height: number },
  scale: number,
  padX: number,
  padY: number
): Array<{ conf: number; xyxy: number[] }> {
  const dims = output.dims;
  const raw = output.data as Float32Array;
  let rows: number;
  let cols: number;
  if (dims.length === 3) {
    rows = dims[1];
    cols = dims[2];
  } else if (dims.length === 2) {
    rows = dims[0];
    cols = dims[1];
  } else {
    throw new Error(`不支持的YOLO输出维度: ${dims}`);
  }

  const transposed = rows < cols;
  if (transposed) [rows, cols] = [cols, rows];
  if (cols < 5) throw new Error(`不支持的YOLO输出形状: ${dims}`);

  const valueAt = (row: number, col: number): number => {
    if (!transposed) return Number(raw[row * cols + col]);
    const originalRows = dims.length === 3 ? dims[1] : dims[0];
    const originalCols = dims.length === 3 ? dims[2] : dims[1];
    return Number(raw[col * originalCols + row]);
  };

  const boxes = [];
  for (let row = 0; row < rows; row += 1) {
    const cx = valueAt(row, 0);
    const cy = valueAt(row, 1);
    const w = valueAt(row, 2);
    const h = valueAt(row, 3);
    let conf = -Infinity;
    for (let col = 4; col < cols; col += 1) conf = Math.max(conf, valueAt(row, col));
    if (conf < YOLO_CONF_THRESHOLD) continue;

    const x1 = (cx - w / 2 - padX) / scale;
    const y1 = (cy - h / 2 - padY) / scale;
    const x2 = (cx + w / 2 - padX) / scale;
    const y2 = (cy + h / 2 - padY) / scale;
    boxes.push({
      conf,
      xyxy: [
        Math.max(0, Math.min(srcSize.width, x1)),
        Math.max(0, Math.min(srcSize.height, y1)),
        Math.max(0, Math.min(srcSize.width, x2)),
        Math.max(0, Math.min(srcSize.height, y2))
      ]
    });
  }
  return boxes;
}

export async function findGapXYolo(bgBytes: Buffer, attempt = 0): Promise<[number, Record<string, any>]> {
  const session = await loadYoloSession();
  const input = session.inputNames[0];
  const metadata: any = session.inputMetadata as any;
  const inputMeta = Array.isArray(metadata)
    ? metadata.find((item) => item.name === input) || metadata[0]
    : metadata[input];
  const inputShape = inputMeta.dimensions || inputMeta.shape;
  const prepared = await prepareYoloInput(bgBytes, inputShape);
  const feeds: Record<string, ort.Tensor> = { [input]: prepared.tensor };
  const outputs = await session.run(feeds);
  const firstOutput = outputs[session.outputNames[0]];
  const boxes = yoloOutputToBoxes(
    firstOutput,
    { width: prepared.srcWidth, height: prepared.srcHeight },
    prepared.scale,
    prepared.padX,
    prepared.padY
  );
  if (!boxes.length) throw new Error("YOLO未检测到缺口");

  const bestBox = boxes.reduce((best, box) => (box.conf > best.conf ? box : best), boxes[0]);
  const [x1, y1, x2, y2] = bestBox.xyxy;
  const gapX = Math.round(x1) + YOLO_X_OFFSET;
  const details = {
    method: "yolo",
    conf: bestBox.conf,
    box: bestBox.xyxy.map((value) => Number(value.toFixed(2))),
    gap_x_mode: "box_x1",
    x_offset: YOLO_X_OFFSET
  };
  console.log(
    `    [yolo] conf=${bestBox.conf.toFixed(4)}, box=(${x1.toFixed(1)},${y1.toFixed(1)},${x2.toFixed(1)},${y2.toFixed(1)}), x=${gapX}`
  );

  try {
    const svg = Buffer.from(
      `<svg width="${prepared.srcWidth}" height="${prepared.srcHeight}">
        <rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="#00ff00" stroke-width="2"/>
        <line x1="${gapX}" y1="0" x2="${gapX}" y2="${prepared.srcHeight}" stroke="#ff0000" stroke-width="2"/>
      </svg>`
    );
    await sharp(bgBytes).composite([{ input: svg }]).png().toFile(path.join(process.cwd(), `debug_yolo_${attempt}.png`));
  } catch {}

  return [gapX, details];
}

export function bezierCurve(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  numPoints: number
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= numPoints; i += 1) {
    const t = i / numPoints;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    points.push([
      mt3 * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t3 * p3[0],
      mt3 * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t3 * p3[1]
    ]);
  }
  return points;
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randint(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

export function generateTrack(distance: number): Array<[number, number, number]> {
  const overshoot = randint(3, 6);
  const total = distance + overshoot;
  const points = bezierCurve(
    [0, 0],
    [total * rand(0.3, 0.4), rand(-3, 3)],
    [total * rand(0.6, 0.8), rand(-2, 2)],
    [total, rand(-1, 1)],
    randint(26, 34)
  );

  const track: Array<[number, number, number]> = [];
  for (let i = 1; i < points.length; i += 1) {
    const progress = i / points.length;
    const dt = progress < 0.2 ? rand(25, 40) : progress > 0.8 ? rand(40, 65) : rand(20, 35);
    track.push([points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], dt]);
  }
  track.push([0, 0, rand(40, 80)]);
  const correctionSteps = randint(3, 5);
  for (let i = 0; i < correctionSteps; i += 1) {
    track.push([-overshoot / correctionSteps, rand(-0.5, 0.5), rand(20, 35)]);
  }
  return track;
}

export async function humanDrag(page: Page, slider: Locator, distance: number): Promise<void> {
  const started = performance.now();
  const box = await slider.boundingBox();
  if (!box) throw new Error("滑块元素不可见或无位置");
  let currentX = box.x + box.width / 2;
  let currentY = box.y + box.height / 2;
  await page.mouse.move(currentX, currentY, { steps: randint(8, 12) });
  await sleep(rand(40, 80));
  await page.mouse.down();
  await sleep(rand(10, 25));

  const track = generateTrack(distance);
  let plannedSleep = 0;
  for (const [dx, dy, dt] of track) {
    currentX += dx;
    currentY += dy;
    plannedSleep += dt;
    await page.mouse.move(currentX, currentY, { steps: randint(2, 4) });
    await sleep(dt);
  }
  await sleep(rand(10, 25));
  await page.mouse.up();
  console.log(
    `    拖动完成: ${distance}px (贝塞尔 ${track.length}点, sleep=${(plannedSleep / 1000).toFixed(2)}s, 实耗=${((performance.now() - started) / 1000).toFixed(2)}s)`
  );
}

export async function checkResult(page: Page, oldBgSrc: string, timeoutSeconds = 4): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const bg = page.locator(".yidun_bg-img");
      if ((await bg.count()) === 0 || !(await bg.first().isVisible({ timeout: 300 }).catch(() => false))) {
        const mask = page.locator(".yidun_popup__mask");
        if ((await mask.count()) > 0 && (await mask.first().isVisible({ timeout: 300 }).catch(() => false))) {
          await sleep(300);
          continue;
        }
        return "captcha_passed";
      }
      const newSrc = await bg.first().getAttribute("src", { timeout: 300 });
      if (newSrc && newSrc !== oldBgSrc) return "refreshed";
    } catch {
      return "captcha_passed";
    }
    await sleep(300);
  }
  return "timeout";
}

export async function waitLoginCompleted(
  page: Page,
  timeoutSeconds = 12,
  monitor?: LoginNetworkMonitor
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (monitor?.signal.success) return true;
    await sleep(200);
  }
  return false;
}

export async function saveCaptchaSample(
  bgBytes: Buffer,
  jigsawBytes: Buffer,
  attempt: number,
  data: { bgSrc?: string; jigsawSrc?: string; result?: any; error?: string } = {}
): Promise<{ bgPath: string; fgPath: string; metaPath: string; prefix: string }> {
  fs.mkdirSync(CAPTCHA_SAMPLE_DIR, { recursive: true });
  const now = new Date();
  const timestamp =
    now
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14) + `_${String(now.getMilliseconds()).padStart(3, "0")}`;
  const prefix = `${timestamp}_attempt${String(attempt).padStart(2, "0")}`;
  const bgPath = path.join(CAPTCHA_SAMPLE_DIR, `${prefix}_bg.png`);
  const fgPath = path.join(CAPTCHA_SAMPLE_DIR, `${prefix}_fg.png`);
  const metaPath = path.join(CAPTCHA_SAMPLE_DIR, `${prefix}_meta.json`);
  fs.writeFileSync(bgPath, bgBytes);
  fs.writeFileSync(fgPath, jigsawBytes);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        timestamp,
        attempt,
        bg_file: path.basename(bgPath),
        fg_file: path.basename(fgPath),
        bg_src: data.bgSrc || "",
        jigsaw_src: data.jigsawSrc || "",
        result: data.result || null,
        error: data.error || null
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`    验证码样本已保存: ${prefix}`);
  return { bgPath, fgPath, metaPath, prefix };
}

export function updateCaptchaSampleMeta(metaPath: string, patch: Record<string, any>): void {
  try {
    const existing = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          ...existing,
          ...patch,
          updated_at: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.log(`    更新验证码样本元数据失败: ${error}`);
  }
}

export async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载验证码图片失败: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function waitForCaptchaSources(
  page: Page,
  timeoutMs = 15000
): Promise<{ bgSrc: string; jigsawSrc: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const bgEle = page.locator(".yidun_bg-img").first();
      const jigsawEle = page.locator(".yidun_jigsaw").first();
      const bgVisible = await bgEle.isVisible({ timeout: 200 }).catch(() => false);
      const jigsawVisible = await jigsawEle.isVisible({ timeout: 200 }).catch(() => false);
      if (bgVisible && jigsawVisible) {
        const bgSrc = await bgEle.getAttribute("src", { timeout: 300 });
        const jigsawSrc = await jigsawEle.getAttribute("src", { timeout: 300 });
        if (bgSrc && jigsawSrc) return { bgSrc, jigsawSrc };
      }
    } catch {}
    await sleep(250);
  }
  return null;
}

export async function login(options: {
  username: string;
  password: string;
  maxAttempts?: number;
  useSavedCookies?: boolean;
  quiet?: boolean;
}): Promise<KdmBrowser | null> {
  const { username, password } = options;
  const maxAttempts = options.maxAttempts || 3;
  if (!username || !password) throw new Error("登录需要传入 username 和 password");

  if (!options.quiet) {
    console.log("=".repeat(50));
    console.log("KDM密钥自动下载 - 登录模块 (YOLO/TS)");
    console.log("=".repeat(50));
  }

  const browser = await createBrowser();
  const page = browser.page;
  const networkMonitor = new LoginNetworkMonitor(page);
  try {
    const yoloWarmup = loadYoloSession().catch((error) => error);
    if (options.useSavedCookies ?? true) {
      console.log("\n[0] 检查已保存的Cookies...");
      if (await checkCookiesValid(page)) return browser;
    } else {
      console.log("\n[0] 忽略本地Cookies，使用账号密码重新登录...");
    }

    console.log("\n[1] 打开登录页...");
    await page.goto("https://www.zyhxjh.com/console/fe_login/#/", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    console.log("[2] 填写账号密码...");
    const usernameInput = page.locator("#basic_account");
    const passwordInput = page.locator("#basic_password");
    await usernameInput.waitFor({ state: "visible", timeout: 15000 });
    await passwordInput.waitFor({ state: "visible", timeout: 15000 });
    await usernameInput.fill("");
    await usernameInput.fill(username);
    await sleep(rand(300, 500));
    await passwordInput.fill("");
    await passwordInput.fill(password);
    console.log(`    账号: ${username}`);
    await waitForGrantReady(networkMonitor);

    console.log("[3] 点击登录...");
    await clickLoginButton(page);
    console.log("    已点击");

    console.log("[4] 处理滑块验证码...");
    const initialState = await waitAfterLoginClick(page, null, 8, networkMonitor);
    console.log(`    当前URL: ${page.url()}`);
    if (initialState === "success") {
      console.log("    直接登录成功，无需验证码！");
      await saveCookiesAfterLogin(page);
      return browser;
    }

    const firstError = await readLoginErrorMessage(page, 1);
    if (firstError) throw new LoginPageError(firstError);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      console.log(`\n    --- 尝试 ${attempt}/${maxAttempts} ---`);
      if (await waitLoginCompleted(page, 0.1, networkMonitor)) {
        console.log("\n[5] 登录成功!");
        await saveCookiesAfterLogin(page);
        return browser;
      }
      if (networkMonitor.signal.error) throw new LoginPageError(networkMonitor.signal.error);
      if (networkMonitor.signal.needs) throw new LoginPageError(`登录需要额外验证: ${networkMonitor.signal.needs}`);
      const loginError = await readLoginErrorMessage(page, 0.5);
      if (loginError) throw new LoginPageError(loginError);

      let bgSrc: string | null = null;
      let jigsawSrc: string | null = null;
      try {
        const captchaSources = await waitForCaptchaSources(
          page,
          networkMonitor.signal.module === "captcha" ? 18000 : 8000
        );
        if (!captchaSources) {
          console.log("    未找到背景图元素");
          const state = await waitAfterLoginClick(page, null, 2, networkMonitor);
          if (state === "success" || await waitLoginCompleted(page, 0.1, networkMonitor)) {
            console.log("\n[5] 登录成功!");
            await saveCookiesAfterLogin(page);
            return browser;
          }
          if (networkMonitor.signal.error) throw new LoginPageError(networkMonitor.signal.error);
          if (networkMonitor.signal.needs) throw new LoginPageError(`登录需要额外验证: ${networkMonitor.signal.needs}`);
          const error = await readLoginErrorMessage(page, 0.5);
          if (error) throw new LoginPageError(error);
          if (networkMonitor.signal.module === "captcha") {
            console.log("    验证码模块已触发，但图片尚未渲染，继续等待...");
            continue;
          }
          if (state === "timeout" && page.url().includes("fe_login")) {
            try {
              await clickLoginButton(page);
              console.log("    已重新点击登录按钮");
              const retryState = await waitAfterLoginClick(page, null, 4, networkMonitor);
              if (retryState === "error") {
                if (networkMonitor.signal.error) throw new LoginPageError(networkMonitor.signal.error);
                if (networkMonitor.signal.needs) throw new LoginPageError(`登录需要额外验证: ${networkMonitor.signal.needs}`);
                const retryError = await readLoginErrorMessage(page, 0.5);
                if (retryError) throw new LoginPageError(retryError);
              }
              if (retryState === "success" || await waitLoginCompleted(page, 0.1, networkMonitor)) {
                console.log("\n[5] 登录成功!");
                await saveCookiesAfterLogin(page);
                return browser;
              }
            } catch (error) {
              if (error instanceof LoginPageError) throw error;
              console.log(`    重新点击登录失败: ${error}`);
            }
          }
          continue;
        }

        bgSrc = captchaSources.bgSrc;
        jigsawSrc = captchaSources.jigsawSrc;
      } catch (error) {
        if (error instanceof LoginPageError) throw error;
        console.log(`    获取验证码失败: ${error}`);
        continue;
      }

      const [bgBytes, jigsawBytes] = await Promise.all([fetchBuffer(bgSrc), fetchBuffer(jigsawSrc)]);
      let sampleResult: any = null;
      let sampleMetaPath: string | null = null;
      let gapX: number;
      try {
        const warmupResult = await yoloWarmup;
        if (warmupResult instanceof Error) throw warmupResult;
        const [detectedGapX, detectInfo] = await findGapXYolo(bgBytes, attempt);
        gapX = detectedGapX;
        sampleResult = { gap_x: gapX, ...detectInfo };
      } catch (error) {
        console.log(`    识别失败: ${error}`);
        const sample = await saveCaptchaSample(bgBytes, jigsawBytes, attempt, {
          bgSrc,
          jigsawSrc,
          error: String(error)
        });
        sampleMetaPath = sample.metaPath;
        const refresh = page.locator(".yidun_refresh");
        if ((await refresh.count()) > 0 && (await refresh.first().isVisible({ timeout: 2000 }).catch(() => false))) {
          await refresh.first().click();
          await waitAfterLoginClick(page, bgSrc, 4, networkMonitor);
        }
        continue;
      }

      if (gapX < 10) {
        console.log(`    识别结果异常: ${gapX}`);
        const sample = await saveCaptchaSample(bgBytes, jigsawBytes, attempt, {
          bgSrc,
          jigsawSrc,
          result: sampleResult,
          error: `abnormal gap_x: ${gapX}`
        });
        sampleMetaPath = sample.metaPath;
        continue;
      }

      const metadata = await sharp(bgBytes).metadata();
      const bgBox = await page.locator(".yidun_bg-img").first().boundingBox();
      if (!bgBox || !metadata.width) {
        console.log("    背景图位置不可用，重试...");
        continue;
      }
      const scale = bgBox.width / metadata.width;
      const distance = Math.round(gapX * scale) + randint(-2, 2);
      console.log(`    缺口=${gapX}px, 缩放=${scale.toFixed(2)}, 拖动=${distance}px`);
      sampleResult = {
        ...sampleResult,
        image_width: metadata.width,
        display_width: bgBox.width,
        scale,
        drag_distance: distance
      };
      const sample = await saveCaptchaSample(bgBytes, jigsawBytes, attempt, {
        bgSrc,
        jigsawSrc,
        result: sampleResult
      });
      sampleMetaPath = sample.metaPath;

      let slider = page.locator(".yidun_slider__icon");
      if ((await slider.count()) === 0) slider = page.locator(".yidun_slider");
      await slider.first().waitFor({ state: "visible", timeout: 3000 });
      await humanDrag(page, slider.first(), distance);

      const result = await checkResult(page, bgSrc, 3);
      console.log(`    结果: ${result}`);
      if (sampleMetaPath) {
        updateCaptchaSampleMeta(sampleMetaPath, {
          outcome: {
            captcha_result: result,
            captcha_passed: result === "captcha_passed" || result === "success",
            login_success: networkMonitor.signal.success,
            login_module: networkMonitor.signal.module || null,
            login_error: networkMonitor.signal.error || null,
            login_needs: networkMonitor.signal.needs || null,
            checked_at: new Date().toISOString()
          }
        });
      }
      if (result === "success" || result === "captcha_passed") {
        if (result === "captcha_passed" && !(await waitLoginCompleted(page, 5, networkMonitor))) {
          if (sampleMetaPath) {
            updateCaptchaSampleMeta(sampleMetaPath, {
              outcome: {
                captcha_result: result,
                captcha_passed: true,
                login_success: networkMonitor.signal.success,
                login_module: networkMonitor.signal.module || null,
                login_error: networkMonitor.signal.error || null,
                login_needs: networkMonitor.signal.needs || null,
                final_status: "captcha_passed_but_login_not_complete",
                checked_at: new Date().toISOString()
              }
            });
          }
          if (networkMonitor.signal.error) throw new LoginPageError(networkMonitor.signal.error);
          if (networkMonitor.signal.needs) throw new LoginPageError(`登录需要额外验证: ${networkMonitor.signal.needs}`);
          const error = await readLoginErrorMessage(page, 1);
          if (error) throw new LoginPageError(error);
          console.log("    验证码已通过，但页面仍停留在登录页，继续重试...");
          try {
            await clickLoginButton(page);
            console.log("    已重新点击登录按钮");
            if (await waitLoginCompleted(page, 8, networkMonitor)) {
              if (sampleMetaPath) {
                updateCaptchaSampleMeta(sampleMetaPath, {
                  outcome: {
                    captcha_result: result,
                    captcha_passed: true,
                    login_success: true,
                    login_module: networkMonitor.signal.module || null,
                    final_status: "login_success_after_retry_click",
                    checked_at: new Date().toISOString()
                  }
                });
              }
              console.log("\n[5] 登录成功!");
              await saveCookiesAfterLogin(page);
              return browser;
            }
          } catch (error) {
            if (error instanceof LoginPageError) throw error;
            console.log(`    重新点击登录失败: ${error}`);
          }
          continue;
        }
        if (sampleMetaPath) {
          updateCaptchaSampleMeta(sampleMetaPath, {
            outcome: {
              captcha_result: result,
              captcha_passed: true,
              login_success: networkMonitor.signal.success,
              login_module: networkMonitor.signal.module || null,
              final_status: networkMonitor.signal.success ? "login_success" : "captcha_passed",
              checked_at: new Date().toISOString()
            }
          });
        }
        console.log("\n[5] 登录成功!");
        await saveCookiesAfterLogin(page);
        return browser;
      }
      if (result === "refreshed") {
        if (sampleMetaPath) {
          updateCaptchaSampleMeta(sampleMetaPath, {
            outcome: {
              captcha_result: result,
              captcha_passed: false,
              login_success: false,
              login_module: networkMonitor.signal.module || null,
              final_status: "captcha_failed_refreshed",
              checked_at: new Date().toISOString()
            }
          });
        }
        console.log("    验证失败，重试...");
        await sleep(rand(300, 700));
      } else {
        if (sampleMetaPath) {
          updateCaptchaSampleMeta(sampleMetaPath, {
            outcome: {
              captcha_result: result,
              captcha_passed: false,
              login_success: false,
              login_module: networkMonitor.signal.module || null,
              final_status: "captcha_timeout",
              checked_at: new Date().toISOString()
            }
          });
        }
        console.log("    超时，刷新验证码...");
        const refresh = page.locator(".yidun_refresh");
        if ((await refresh.count()) > 0 && (await refresh.first().isVisible({ timeout: 2000 }).catch(() => false))) {
          await refresh.first().click();
          await waitAfterLoginClick(page, bgSrc, 4, networkMonitor);
        }
      }
    }

    console.log(`\n[5] ${maxAttempts}次尝试均失败`);
    await browser.quit();
    return null;
  } catch (error) {
    await browser.quit().catch(() => {});
    throw error;
  } finally {
    networkMonitor.dispose();
  }
}
