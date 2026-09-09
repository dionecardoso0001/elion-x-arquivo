/**
 * Teste de regressão da BIOMETRIA VOCAL — roda sem navegador e sem microfone.
 *
 *   node scripts/teste-biometria-vocal.mjs        (ou: npm run test:voz)
 *
 * Carrega assets/voiceid.js e exercita o núcleo de decisão com vozes
 * sintéticas da família e de visitantes. O que este teste protege:
 *
 *   1. quem é da casa é CHAMADO PELO NOME mesmo falando fora do tom habitual
 *      (animado, cansado, rouco, longe do microfone) — hesitar aqui é o
 *      defeito que fazia o agente tratar a filha como se fosse o operador;
 *   2. quem NÃO é da casa nunca recebe o nome de alguém da família;
 *   3. a memória curta de locutor desempata, mas não PRENDE: se outra pessoa
 *      assume a palavra, a troca é imediata.
 *
 * As vozes são sintéticas de propósito: o objetivo é travar a MATEMÁTICA da
 * decisão contra regressões, não medir acurácia com vozes reais.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* voiceid.js é um IIFE de navegador: carregamos o texto e expomos os internos
   apenas aqui, sem que o arquivo de produção precise de nenhuma porta extra. */
const src = fs.readFileSync(path.join(ROOT, 'assets', 'voiceid.js'), 'utf8')
  .replace('ELX.voiceid = {', 'ELX.voiceid = { __t: { similar, demografia },');
globalThis.ELX = {};
new Function(src)();
const { similar, demografia } = ELX.voiceid.__t;

/* ── as mesmas portas de decisão de decidir(), em espelho ───────────────── */
const SIM_OK = 0.90, MARGEM = 0.03, SIM_CLARO = 0.78, MARGEM_FORTE = 0.15;

/* ── vozes sintéticas: cada pessoa tem inclinação espectral e ressonâncias
      próprias, mais um ruído determinístico que simula ambiente e distância ── */
function ltas(tilt, picos, ruido = 0, semente = 1) {
  let s = semente;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const v = Array.from({ length: 20 }, (_, i) => {
    let x = Math.exp(-i * tilt);
    for (const [b, g] of picos) x += g * Math.exp(-((i - b) ** 2) / 3);
    return Math.max(0.001, x + rnd() * ruido);
  });
  const soma = v.reduce((a, b) => a + b, 0);
  return v.map(x => x / soma);
}

const FORMA = {
  Dione:   { tilt: 0.22, picos: [[3, 0.5], [9, 0.25]], f0: 126, f3: 2500, relacao: 'operador' },
  Ayla:    { tilt: 0.10, picos: [[6, 0.4], [13, 0.45]], f0: 232, f3: 3400, relacao: 'filha' },
  Valéria: { tilt: 0.14, picos: [[5, 0.35], [11, 0.3]], f0: 196, f3: 3050, relacao: 'esposa' },
};
const SEMENTE = { Dione: 7, Ayla: 21, Valéria: 33 };

const db = Object.entries(FORMA).map(([nome, f]) => ({
  nome, relacao: f.relacao, f0: f.f0, f3: f.f3,
  ltas: ltas(f.tilt, f.picos, 0, SEMENTE[nome]),
}));

/** uma fala real = o perfil da pessoa + variação natural do dia */
function fala(nome, { desvioF0 = 1.0, ruido = 0.02, semente = 99 } = {}) {
  const f = FORMA[nome];
  return { f0: f.f0 * desvioF0, f3: f.f3 + (semente % 7) * 12,
           ltas: ltas(f.tilt, f.picos, ruido, semente) };
}

function veredito(v, atual = null) {
  const r = db.map(p => ({ nome: p.nome, s: similar(v, p) + (atual && p.nome === atual ? 0.02 : 0) }))
              .sort((a, b) => b.s - a.s);
  const score = r[0].s, margem = r[0].s - (r[1]?.s ?? 0);
  const afirma = (score >= SIM_OK && margem >= MARGEM) || (score >= SIM_CLARO && margem >= MARGEM_FORTE);
  return { quem: afirma ? r[0].nome : null, topo: r[0].nome, score, margem };
}

