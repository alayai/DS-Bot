import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = new URL('../../.playwright-mcp/bothub-scene-benchmark/', import.meta.url)
await mkdir(output, { recursive: true })
await build({
  absWorkingDir: root, entryPoints: ['dev/scene-benchmark.mjs'], bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022',
  outfile: fileURLToPath(new URL('benchmark.js', output)),
})
const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8')
await writeFile(new URL('index.html', output), `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>BotHub synthetic scene benchmark</title>
<style>${css}
body { margin: 0; } .bh-root { height: auto; } .bh-scene { height: 1080px; flex: none; }
pre { white-space: pre-wrap; } h1 { padding: 12px; }
</style>
<div class="bh-root"><h1>Development benchmark · Synthetic members</h1>
<div class="bh-scene" tabindex="0"><div class="bh-scene-labels"></div></div></div>
<pre>Run await runBenchmark({count: 20}), then count: 50 in the browser console.</pre>
<script type="module" src="./benchmark.js"></script></html>`)
console.log(fileURLToPath(output))
