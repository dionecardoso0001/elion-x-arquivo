/**
 * ELION-X — Servidor seguro Node.js (built-ins apenas, sem npm)
 * Serve o frontend e faz proxy seguro da API Claude.
 * A ANTHROPIC_API_KEY fica SOMENTE aqui no servidor — nunca exposta no browser.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Carrega .env manualmente (sem dotenv) ───────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

const SYSTEM_PROMPT = `Você é ELION, o núcleo de inteligência central da plataforma Elion-X.
Especializado em: análise estratégica, relatórios executivos, automação de workflows,
segurança, processamento de documentos e orquestração de agentes.
Responda em português, de forma profissional e orientada a resultados.
Use markdown (negrito, listas, código) quando útil.`;

// ── Servidor HTTP ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── POST /api/chat — proxy streaming para Anthropic ───────────────────────
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' }));
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); return res.end('Bad Request');
      }

      const { messages = [], agent = 'ELION CORE' } = payload;
      const requestBody = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const apiReq = https.request(options, apiRes => {
        apiRes.on('data', chunk => {
          // Repassa o SSE do Anthropic direto para o cliente
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue;
            try {
              const ev = JSON.parse(raw);
              if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                res.write(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`);
              }
            } catch {}
          }
        });
        apiRes.on('end', () => {
          res.write('data: {"done":true}\n\n');
          res.end();
        });
      });

      apiReq.on('error', err => {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      });

      apiReq.write(requestBody);
      apiReq.end();
    });
    return;
  }

  // ── GET /api/status ────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'OPERATIONAL',
      model: 'claude-sonnet-4-6',
      apiKey: API_KEY ? '✓ Configurada' : '✗ Ausente',
      uptime: Math.round(process.uptime()) + 's',
      version: '2.0.0',
    }));
  }

  // ── Servir arquivos estáticos ──────────────────────────────────────────────
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);

  // Fallback para a raiz se não encontrar em /public
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n⚡ ELION-X Backend rodando em http://localhost:${PORT}`);
  console.log(`   API Key: ${API_KEY ? '✓ Configurada' : '✗ Não encontrada — adicione ao .env'}`);
  console.log(`   Acesse:  http://localhost:${PORT}\n`);
});