let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) falhas++; };
const det = d => `${d.topo} ${d.score.toFixed(3)} (folga ${d.margem.toFixed(3)})`;

console.log('\n── quem é da casa deve ser chamado pelo nome, sem hesitar ──');
for (const nome of ['Ayla', 'Dione', 'Valéria']) {
  for (const [caso, opt] of [
    ['tom normal', {}],
    ['animado (mais agudo)', { desvioF0: 1.10, semente: 11 }],
    ['cansado (mais grave)', { desvioF0: 0.90, semente: 17 }],
    ['ambiente ruidoso', { ruido: 0.06, semente: 5 }],
    ['longe do microfone', { ruido: 0.09, desvioF0: 1.05, semente: 41 }],
  ]) {
    const d = veredito(fala(nome, opt));
    ok(d.quem === nome, `${nome} · ${caso}: ${det(d)}`);
  }
}

/* CASO EXTREMO, com exigência diferente — de propósito.
   Um desvio de +18% no tom leva a Valéria (196 Hz) a 231 Hz, ou seja, em cima
   do tom da Ayla (232 Hz). Aqui NÃO exigimos que o nome saia: entre mãe e
   filha nessa faixa, hesitar e perguntar é melhor que cravar na sorte. O que
   o sistema não pode fazer, nunca, é afirmar com confiança o nome ERRADO —
   é isso que este bloco trava. */
console.log('\n── tom extremo: pode hesitar, mas não pode errar o nome ──');
for (const nome of ['Ayla', 'Dione', 'Valéria']) {
  const d = veredito(fala(nome, { desvioF0: 1.18, semente: 13 }));
  ok(d.quem === nome || d.quem === null,
     `${nome} · muito animado: ${d.quem ? 'afirmou ' + d.quem : 'preferiu perguntar'} — ${det(d)}`);
}

console.log('\n── a memória curta desempata, mas não prende o locutor anterior ──');
for (const [quem, anterior, caso] of [
  ['Ayla', 'Dione', 'filha assume a palavra depois do pai'],
  ['Dione', 'Ayla', 'pai retoma a palavra depois da filha'],
  ['Valéria', 'Ayla', 'esposa entra na conversa da filha'],
]) {
  const d = veredito(fala(quem, { desvioF0: 1.10, semente: 29 }), anterior);
  ok(d.quem === quem, `${caso}: ${det(d)}`);
}

console.log('\n── voz de fora nunca pode receber nome da família ──');
for (const [caso, v] of [
  ['visita, homem',    { f0: 152, f3: 2820, ltas: ltas(0.30, [[1, 0.6], [15, 0.5]], 0.03, 55) }],
  ['visita, mulher',   { f0: 205, f3: 3120, ltas: ltas(0.26, [[2, 0.55], [16, 0.4]], 0.03, 61) }],
  ['criança de fora',  { f0: 275, f3: 3520, ltas: ltas(0.34, [[0, 0.7], [17, 0.6]], 0.03, 73) }],
  ['homem grave',      { f0: 108, f3: 2380, ltas: ltas(0.40, [[8, 0.6], [18, 0.5]], 0.03, 89) }],
  ['mulher aguda',     { f0: 243, f3: 3260, ltas: ltas(0.20, [[9, 0.5], [19, 0.45]], 0.03, 97) }],
]) {
  const d = veredito(v);
  ok(!d.quem, `${caso}: ninguém afirmado — melhor palpite ${det(d)}`);
}

console.log('\n── perfil demográfico de quem não é cadastrado ──');
ok(demografia({ f0: 232, f3: 3400 }).tipo === 'criança', 'voz de 232 Hz → criança');
ok(demografia({ f0: 196, f3: 3050 }).tipo === 'mulher', 'voz de 196 Hz → mulher adulta');
ok(demografia({ f0: 126, f3: 2500 }).tipo === 'homem', 'voz de 126 Hz → homem adulto');

console.log(falhas ? `\n✗ ${falhas} falha(s)\n` : '\n✓ Biometria vocal: todos os casos passaram.\n');
process.exit(falhas ? 1 : 0);
