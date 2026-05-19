#!/usr/bin/env node
// Obfuscate compiled dist/ files before packaging into Docker image.
// Light settings: renames identifiers + encrypts strings, skips control flow
// flattening (too slow for a backend) and self-defending (breaks in Docker).
import { readdir, readFile, writeFile } from "fs/promises";
import { join, extname } from "path";
import JavaScriptObfuscator from "javascript-obfuscator";

const DIST = new URL("../dist", import.meta.url).pathname;

const OPTIONS = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["rc4"],
  stringArrayThreshold: 0.75,
  rotateStringArray: true,
  shuffleStringArray: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  sourceMap: false,
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (e.isFile() && extname(e.name) === ".js") files.push(full);
  }
  return files;
}

async function main() {
  const files = await walk(DIST);
  console.log(`[obfuscate] Processing ${files.length} files in dist/`);

  let done = 0;
  await Promise.all(
    files.map(async (file) => {
      const src = await readFile(file, "utf8");
      const result = JavaScriptObfuscator.obfuscate(src, OPTIONS);
      await writeFile(file, result.getObfuscatedCode(), "utf8");
      done++;
      if (done % 10 === 0) process.stdout.write(`\r[obfuscate] ${done}/${files.length}`);
    })
  );

  console.log(`\r[obfuscate] ✓ ${files.length} files obfuscated`);
}

main().catch((e) => { console.error("[obfuscate] Error:", e); process.exit(1); });
