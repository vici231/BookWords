/* 打包脚本：把 frontend/js 的 22 个 ES module 合并为单个 IIFE bundle。
   背景：AI Works 预览网关对并发请求限流（429），module 图一次并发 20+ 请求
   必被掐断，导致整站 JS 失效。合并成 1 个请求 + 经典脚本加载（无 module
   CORS 语义）后，首屏 JS 只发 1 个请求，限流窗口内也能通过。
   用法：node build-bundle.mjs */

import * as esbuild from "esbuild";

/* main.js 里有两个带缓存查询串的 import（./views/home.js?v=13、
   ./views/wordbook.js?v=1），esbuild 不认 "?v=" 后缀，解析时剥掉即可 */
import path from "node:path";

const stripQuery = {
  name: "strip-query",
  setup(build) {
    build.onResolve({ filter: /\.js\?.*$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?.*$/, "")),
    }));
  },
};

const result = await esbuild.build({
  entryPoints: ["frontend/js/main.js"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "frontend/js/main.bundle.js",
  plugins: [stripQuery],
  minify: false,
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
});

if (result.errors.length) process.exit(1);
console.log("bundle OK -> frontend/js/main.bundle.js");
