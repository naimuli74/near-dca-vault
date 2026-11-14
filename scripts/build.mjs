// Bundles src/*.js + public assets into dist/worker.js and a Cloudflare MCP deploy snippet.
import fs from 'fs';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url);
const workerName = process.env.WORKER_NAME || 'near-dca-vault';
const kvId = process.env.KV_NAMESPACE_ID || 'REPLACE_AT_DEPLOY';

function read(rel) {
  return fs.readFileSync(new URL(rel, ROOT), 'utf8');
}
function readBin(rel) {
  return fs.readFileSync(new URL(rel, ROOT));
}
function strip(src) {
  return src
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\n/gm, '')
    .replace(/^export\s+(?=const|function|async|class|\{)/gm, '');
}

const modules = [
  strip(read('src/oneclick.js')),
  strip(read('src/store.js')),
  strip(read('src/plans.js')),
  strip(read('src/worker.js')),
].join('\n');

const textAssets = {
  '/index.html': ['public/index.html', 'text/html; charset=utf-8', false],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8', true],
  '/app.js': ['public/app.js', 'application/javascript; charset=utf-8', true],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml', true],
  '/brand/logo.svg': ['public/brand/logo.svg', 'image/svg+xml', true],
  '/brand/near-logo-rev.svg': ['public/brand/near-logo-rev.svg', 'image/svg+xml', true],
  '/robots.txt': null,
};
const binAssets = {
  '/fonts/inter-var.woff2': ['public/fonts/inter-var.woff2', 'font/woff2'],
  '/fonts/instrument-serif.woff2': ['public/fonts/instrument-serif.woff2', 'font/woff2'],
  '/fonts/instrument-serif-italic.woff2': ['public/fonts/instrument-serif-italic.woff2', 'font/woff2'],
};

const ASSET_INIT = [];
for (const [path, spec] of Object.entries(textAssets)) {
  if (!spec) continue;
  const [file, type, immutable] = spec;
  ASSET_INIT.push(`ASSETS[${JSON.stringify(path)}]={type:${JSON.stringify(type)},immutable:${immutable},body:${JSON.stringify(read(file))}};`);
}
ASSET_INIT.push(`ASSETS['/robots.txt']={type:'text/plain; charset=utf-8',immutable:true,body:'User-agent: *\\nAllow: /\\n'};`);
for (const [path, [file, type]] of Object.entries(binAssets)) {
  if (!fs.existsSync(new URL(file, ROOT))) continue;
  const b64 = readBin(file).toString('base64');
  ASSET_INIT.push(`ASSETS[${JSON.stringify(path)}]={type:${JSON.stringify(type)},immutable:true,body:u8(${JSON.stringify(b64)})};`);
}
const ogPath = new URL('public/og.png', ROOT);
if (fs.existsSync(ogPath)) {
  ASSET_INIT.push(`ASSETS['/og.png']={type:'image/png',immutable:true,body:u8(${JSON.stringify(fs.readFileSync(ogPath).toString('base64'))})};`);
}
const apple = new URL('public/apple-touch-icon.png', ROOT);
if (fs.existsSync(apple)) {
  ASSET_INIT.push(`ASSETS['/apple-touch-icon.png']={type:'image/png',immutable:true,body:u8(${JSON.stringify(fs.readFileSync(apple).toString('base64'))})};`);
}

const worker = `function u8(b64){const s=atob(b64);const a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
const ASSETS=Object.create(null);
${ASSET_INIT.join('\n')}
${modules}
`;

const dist = new URL('dist/', ROOT);
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(new URL('worker.js', dist), worker);
fs.writeFileSync(new URL('public/robots.txt', ROOT), 'User-agent: *\nAllow: /\n');

const meta = {
  main_module: 'worker.js',
  compatibility_date: '2025-09-01',
  bindings: [{ type: 'kv_namespace', name: 'PLANS', namespace_id: kvId }],
};
const deploy = `async () => {
  const packed = Uint8Array.from(atob(${JSON.stringify(gzipSync(Buffer.from(worker)).toString('base64'))}), c => c.charCodeAt(0));
  const code = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(${JSON.stringify(meta)})], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
  const r = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/${workerName}\`, body: form });
  let s; try { s = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/workers/scripts/${workerName}/subdomain\`, body: { enabled: true, previews_enabled: false } }); } catch (e) { s = String(e); }
  let sub; try { sub = await cloudflare.request({ method: 'GET', path: \`/accounts/\${accountId}/workers/subdomain\` }); } catch (e) { sub = String(e); }
  return { ok: r.success, errors: r.errors, enable: s && (s.result || s), subdomain: sub && (sub.result || sub) };
}`;
fs.writeFileSync(new URL('deploy.js', dist), deploy);
console.log('worker', worker.length, 'deploy', deploy.length, 'kv', kvId);
