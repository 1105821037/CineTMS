import fs from "node:fs";
import { findGapXYolo } from "./login.js";

const imagePath = process.argv[2] || "test_captcha_0.png";
if (!fs.existsSync(imagePath)) {
  throw new Error(`测试图片不存在: ${imagePath}`);
}

const [gapX, details] = await findGapXYolo(fs.readFileSync(imagePath), 1);
console.log(`缺口x=${gapX}`);
console.log(details);
