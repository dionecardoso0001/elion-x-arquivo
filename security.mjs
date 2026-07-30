/**
 * ELION-X · Módulo CYBER SECURITY (defensivo, somente leitura)
 * Analisa a rede e o sistema do PRÓPRIO operador para detectar sinais de
 * comprometimento — SEM jamais atacar terceiros:
 *   · conexões TCP estabelecidas + portas em escuta (Get-NetTCPConnection)
 *   · processos suspeitos e uso de recursos
 *   · heurística de ransomware/malware (nomes e locais conhecidos)
 *   · assinaturas de ATAQUE contra a plataforma (SQLi/XSS/traversal/scan/DDoS)
 *     a partir do log de requisições do servidor
 *   · GEOLOCALIZA a origem dos IPs externos/atacantes (ip-api.com)
 * Tudo é read-only: nada é bloqueado, morto ou alterado. O ELION só RELATA.
 */
import { execFile } from 'child_process';

const isWin = process.platform === 'win32';

/* executa PowerShell read-only com timeout; devolve stdout (ou '' em falha) */
function ps(script, timeout = 12000) {
  return new Promise(resolve => {
    if (!isWin) return resolve('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(stdout || ''));
  });
}
const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
const arr = v => Array.isArray(v) ? v : (v ? [v] : []);

const isPrivate = ip => !ip || /^(10\.|127\.|0\.|169\.254\.|192\.168\.|::1|fe80|::$)/.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip === '::' || ip === '0.0.0.0';

/* ── ASSINATURAS DE ATAQUE (compartilhada com o hot-path do servidor) ── */
export const ATTACK_SIGNATURES = [
  { tipo: 'SQL Injection', re: /(union\s+select|\bor\b\s+1\s*=\s*1|'\s*or\s*'|;\s*drop\s+table|information_schema|sleep\s*\(|benchmark\s*\(|pg_sleep|xp_cmdshell|waitfor\s+delay|\bselect\b.+\bfrom\b.+\bwhere\b|--\s|%27)/i },
  { tipo: 'Path Traversal', re: /(\.\.[\/\\]|%2e%2e|\/etc\/passwd|\/etc\/shadow|boot\.ini|win\.ini|\/proc\/self)/i },
  { tipo: 'XSS', re: /(<script|onerror\s*=|onload\s*=|javascript:|%3cscript|<img[^>]+src\s*=|document\.cookie)/i },
  { tipo: 'Command Injection', re: /(;\s*(cat|wget|curl|nc|bash|sh|powershell|cmd)\b|\|\s*(cat|nc|sh|bash)\b|\$\(.*\)|`.*`|&&\s*(cat|whoami|id)\b)/i },
  { tipo: 'Sondagem/Scanner', re: /(\/\.env|\/\.git|\/wp-admin|\/wp-login|phpmyadmin|\/admin\.php|xmlrpc\.php|\/\.aws|\/\.ssh|actuator\/|\/config\.|\/backup|\/shell)/i },
  { tipo: 'Log4Shell/RCE', re: /(\$\{jndi:|\{\{.*\}\}|__proto__|constructor\[|process\.env)/i },
];
export function sigScan(text, ua = '') {
  const hits = [];
  const hay = String(text || '');
  for (const s of ATTACK_SIGNATURES) if (s.re.test(hay)) hits.push(s.tipo);
  if (/sqlmap|nikto|nmap|masscan|acunetix|nessus|dirbuster|gobuster|hydra|wpscan|zgrab/i.test(ua)) hits.push('Ferramenta de ataque (User-Agent)');
  return hits;
}

/* geolocaliza vários IPs de uma vez (ip-api batch, gratuito) */
async function geolocate(ips) {
  const publicos = [...new Set(ips.filter(ip => ip && !isPrivate(ip)))].slice(0, 30);
  if (!publicos.length) return {};
  try {
    const body = publicos.map(q => ({ query: q, fields: 'status,country,city,isp,org,lat,lon,query' }));
    const r = await fetch('http://ip-api.com/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(9000),
    }).then(x => x.json());
    const map = {};
    for (const e of arr(r)) if (e.status === 'success') map[e.query] = { pais: e.country, cidade: e.city, isp: e.org || e.isp, lat: e.lat, lon: e.lon };
    return map;
  } catch { return {}; }
}

/* ── conexões TCP + processos (Windows) ── */
async function netAndProcs() {
  const out = await ps(`
    $ErrorActionPreference='SilentlyContinue'
    $conns = Get-NetTCPConnection -State Established |
      Select-Object RemoteAddress,RemotePort,OwningProcess,LocalPort
    $listen = Get-NetTCPConnection -State Listen |
      Select-Object LocalAddress,LocalPort,OwningProcess
    $procs = @{}
    Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName }
    $result = [ordered]@{
      established = @($conns | ForEach-Object { [ordered]@{ ip=$_.RemoteAddress; port=$_.RemotePort; lport=$_.LocalPort; pid=$_.OwningProcess; proc=$procs[[int]$_.OwningProcess] } })
      listening   = @($listen | ForEach-Object { [ordered]@{ addr=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; proc=$procs[[int]$_.OwningProcess] } })
    }
    $result | ConvertTo-Json -Depth 4 -Compress
  `, 14000);
  return parseJson(out, { established: [], listening: [] });
}

async function topProcesses() {
  const out = await ps(`
    $ErrorActionPreference='SilentlyContinue'
    Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 |
      ForEach-Object { [ordered]@{ nome=$_.ProcessName; cpu=[math]::Round($_.CPU,1); ramMB=[math]::Round($_.WorkingSet64/1MB) } } |
      ConvertTo-Json -Compress
  `, 8000);
  return arr(parseJson(out, []));
}

/* heurística LEVE de malware/ransomware — nomes/processos suspeitos + notas de resgate no perfil.
   NÃO é antivírus: sinaliza indícios para o operador investigar. */
const SUSPECT_PROC = /(mimikatz|psexec|cobalt|meterpreter|ngrok|nc\.exe|netcat|cryptolocker|wannacry|locky|cryptowall|xmrig|coinminer|kryptik|rundll32.*temp|powershell.*-enc|certutil.*-urlcache)/i;
async function malwareHeuristic(procs) {
  const flags = [];
  for (const p of procs) if (SUSPECT_PROC.test(p.proc || p.nome || '')) flags.push(`Processo suspeito: ${p.proc || p.nome} (PID ${p.pid || '?'})`);
  // notas de resgate (ransomware) em locais comuns
  const ransom = await ps(`
    $ErrorActionPreference='SilentlyContinue'
    $paths = @("$env:USERPROFILE\\Desktop","$env:USERPROFILE\\Documents")
    $hits = foreach($d in $paths){ Get-ChildItem -Path $d -Include *_readme*.txt,*decrypt*.txt,*HOW_TO*.txt,*RECOVER*.txt,*.ransom -File -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty Name }
    ($hits | Select-Object -Unique) -join "|"
  `, 8000);
  if (ransom.trim()) flags.push('Possíveis notas de resgate (ransomware): ' + ransom.trim().replace(/\|/g, ', '));
  return flags;
}

/**
 * Executa a varredura defensiva completa.
 * @param {object} o
 * @param {Array}  o.events  log de requisições do servidor (do ring buffer)
 * @param {number} o.port    porta do próprio servidor (ignora conexões locais a ela)
 * @param {string} o.focus   foco opcional ('rede'|'ataques'|'malware'|'geral')
 */
export async function scan({ events = [], port = 0, focus = 'geral' } = {}) {
  const agora = Date.now();
  const janela = events.filter(e => agora - e.t < 15 * 60000); // últimos 15 min

  // 1) ATAQUES contra a plataforma (do log) — agrupa por tipo e por IP de origem
  const ataques = janela.filter(e => e.threats && e.threats.length);
  const porTipo = {}; const ipCount = {}; const atacantes = new Set();
  for (const e of ataques) {
    for (const t of e.threats) porTipo[t] = (porTipo[t] || 0) + 1;
    atacantes.add(e.ip);
  }
  // 2) DDoS — rajada de requisições do mesmo IP no último minuto
  const ultMin = events.filter(e => agora - e.t < 60000);
  for (const e of ultMin) ipCount[e.ip] = (ipCount[e.ip] || 0) + 1;
  const ddos = Object.entries(ipCount).filter(([ip, n]) => n >= 120 && !isPrivate(ip))
    .map(([ip, n]) => ({ ip, rpm: n }));
  ddos.forEach(d => atacantes.add(d.ip));

  // 3) sistema local (Windows) — melhor esforço em paralelo
  const [net, procs] = await Promise.all([netAndProcs(), topProcesses()]);
  const malware = await malwareHeuristic([...(net.established || []), ...procs]);

  // conexões externas (fora da rede local) — candidatas a exfiltração/C2
  const externas = (net.established || []).filter(c => !isPrivate(c.ip));
  const ipsExternos = externas.map(c => c.ip);

  // 4) GEOLOCALIZAÇÃO da origem — atacantes (do log) + conexões externas ativas
  const geo = await geolocate([...atacantes, ...ipsExternos]);

  // agrega conexões externas por IP (com processo dono)
  const extAgg = {};
  for (const c of externas) {
    const k = c.ip;
    if (!extAgg[k]) extAgg[k] = { ip: k, conexoes: 0, portas: new Set(), procs: new Set(), geo: geo[k] || null };
    extAgg[k].conexoes++; extAgg[k].portas.add(c.port); if (c.proc) extAgg[k].procs.add(c.proc);
  }
  const conexoesExternas = Object.values(extAgg).map(e => ({
    ip: e.ip, conexoes: e.conexoes, portas: [...e.portas].slice(0, 6), processos: [...e.procs].slice(0, 4), geo: e.geo,
  })).sort((a, b) => b.conexoes - a.conexoes).slice(0, 20);

  // portas em escuta abertas ao mundo (0.0.0.0 / ::) — superfície de ataque
  const escutaExposta = (net.listening || [])
    .filter(l => l.addr === '0.0.0.0' || l.addr === '::')
    .map(l => ({ port: l.port, proc: l.proc || '?' }))
    .filter((v, i, a) => a.findIndex(x => x.port === v.port) === i)
    .sort((a, b) => a.port - b.port).slice(0, 30);

  // nível geral de ameaça
  let nivel = 'NORMAL', score = 0;
  score += Object.values(porTipo).reduce((s, n) => s + n, 0);
  score += ddos.length * 5 + malware.length * 8;
  if (score >= 20 || malware.length) nivel = 'CRÍTICO';
  else if (score >= 6 || ddos.length) nivel = 'ELEVADO';
  else if (score >= 1) nivel = 'ATENÇÃO';

  return {
    at: new Date().toISOString(), nivel, score, focus,
    resumoAtaques: {
      totalTentativas: ataques.length,
      porTipo,                                  // { 'SQL Injection': 3, ... }
      ipsAtacantes: [...atacantes].filter(ip => !isPrivate(ip)).map(ip => ({ ip, geo: geo[ip] || null,
        tipos: [...new Set(janela.filter(e => e.ip === ip).flatMap(e => e.threats || []))],
        exemplos: janela.filter(e => e.ip === ip && e.threats?.length).slice(-3).map(e => `${e.method} ${e.path}`) })),
      ddos,
    },
    rede: {
      conexoesExternas,               // com geolocalização (país/cidade/ISP)
      totalEstabelecidas: (net.established || []).length,
      escutaExposta,                  // portas abertas ao mundo
    },
    sistema: { malwareIndicios: malware, topProcessos: procs },
  };
}
