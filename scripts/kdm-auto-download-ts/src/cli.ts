#!/usr/bin/env node
import { Command } from "commander";
import {
  clearCachedPasscode,
  clearCookies,
  compactItem,
  doBrowserLogin,
  downloadKdm,
  downloadMany,
  getCurrentUser,
  getDownloadLink,
  getHeadformOptions,
  getSession,
  listKdm,
  printJson,
  searchKdm
} from "./api.js";
import { COOKIE_FILE } from "./config.js";

function addCommonFilters(command: Command): Command {
  return command
    .option("--pid <pid>", "项目ID，如 HX202606043")
    .option("--downloaded <downloaded>", "0=未下载，1/2=已下载", parseNumber)
    .option("--category <category>", "1=中影影片，2=华夏影片", parseNumber)
    .option("--term <term>", "1=公映，2=活动，3=延期", parseNumber);
}

function parseNumber(value: string): number {
  return Number.parseInt(value, 10);
}

function argvValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function loginPositionalValue(position: 0 | 1): string | undefined {
  const commandIndex = process.argv.indexOf("login");
  if (commandIndex < 0) return undefined;
  const values = process.argv
    .slice(commandIndex + 1)
    .filter((item) => !item.startsWith("--"));
  return values[position];
}

function collectGlobals(command: Command): any {
  return command.optsWithGlobals();
}

async function withSession(command: Command): Promise<any> {
  const options = collectGlobals(command);
  return getSession({
    autoLogin: options.autoLogin,
    username: options.username,
    password: options.password,
    quiet: options.json
  });
}

function success(command: Command, result: any): void {
  const options = collectGlobals(command);
  if (options.json) printJson({ success: true, result });
  else printTable(command.name(), result);
}

function printTable(commandName: string, result: any): void {
  if (commandName === "user") {
    console.log(`${result.account} / ${result.name}`);
  } else if (commandName === "films") {
    console.log(`影片数: ${result.total}`);
    for (const item of result.data.slice(0, 100)) {
      console.log(`${item.value}\t${item.label}\t${item.last_publish_time || ""}`);
    }
  } else if (commandName === "list" || commandName === "search") {
    const rows = result.data || [];
    const pageinfo = result.pageinfo || {};
    if (Object.keys(pageinfo).length) console.log(`第 ${pageinfo.page || 1} 页 / 共 ${pageinfo.total || rows.length} 条`);
    else console.log(`共 ${result.total ?? rows.length} 条`);
    for (const item of rows) {
      const mainPid = item.main_pid || {};
      const movieName = item.movie_name || mainPid.movie_name || mainPid.name;
      const status = item.downloaded_label || (item.downloaded === 0 ? "未下载" : "已下载");
      console.log(
        `${item.id}\t${status}\t${movieName}\t${item.not_valid_before} ~ ${item.not_valid_after}\t${item.batch_name}`
      );
    }
  } else if (commandName === "download") {
    if (result.files) {
      console.log(`下载完成: ${result.total} 个文件`);
      for (const item of result.files) console.log(item.path);
    } else {
      console.log(result.path);
    }
  } else if (commandName === "link") {
    console.log(result.url);
    if (result.cookies) console.log(`Cookie: ${result.cookies}`);
  } else {
    printJson(result);
  }
}

const program = new Command();
program
  .name("kdm")
  .description("KDM密钥管理 TypeScript 工具")
  .option("--json", "以JSON输出，方便外部程序解析")
  .option("--auto-login", "Cookie缺失或失效时用传入账号密码自动登录")
  .option("--username <username>", "登录账号。login 或 --auto-login 时必填")
  .option("--password <password>", "登录密码。login 或 --auto-login 时必填");

const loginCommand = program
  .command("login")
  .description("执行登录并刷新cookies.json")
  .argument("[username]", "登录账号")
  .argument("[password]", "登录密码")
  .option("--username <username>", "登录账号")
  .option("--password <password>", "登录密码");
loginCommand.action(async () => {
    const options = loginCommand.opts();
    const globals = program.opts();
    clearCachedPasscode();
    const username = options.username || globals.username || argvValue("username") || loginPositionalValue(0);
    const password = options.password || globals.password || argvValue("password") || loginPositionalValue(1);
    const ok = await doBrowserLogin(username, password, globals.json, false);
    if (!ok) throw new Error("浏览器登录失败");
    success(loginCommand, { cookie_file: COOKIE_FILE });
    process.exit(0);
  });

