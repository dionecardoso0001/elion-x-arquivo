/**
 * ELION-X Mobile — sobe um túnel HTTPS (Cloudflare) e mostra um QR Code
 * para abrir a plataforma no smartphone, de qualquer rede, com voz e câmera.
 *
 * O binário do cloudflared (~52 MB) não é versionado no repositório. Se ele
 * não estiver em bin/, este script o baixa sozinho na primeira execução —
 * sem isso o túnel morria com ENOENT e o celular ficava sem acesso nenhum.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3001;
const BIN_DIR = path.join(ROOT, 'bin');
const IS_WIN = process.platform === 'win32';
const CF = path.join(BIN_DIR, IS_WIN ? 'cloudflared.exe' : 'cloudflared');

const line = '═'.repeat(54);
const log = (...a) => console.log(...a);

/* ── endereço do PC na rede local: serve de plano B quando o celular
      está no mesmo Wi-Fi de casa (mas aí voz/câmera não abrem, porque
      o navegador só libera microfone e câmera em HTTPS) ────────────── */
function lanURLs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${PORT}`);
    }
  }
  return out;
}

function serverUp() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/api/status`, r => { r.resume(); resolve(r.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await serverUp()) { log('  ✓ Núcleo ELION-X já está no ar.'); return; }
  log('  ▸ Iniciando o núcleo ELION-X...');
  const node = spawn(process.execPath, ['server.js'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  node.on('error', e => log(`  ⚠ Não consegui iniciar o server.js: ${e.message}`));
  node.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 600));
    if (await serverUp()) { log('  ✓ Núcleo online.'); return; }
  }
  log('  ⚠ Não consegui confirmar o núcleo, mas o túnel seguirá tentando.');
}

/* ── cloudflared: usa o de bin/, senão o do PATH, senão baixa ─────────── */
function cfAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (IS_WIN)                       return `cloudflared-windows-${arch}.exe`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  return null; // macOS vem em .tgz — instalar com: brew install cloudflared
}

async function baixarCloudflared() {
  const asset = cfAsset();
  if (!asset) throw new Error('neste sistema, instale o cloudflared à parte (ex.: brew install cloudflared)');
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  log('  ▸ Primeira execução: baixando o cloudflared (~52 MB)...');
  log(`    ${url}`);

  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download falhou (HTTP ${r.status})`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = `${CF}.parcial`;
  const total = Number(r.headers.get('content-length')) || 0;
  let lido = 0, marca = 0;
  const arquivo = fs.createWriteStream(tmp);

  for await (const pedaco of r.body) {
    arquivo.write(pedaco);
    lido += pedaco.length;
    if (total) {
      const pct = Math.floor((lido / total) * 100);
      if (pct >= marca + 10) { marca = pct - (pct % 10); process.stdout.write(`    ${marca}% `); }
    }
  }
  await new Promise((ok, erro) => { arquivo.end(); arquivo.on('finish', ok); arquivo.on('error', erro); });
  fs.renameSync(tmp, CF);
  if (!IS_WIN) fs.chmodSync(CF, 0o755);
  log(`\n  ✓ cloudflared instalado em bin/.`);
}

async function resolverCloudflared() {
  if (fs.existsSync(CF)) return CF;
  // já instalado no sistema? então nem precisa baixar
  const noPath = await new Promise(ok => {
    const p = spawn(IS_WIN ? 'cloudflared.exe' : 'cloudflared', ['--version'], { stdio: 'ignore' });
    p.on('error', () => ok(false));
    p.on('exit', c => ok(c === 0));
  });
  if (noPath) { log('  ✓ cloudflared encontrado no sistema.'); return IS_WIN ? 'cloudflared.exe' : 'cloudflared'; }
  await baixarCloudflared();
  return CF;
}

function abrirNoNavegador(url) {
  const cmd = IS_WIN ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin' ? ['open', [url]]
            : ['xdg-open', [url]];
  const p = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

function startTunnel(bin) {
  log(`\n  ${line}\n   E-L-I-O-N  X   ·   ACESSO MOBILE (túnel HTTPS)\n  ${line}\n`);
  log('  ▸ Abrindo túnel seguro com a Cloudflare...\n');

  const cf = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { cwd: ROOT });
  let shown = false;
  const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

  // se em 60 s a Cloudflare não devolver link, avisa em vez de deixar a janela muda
  const semLink = setTimeout(() => {
    if (!shown) {
      log('\n  ⚠ O túnel ainda não devolveu um link em 60 s.');
      log('    Verifique sua conexão com a internet — o cloudflared precisa');
      log('    sair para a rede. Enquanto isso, no mesmo Wi-Fi de casa dá');
      log('    para abrir pelos endereços locais mostrados acima.\n');
    }
  }, 60000);

  cf.on('error', e => {
    clearTimeout(semLink);
    log(`\n  ✗ Não consegui executar o cloudflared: ${e.message}`);
    log('    Apague a pasta bin\\ e rode este atalho de novo para baixar outra vez.\n');
  });

  const handle = buf => {
    const s = buf.toString();
    const m = s.match(urlRe);
    if (m && !shown) {
      shown = true;
      clearTimeout(semLink);
      const link = m[0];
      log(`\n  ${line}`);
      log(`   ✅  SEU LINK MOBILE ESTÁ PRONTO, SENHOR:`);
      log(`\n        ${link}\n`);
      log(`   ◈ Um QR Code vai abrir no navegador do PC — escaneie`);
      log(`     com a câmera do celular para entrar com voz e câmera.`);
      log(`   ◈ Funciona em QUALQUER rede: Wi-Fi de casa, 4G/5G ou`);
      log(`     Wi-Fi de fora — o celular não precisa estar na sua rede.`);
      log(`   ◈ Mantenha ESTA janela aberta enquanto usar no celular.`);
      log(`   ⚠ O link é público enquanto o túnel estiver aberto: não`);
      log(`     compartilhe com ninguém e feche a janela ao terminar.`);
      log(`  ${line}\n`);
      // abre a página local de QR (o link não é enviado a terceiros)
      abrirNoNavegador(`http://localhost:${PORT}/qr?u=${encodeURIComponent(link)}`);
    }
  };

  cf.stdout.on('data', handle);
  cf.stderr.on('data', handle); // cloudflared imprime o URL no stderr
  cf.on('exit', code => {
    clearTimeout(semLink);
    log(`\n  Túnel encerrado (código ${code}). Feche esta janela.`);
  });
}

(async () => {
  await ensureServer();

  const lan = lanURLs();
  if (lan.length) {
    log('\n  ▸ Plano B — mesmo Wi-Fi de casa (sem voz/câmera, pois não é HTTPS):');
    for (const u of lan) log(`      ${u}`);
  }

  let bin;
  try {
    bin = await resolverCloudflared();
  } catch (e) {
    log(`\n  ✗ Não foi possível preparar o túnel: ${e.message}`);
    if (lan.length) {
      log('\n  ▸ Use por enquanto, do celular no Wi-Fi de casa:');
      for (const u of lan) log(`      ${u}`);
      log('    (o texto funciona; microfone e câmera exigem HTTPS = túnel)\n');
    }
    process.exitCode = 1;
    return;
  }

  startTunnel(bin);
})();
