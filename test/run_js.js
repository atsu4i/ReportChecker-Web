// JS版 checker を samples/*.docx に通し、findings を JSON で出力する。
// 使い方: node run_js.js <docx1> <docx2> ...
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

// checker.js が参照するグローバルを用意
global.JSZip = JSZip;
global.DOMParser = DOMParser;

const Checker = require("../js/checker.js");

async function main() {
  const files = process.argv.slice(2);
  const out = {};
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const res = await Checker.check(ab);
    out[path.basename(f)] = {
      error: res.error,
      templateOk: res.templateOk,
      diagnosis: res.case ? res.case.diagnosis : null,
      findings: res.findings.map((x) => ({
        category: x.category, severity: x.severity, message: x.message, match_text: x.match_text,
      })),
    };
  }
  process.stdout.write(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