const logoutCommand = program
  .command("logout")
  .description("清除本地cookies.json");
logoutCommand.action(() => {
    success(logoutCommand, {
      removed: clearCookies(),
      cookie_file: COOKIE_FILE,
      passcode_removed: clearCachedPasscode()
    });
  });

const userCommand = program
  .command("user")
  .description("获取当前登录账号");
userCommand.action(async () => {
    const { session, apiBase } = await withSession(userCommand);
    success(userCommand, await getCurrentUser(session, apiBase));
  });

const filmsCommand = program
  .command("films")
  .description("获取可筛选影片列表")
  .option("--keyword <keyword>", "按影片名或PID过滤");
filmsCommand.action(async () => {
    const options = filmsCommand.opts();
    const { session, apiBase } = await withSession(filmsCommand);
    const optionsMap = await getHeadformOptions(session, apiBase);
    let films = optionsMap.pid || [];
    if (options.keyword) {
      const key = String(options.keyword).toLowerCase();
      films = films.filter(
        (item: any) =>
          String(item.label || "").toLowerCase().includes(key) ||
          String(item.value || "").toLowerCase().includes(key)
      );
    }
    success(filmsCommand, { total: films.length, data: films });
  });

const listCommand = addCommonFilters(
  program
    .command("list")
    .description("获取密钥列表")
    .option("--page <page>", "页码", parseNumber, 1)
    .option("--pagesize <pagesize>", "每页数量", parseNumber, 20)
    .option("--compact", "输出精简字段")
);
listCommand.action(async () => {
  const options = listCommand.opts();
  const { session, apiBase } = await withSession(listCommand);
  const result = await listKdm(session, apiBase, options);
  success(
    listCommand,
    options.compact
      ? {
          pageinfo: result.pageinfo || {},
          headerinfo: result.headerinfo || {},
          data: (result.data || []).map(compactItem)
        }
      : result
  );
});

const searchCommand = addCommonFilters(
  program
    .command("search")
    .description("查询密钥")
    .argument("[keyword]", "关键词，匹配影片名、批次名、PID或ID")
    .option("--limit <limit>", "最多返回多少条", parseNumber)
    .option("--raw", "输出平台原始条目")
);
searchCommand.action(async (keyword) => {
  const options = searchCommand.opts();
  const { session, apiBase } = await withSession(searchCommand);
  let items = await searchKdm(session, apiBase, keyword, options);
  if (options.limit) items = items.slice(0, options.limit);
  success(searchCommand, { total: items.length, data: options.raw ? items : items.map(compactItem) });
});

const downloadCommand = addCommonFilters(
  program
    .command("download")
    .description("下载密钥")
    .argument("[pack_id]", "密钥ID；不传且加 --all 时批量下载")
    .option("--all", "批量下载匹配项，默认匹配未下载")
    .option("--dir <dir>", "保存目录")
    .option("--keyword <keyword>", "批量下载时按关键词过滤")
    .option("--limit <limit>", "批量下载最多下载多少个", parseNumber)
);
downloadCommand.action(async (packId) => {
  const options = downloadCommand.opts();
  const { session, apiBase } = await withSession(downloadCommand);
  if (options.all) {
    const files = await downloadMany(session, apiBase, {
      saveDir: options.dir,
      downloaded: options.downloaded ?? 0,
      pid: options.pid,
      category: options.category,
      term: options.term,
      keyword: options.keyword,
      limit: options.limit
    });
    success(downloadCommand, { total: files.length, files });
    return;
  }
  if (!packId) throw new Error("download 需要指定 pack_id，或使用 --all");
  success(downloadCommand, { id: packId, path: await downloadKdm(session, packId, apiBase, { saveDir: options.dir }) });
});

const linkCommand = program
  .command("link")
  .description("获取密钥下载链接")
  .argument("<pack_id>", "密钥ID")
  .option("--no-auth", "只输出URL和passcode，不输出Cookie/Header");
linkCommand.action(async (packId) => {
    const options = linkCommand.opts();
    const { session, apiBase } = await withSession(linkCommand);
    success(linkCommand, await getDownloadLink(session, packId, apiBase, { includeAuth: !options.noAuth }));
  });

program.parseAsync(process.argv).catch((error) => {
  const json = process.argv.includes("--json");
  if (json) printJson({ success: false, error: String(error.message || error) });
  else console.error(`[ERROR] ${error.message || error}`);
  process.exit(1);
});
