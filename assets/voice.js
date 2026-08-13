/* ═══════════════════════════════════════════════════════════════════
   ELION-X v3.1 — Sistema Vocal Conversacional
   · TTS: Edge neural grátis via /api/tts (fallback: speechSynthesis)
   · Fala frase-a-frase em streaming (baixa latência)
   · MODO CONVERSA: escuta contínua mãos-livres com BARGE-IN —
     fale por cima do agente e ele PARA e te escuta imediatamente
   · Análise de frequência em tempo real → esfera reage à voz
   · LIVE: conversa full-duplex (OpenAI Realtime WebRTC, barge-in nativo)
═══════════════════════════════════════════════════════════════════ */
(function () {
  let ctx = null;             // AudioContext
  let analyser = null;        // tap central de análise (esfera/waveform)
  let freqData = null, timeData = null;
  let simOn = false;          // bandas simuladas (fallback speechSynthesis)
  let player = null;          // <audio> reutilizável p/ TTS

  const VOICE_CFG = {};       // vazio → servidor decide (EDGE_VOICE no .env)

  let lipAn = null, lipData = null;   // tap DEDICADO ao lip-sync (alta resolução, resposta rápida)

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.74;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
      // O tap da esfera é suavizado demais (0.74) e de baixa resolução para
      // distinguir vogais. O lip-sync precisa do oposto: janela longa (resolve
      // formantes ~23 Hz/bin) e suavização mínima (a boca reage no mesmo
      // instante da sílaba, sem atraso perceptível).
      lipAn = ctx.createAnalyser();
      lipAn.fftSize = 2048;
      lipAn.smoothingTimeConstant = 0.12;
      lipData = new Uint8Array(lipAn.frequencyBinCount);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ── bandas de frequência p/ a esfera ── */
  ELX.audio.bands = function () {
    if (simOn) {
      const t = performance.now() / 1000;
      const e = 0.45 + 0.3 * Math.sin(t * 6.3) + 0.18 * Math.sin(t * 13.7) + Math.random() * 0.12;
      return { bass: Math.max(0, e * 0.8), mid: Math.max(0, e * 0.7), treble: Math.max(0, 0.3 + 0.4 * Math.sin(t * 9.1)), level: Math.max(0, e * 0.7) };
    }
    if (!analyser) return { bass: 0, mid: 0, treble: 0, level: 0 };
    analyser.getByteFrequencyData(freqData);
    const n = freqData.length;
    const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += freqData[i]; return s / ((b - a) * 255); };
    const curve = v => Math.min(1, Math.pow(v * 1.7, 1.25));
    return {
      bass: curve(avg(1, 7)), mid: curve(avg(7, 44)),
      treble: curve(avg(44, Math.min(n, 140))), level: curve(avg(1, Math.min(n, 140))),
    };
  };

  /* ═════════ ANÁLISE VOCÁLICA — o que move os lábios do avatar ═════════
     Vogais não se distinguem por "grave/agudo", e sim pelos dois primeiros
     FORMANTES (ressonâncias do trato vocal):
       F1 acompanha a ABERTURA da boca  (baixo = fechada /i,u/ · alto = aberta /a/)
       F2 acompanha a POSIÇÃO da língua (baixo = arredondada /u,o/ · alto = esticada /i,e/)
     Em vez de estimar F1/F2 por pico (instável a 60 fps), medimos a energia em
     faixas centradas nessas regiões e derivamos dois eixos contínuos —
     abertura × anterioridade — que posicionam a boca no espaço vocálico.
     Devolve também sibilância (S/CH), fricativa labial (F/V) e transientes
     (P/B/T) para as consoantes. */
  const lipState = { prevE: 0, burst: 0, silMs: 0 };

  ELX.audio.voice = function () {
    const nul = { level: 0, open: 0, front: 0.5, voiced: 0, sib: 0, fric: 0, burst: 0 };
    if (simOn) {                       // fallback sem áudio real: só energia simulada
      const b = ELX.audio.bands();
      return { level: b.level, open: 0.5 + 0.3 * Math.sin(performance.now() / 190), front: 0.5, voiced: b.level, sib: 0, fric: 0, burst: 0 };
    }
    if (!lipAn) return nul;
    lipAn.getByteFrequencyData(lipData);

    const sr = (ctx && ctx.sampleRate) || 48000;
    const binHz = sr / lipAn.fftSize;
    const hz2bin = f => Math.max(0, Math.min(lipData.length - 1, Math.round(f / binHz)));
    // energia média (0..1) numa faixa de Hz
    const band = (lo, hi) => {
      const a = hz2bin(lo), b = Math.max(a + 1, hz2bin(hi));
      let s = 0; for (let i = a; i < b; i++) s += lipData[i];
      return s / ((b - a) * 255);
    };
    // espectro suavizado (média móvel de 3 bins) — apaga os harmônicos de f0 que
    // criariam picos falsos, mantendo a envoltória onde vivem os formantes
    const sm = i => (lipData[i - 1] + lipData[i] + lipData[i + 1]) / 3;
    /** pico dominante numa faixa, com interpolação parabólica (precisão sub-bin) */
    const pico = (lo, hi) => {
      const a = Math.max(1, hz2bin(lo)), b = Math.min(lipData.length - 2, hz2bin(hi));
      let bi = a, bv = -1;
      for (let i = a; i <= b; i++) { const v = sm(i); if (v > bv) { bv = v; bi = i; } }
      if (bv <= 0) return { hz: 0, amp: 0 };
      const l = sm(bi - 1), c = sm(bi), r = sm(bi + 1);
      const d = (l - r) / (2 * (l - 2 * c + r) || 1e-6);          // vértice da parábola
      return { hz: (bi + Math.max(-1, Math.min(1, d))) * binHz, amp: bv / 255 };
    };

    const sibE = band(4200, 8500);  // chiado → /s/ /z/ /ʃ/ /ʒ/
    const fricE = band(1200, 2600); // ruído labiodental /f/ /v/
    const lowE = band(80, 300);     // sonoridade (f0 e harmônicos graves)
    const voiceE = band(250, 3300); // faixa útil da fala
    const level = Math.min(1, voiceE * 2.6);

    /* F1 e F2 por PICO, não por razão de bandas: em vogais posteriores (/u/, /o/)
       o F2 fica em ~750-950 Hz e invadiria qualquer faixa fixa de F1, fazendo a
       boca parecer aberta quando está arredondada. Buscar F2 acima de F1 evita
       isso e é como fonética mede vogais de verdade. */
    const P1 = pico(240, 1000);
    const P2 = pico(Math.max(P1.hz + 260, 700), 3300);
    const f1 = P1.hz || 500, f2 = P2.hz || 1400;

    const norm = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    // eixo 1 — ABERTURA: F1 de ~270 Hz (fechada /i,u/) a ~780 Hz (aberta /a/)
    const open = norm(f1, 270, 780);
    // eixo 2 — ANTERIORIDADE: F2 de ~700 Hz (arredondada /u,o/) a ~2400 Hz (esticada /i/)
    const front = norm(f2, 700, 2400);

    // sonoridade: vogais têm energia grave forte; sibilantes quase não têm
    const voiced = Math.min(1, (lowE * 2.4) / (sibE + 0.05));
    const sib = Math.min(1, (sibE / (voiceE * 0.5 + 0.02)) * 0.9);

    // transiente (oclusiva P/B/T/K): subida abrupta de energia após um vale
    const dE = level - lipState.prevE;
    lipState.prevE = level;
    if (level < 0.06) lipState.silMs += 16; else lipState.silMs = 0;
    if (dE > 0.12 && lipState.silMs === 0) lipState.burst = 1;
    lipState.burst = Math.max(0, lipState.burst - 0.14);

    return {
      level, open, front, voiced,
      sib,
      fric: Math.min(1, (fricE / (voiceE + 1e-5)) * (1 - voiced) * 1.6),
      burst: lipState.burst,
    };
  };

  /* ── espectro de frequência refinado (p/ o anel laranja em volta da esfera) ── */
  ELX.audio.spectrum = function (bins = 96) {
    const out = new Array(bins);
    if (simOn) {
      const t = performance.now() / 1000;
      for (let i = 0; i < bins; i++) {
        out[i] = Math.max(0, 0.28 * Math.sin(i * 0.4 + t * 5) + 0.22 * Math.sin(i * 0.13 + t * 2.6) + Math.random() * 0.1);
      }
      return out;
    }
    if (!analyser) return out.fill(0);
    analyser.getByteFrequencyData(freqData);
    const src = Math.min(freqData.length, 150); // faixa de voz
    for (let i = 0; i < bins; i++) {
      const a = Math.floor((i / bins) * src), b = Math.max(a + 1, Math.floor(((i + 1) / bins) * src));
      let s = 0; for (let j = a; j < b; j++) s += freqData[j];
      out[i] = Math.min(1, (s / ((b - a) * 255)) * 1.5);
    }
    return out;
  };

  /* ── limpeza de texto p/ fala ── */
  function stripForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' trecho de código exibido na interface. ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_#`>|~]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4200);
  }

  /* ═════════ FILA TTS (com hold p/ streaming frase-a-frase) ═════════ */
  const queue = [];
  let speaking = false;
  let holdOpen = false;   // true enquanto o agente ainda está gerando frases
  let genSeq = 0;         // invalida reproduções pendentes após stop()

  function ensurePlayer() {
    if (player) return player;
    player = new Audio();
    player.crossOrigin = 'anonymous';
    const src = ensureCtx().createMediaElementSource(player);
    src.connect(analyser);
    src.connect(lipAn);            // mesmo sinal, tap próprio p/ o lip-sync
    src.connect(ctx.destination);
    return player;
  }

  function maybeFinishSpeaking() {
    if (speaking || queue.length || holdOpen) return;
    if (conv.on) { if (ELX.state === 'speaking') ELX.setState('idle'); resumeListen(); }
    else if (ELX.state === 'speaking') ELX.setState('idle');
  }

  /* pré-sintetiza a próxima frase enquanto a atual toca → sem pausas entre frases */
  const prefetched = new Set();
  function prefetch(text) {
    if (!text || prefetched.has(text)) return;
    if (prefetched.size > 60) prefetched.clear();
    prefetched.add(text);
    fetch('/api/tts?' + new URLSearchParams({ text, ...VOICE_CFG })).then(r => r.blob()).catch(() => {});
  }

  async function playNext() {
    const text = queue.shift();
    if (text == null) { speaking = false; maybeFinishSpeaking(); return; }
    speaking = true;
    const mySeq = genSeq;
    ELX.setState('speaking');
    try {
      // streaming progressivo: o áudio toca enquanto o servidor ainda sintetiza
      const p = ensurePlayer();
      const qs = new URLSearchParams({ text, ...VOICE_CFG, _: Date.now().toString(36) });
      p.onended = () => { if (mySeq === genSeq) playNext(); };
      p.onerror = () => {
        if (mySeq !== genSeq) return;
        console.warn('[voice] stream TTS falhou, usando voz local');
        fallbackSpeak(text).finally(() => { if (mySeq === genSeq) playNext(); });
      };
      p.src = '/api/tts?' + qs.toString();
      if (queue[0]) prefetch(queue[0]); // aquece a próxima frase em paralelo
      await p.play();
    } catch (e) {
      if (mySeq !== genSeq) return;
      console.warn('[voice] TTS servidor falhou, usando voz local:', e.message);
      fallbackSpeak(text).finally(() => { if (mySeq === genSeq) playNext(); });
    }
  }

  function fallbackSpeak(text) {
    return new Promise(resolve => {
      if (!window.speechSynthesis) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR'; u.rate = 0.95; u.pitch = 0.72;
      const voices = speechSynthesis.getVoices();
      u.voice =
        voices.find(v => /pt[-_]BR/i.test(v.lang) && /antonio|daniel|male|masculin/i.test(v.name)) ||
        voices.find(v => /pt[-_]BR/i.test(v.lang)) || null;
      u.onstart = () => { simOn = true; };
      u.onend = u.onerror = () => { simOn = false; resolve(); };
      speechSynthesis.speak(u);
    });
  }

  /** enfileira fala (pode ser chamado frase-a-frase durante o streaming) */
  function speak(text) {
    const clean = stripForSpeech(text);
    if (!clean) return;
    const parts = [];
    let buf = '';
    for (const s of clean.split(/(?<=[.!?…])\s+/)) {
      if ((buf + ' ' + s).length > 420) { if (buf) parts.push(buf); buf = s; }
      else buf = buf ? buf + ' ' + s : s;
    }
    if (buf) parts.push(buf);
    queue.push(...parts);
    if (!speaking) playNext();
    else if (queue[0]) prefetch(queue[0]); // já deixa a próxima pronta
  }

  /** segura/solta o encerramento do estado de fala enquanto há geração em curso */
  function hold(open) {
    holdOpen = !!open;
    if (!open) maybeFinishSpeaking();
  }

  function stopSpeak() {
    genSeq++;                       // invalida tudo que está em voo
    queue.length = 0;
    holdOpen = false;
    if (player) {
      try {
        player.onended = null; player.onerror = null;
        player.pause();
        player.removeAttribute('src'); player.load(); // aborta o download do stream
      } catch {}
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    simOn = false;
    speaking = false;
    if (ELX.state === 'speaking') ELX.setState('idle');
  }

  /* ═════════ STT — reconhecimento de voz ═════════ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, sttActive = false;
  // escuta suspensa (cadastro de voz, vídeo no monitor) — declarada AQUI porque
  // startSTT() logo abaixo a consulta; suspendListening/resumeListening usam a mesma
  let listenSuspended = false, suspendedConv = false, suspendedLive = false;
  const micBtn = document.getElementById('micBtn');
  const cmd = document.getElementById('cmd');

  function startSTT() {
    if (!SR) return ELX.toast?.('Reconhecimento de voz não suportado. Use Chrome ou Edge.', 'red');
    /* TRAVA DA SUSPENSÃO — precisa ficar AQUI, não em quem chama.
       O laço da conversa religa o STT sozinho por temporizador (~300ms) em
       dois pontos. Sem esta linha, suspendListening() era desfeito logo em
       seguida e a escuta voltava: no cadastro de voz o VAD interrompia a
       própria pessoa sendo gravada, e no monitor o áudio do vídeo vazava de
       volta para o agente. resumeListening() limpa a flag ANTES de chamar,
       então o retorno normal continua funcionando. */
    if (listenSuspended) return;
    if (sttActive) return;
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    sttActive = true;
    ELX.setState('listening');

    let finalText = '';
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      cmd.value = finalText + interim;
      cmd.placeholder = 'escutando…';
    };
    rec.onend = () => {
      sttActive = false;
      const t = (finalText || cmd.value).trim();
      cmd.value = '';
      cmd.placeholder = 'transmita seu comando, Senhor…';
      if (t) {
        ELX.agent?.send(t);
      } else if (conv.on) {
        // silêncio — religa a escuta para manter a conversa aberta
        if (ELX.state === 'listening') setTimeout(() => { if (conv.on && !sttActive && ELX.state === 'listening') startSTT(); }, 350);
      } else if (ELX.state === 'listening') {
        ELX.setState('idle');
      }
    };
    rec.onerror = ev => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        ELX.toast?.('Microfone bloqueado pelo navegador.', 'red');
        convStop();
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        console.warn('[stt]', ev.error);
      }
    };
    try { rec.start(); } catch { sttActive = false; }
  }
  function stopSTT() { try { rec?.abort(); } catch {} sttActive = false; }

  function resumeListen() {
    if (conv.on && !sttActive && !speaking && !queue.length) {
      setTimeout(() => { if (conv.on && !sttActive && !speaking) startSTT(); }, 280);
    }
  }

  /* ═════════ VAD — barge-in (interromper o agente falando) ═════════ */
  const vad = { stream: null, an: null, data: null, raf: 0, floor: 0.01, voiceMs: 0, last: 0 };

  async function vadStart() {
    if (vad.stream) return;
    try {
      vad.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const c = ensureCtx();
      vad.an = c.createAnalyser();
      vad.an.fftSize = 1024;
      vad.data = new Uint8Array(vad.an.fftSize);
      c.createMediaStreamSource(vad.stream).connect(vad.an); // tap isolado — não toca nos alto-falantes
      vad.last = performance.now();
      vadLoop();
    } catch (e) {
      ELX.toast?.('Sem acesso ao microfone para o modo conversa: ' + e.message, 'red');
    }
  }
  function vadStop() {
    cancelAnimationFrame(vad.raf);
    vad.stream?.getTracks().forEach(t => t.stop());
    vad.stream = null; vad.an = null; vad.voiceMs = 0;
  }

  function vadLoop() {
    vad.raf = requestAnimationFrame(vadLoop);
    if (!vad.an) return;
    const now = performance.now();
    const dt = Math.min(now - vad.last, 80);
    vad.last = now;

    vad.an.getByteTimeDomainData(vad.data);
    let sum = 0;
    for (let i = 0; i < vad.data.length; i += 2) { const v = vad.data[i] / 128 - 1; sum += v * v; }
    const rms = Math.sqrt(sum / (vad.data.length / 2));

    // piso de ruído adaptativo (sobe devagar, desce rápido)
    vad.floor = rms < vad.floor ? vad.floor * 0.95 + rms * 0.05 : Math.min(vad.floor * 1.004, 0.05);

    const interruptible = ELX.state === 'speaking' || ELX.state === 'thinking';
    if (!interruptible) { vad.voiceMs = 0; return; }

    // limiar mais exigente enquanto o agente fala (resíduo de eco)
    const thresh = Math.max(vad.floor * (ELX.state === 'speaking' ? 4.2 : 3.2), 0.022);
    if (rms > thresh) {
      vad.voiceMs += dt;
      if (vad.voiceMs > 320) { vad.voiceMs = 0; bargeIn(); }
    } else {
      vad.voiceMs = Math.max(0, vad.voiceMs - dt * 1.6);
    }
  }

  /** operador falou por cima → corta a fala/geração e escuta na hora */
  function bargeIn() {
    if (!conv.on) return;
    ELX.agent?.interrupt('barge-in');
    stopSTT();          // garante instância limpa
    startSTT();         // já captura o início da fala do operador
  }

  /* ═════════ MODO CONVERSA (toggle no botão do mic) ═════════ */
  const conv = { on: false };

  async function convStart() {
    ensureCtx();
    conv.on = true;
    micBtn.classList.add('on');
    micBtn.title = 'modo conversa ATIVO — clique para encerrar';
    await vadStart();
    if (!vad.stream) { convStop(); return; }
    ELX.toast?.('Modo conversa ativo. Fale naturalmente — pode me interromper a qualquer momento, Senhor.', 'green');
    document.getElementById('ledVoice')?.classList.add('on');
    if (ELX.state === 'idle' || ELX.state === 'boot') startSTT();
  }
  function convStop() {
    conv.on = false;
    micBtn.classList.remove('on');
    micBtn.title = 'modo conversa (escuta contínua com interrupção)';
    stopSTT();
    vadStop();
    if (ELX.state === 'listening') ELX.setState('idle');
  }
  micBtn.addEventListener('click', () => (conv.on ? convStop() : convStart()));

  /* ═════════ LIVE — OpenAI Realtime (WebRTC full-duplex) ═════════ */
  const liveBtn = document.getElementById('liveBtn');
  const live = { on: false, pc: null, mic: null, audio: null };

  /** executor das ferramentas do modo LIVE — grava nos mesmos arquivos e atualiza a tela */
  async function liveExecTool(name, a) {
    /* Alimenta o diário de atividade do ELION. No AO VIVO quem executa é o
       navegador, então o servidor não vê a chamada — sem este aviso, tudo que
       o operador faz POR VOZ ficaria fora da memória de trabalho dele.
       Dispara sem esperar: registro nunca pode atrasar a resposta falada. */
    fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, modo: 'live' }) }).catch(() => {});
    try {
      switch (name) {
        case 'agenda_add': {
          const r = await fetch('/api/agenda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...a, origin: 'agente' }) }).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          ELX.agenda?.render(r.items);
          return `Compromisso registrado (id ${r.item.id}): ${r.item.title} em ${r.item.date} às ${r.item.time}${r.item.location ? ' @ ' + r.item.location : ''}. Visível no quadrante AGENDA.`;
        }
        case 'agenda_update': {
          const r = await fetch('/api/agenda', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }).then(x => x.json());
          if (!r.item) return `ERRO: id ${a.id} não encontrado.`;
          ELX.agenda?.render(r.items);
          return `Compromisso atualizado: ${r.item.title} em ${r.item.date} às ${r.item.time}${r.item.location ? ' @ ' + r.item.location : ''}.`;
        }
        case 'agenda_remove': {
          const r = await fetch(`/api/agenda?id=${encodeURIComponent(a.id)}`, { method: 'DELETE' }).then(x => x.json());
          ELX.agenda?.render(r.items || []);
          return r.ok ? 'Compromisso removido.' : 'ERRO: id não encontrado.';
        }
        case 'agenda_list': {
          const { items } = await fetch('/api/agenda').then(x => x.json());
          ELX.agenda?.render(items);
          if (!items.length) return 'Agenda vazia — nenhum compromisso registrado.';
          return items.map(i =>
            `[id ${i.id}] ${i.date} às ${i.time} — ${i.title}${i.location ? ' @ ' + i.location : ''}${i.notes ? ' (obs: ' + i.notes + ')' : ''}${i.origin === 'manual' ? ' ‹digitado manualmente pelo operador›' : ''}`
          ).join('\n');
        }
        case 'memory_save': {
          const r = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }).then(x => x.json());
          return r.error ? 'ERRO: ' + r.error : `Memória gravada (id ${r.item.id}).`;
        }
        case 'get_weather': {
          // sem cidade → posição GPS do computador do operador (assertividade máxima)
          const u = a.location ? `/api/weather?q=${encodeURIComponent(a.location)}`
            : (ELX.geo ? `/api/weather?lat=${ELX.geo.lat}&lon=${ELX.geo.lon}` : '/api/weather');
          const p = await fetch(u).then(x => x.json());
          if (p.error) return 'ERRO: ' + p.error;
          ELX.clima?.render(p);
          const dias = p.days.slice(0, 3).map(d => `${d.date}: ${d.desc}${d.oficial ? ' (fonte oficial)' : ''} ${d.min}-${d.max}°C chuva ${d.rain}%`).join('; ');
          return `Clima em ${p.city}${p.region ? ', ' + p.region : ''} (${p.country})${p.viaGPS ? ' — posição ATUAL via GPS' : ''}: ${p.current.desc}, ${p.current.temp}°C (sensação ${p.current.feels}°C), umidade ${p.current.humidity}%, vento ${p.current.wind} km/h. ` +
            (p.nextRain ? `Próxima chuva provável às ${p.nextRain.hora} (${p.nextRain.prob}%). ` : 'Sem chuva nas próximas horas. ') +
            `UV máx ${p.uv != null ? Math.round(p.uv) : '—'}, sol ${p.sunrise}–${p.sunset}. Fonte: ${p.fonte}. Próximos dias: ${dias}`;
        }
        case 'get_ai_news': {
          const { items } = await fetch('/api/news?limit=8').then(x => x.json());
          ELX.news?.render(items);
          return items.slice(0, a.limit || 6).map((n, i) => `${i + 1}. [${n.src}] ${n.title}`).join('\n') || 'Sem notícias no momento.';
        }
        case 'investigate_news': {
          const r = await fetch(`/api/investigate?q=${encodeURIComponent(a.topic)}&days=${a.days || 7}&region=${encodeURIComponent(a.region || '')}`).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          if (r.items?.length) ELX.news?.render(r.items);
          return (r.answer ? `Síntese: ${r.answer}\n` : '') +
            r.items.slice(0, 6).map((n, i) => `${i + 1}. [${n.src}] ${n.title}`).join('\n') +
            '\n(Resultados exibidos no quadrante NOTÍCIAS.)';
        }
        case 'open_website': {
          if (!/^https?:\/\//i.test(a.url || '')) return 'ERRO: URL inválida.';
          ELX.web?.open(a.url, a.title || '');
          return 'Site aberto no Visor Web, no canto da interface.';
        }
        case 'wa_list_chats': {
          const r = await fetch('/api/whatsapp/chats?limit=' + (a.limit || 12)).then(x => x.json());
          if (r.error) return 'WhatsApp: ' + r.error;
          return (r.chats || []).map((c, i) => `${i + 1}. ${c.unread ? '(' + c.unread + ' não lidas) ' : ''}${c.name}: ${c.last}`).join('\n') || 'Sem conversas.';
        }
        case 'wa_send_message': {
          const s = await fetch('/api/whatsapp/status').then(x => x.json());
          if (!s.connected) return 'WhatsApp não conectado.';
          const r = await fetch('/api/whatsapp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: a.to, text: a.text }) }).then(x => x.json());
          return r.ok ? `Mensagem enviada para ${a.to}: "${a.text}"` : 'ERRO ao enviar: ' + (r.error || 'falha');
        }
        case 'wa_read_chat': {
          const depth = Math.min(Math.max(a.limit || 20, 5), 300);
          const r = await fetch(`/api/whatsapp/read?q=${encodeURIComponent(a.query || '')}&limit=${depth}`).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error + ' — tente wa_find_contact para achar o nome exato.';
          const c = r.chat;
          return `Conversa com ${c.name} (${c.messages.length} msgs):\n` + c.messages.filter(m => m.body).map(m => `${m.fromMe ? 'Eu' : c.name}: ${m.body}`).join('\n') + '\nResgate para o operador o que ele pediu.';
        }
        case 'wa_find_contact': {
          const r = await fetch(`/api/whatsapp/find?q=${encodeURIComponent(a.query || '')}`).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          if (!r.candidates.length) return `Nenhum contato parecido com "${a.query}". Peça o nome como está salvo ou o número.`;
          return 'Candidatos (mais provável primeiro): ' + r.candidates.map((c, i) => `${i + 1}. ${c.name} (${c.number || c.id})${c.hasChat ? '' : ' — sem conversa'}`).join('; ') + '. Se houver dúvida entre dois, confirme com o operador.';
        }
        case 'wa_allow': {
          const act = (a.action || 'list').toLowerCase();
          if (act === 'list') {
            const r = await fetch('/api/whatsapp/allow').then(x => x.json());
            return r.allow.length ? 'Liberados p/ auto-resposta: ' + r.allow.map(x => x.name).join(', ') : 'Nenhum contato liberado ainda.';
          }
          if (act === 'add') {
            const r = await fetch('/api/whatsapp/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: a.query }) }).then(x => x.json());
            if (r.error) return 'ERRO: ' + r.error;
            return r.results.join('\n') + '\nRelate ao operador quem foi autorizado e o que aprendi de cada relacionamento; se algum ficou ambíguo, pergunte qual candidato é.';
          }
          if (act === 'remove') {
            const f = await fetch(`/api/whatsapp/find?q=${encodeURIComponent(a.query || '')}`).then(x => x.json());
            const allow = (await fetch('/api/whatsapp/allow').then(x => x.json())).allow || [];
            const alvo = (f.candidates || []).find(c => allow.some(x => x.id === c.id));
            if (!alvo) return `Não encontrei "${a.query}" entre os liberados (${allow.map(x => x.name).join(', ') || 'nenhum'}).`;
            await fetch(`/api/whatsapp/allow?id=${encodeURIComponent(alvo.id)}`, { method: 'DELETE' });
            return `Contato ${alvo.name} removido da auto-resposta.`;
          }
          return 'Ação inválida (add, remove ou list).';
        }
        case 'wa_auto_reply': {
          const r = await fetch('/api/whatsapp/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !!a.on }) }).then(x => x.json());
          return `Resposta automática do WhatsApp ${r.autoReply ? 'ligada' : 'desligada'}.`;
        }
        case 'council_review': {
          const c = await fetch('/api/council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: a.question, context: a.context || '', mode: a.mode || 'jury', confidence: !!a.confidence, adaptive: !!a.adaptive, measureDiversity: !!a.measureDiversity }) }).then(x => x.json());
          if (c.error) return 'O conselho não pôde deliberar: ' + c.error;
          ELX.council?.render(c);
          const extra = (c.tally ? ` Placar ponderado por confiança: Sim ${c.tally.weights.Sim}, Não ${c.tally.weights['Não']}, Depende ${c.tally.weights.Depende} (líder ${c.tally.leader}).` : '')
            + (c.convergence ? ` Convergiu em ${c.convergence.rounds} rodada(s) (${c.convergence.motivo}).` : '')
            + (c.diversity ? ` Diversidade ${c.diversity.nivel}: ${c.diversity.texto}` : '');
          return `Veredito do conselho (modo ${c.mode}):\n${c.verdict}${extra}\n(Raciocínio completo no Visor.) Apresente a decisão final ao operador.`;
        }
        case 'analyze_market': {
          const symbol = (a.symbol || '').trim();
          if (!symbol) return 'Informe o ativo, Senhor (ex.: AAPL, BTCUSD, PETR4).';
          ELX.market?.set(symbol);
          const d = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`).then(x => x.json()).catch(() => ({ error: 'falha' }));
          if (d.error) return `O gráfico de ${symbol.toUpperCase()} foi aberto no quadrante MERCADO, mas os dados ao vivo não vieram. Descreva educativamente o que dá para observar e lembre que é conteúdo educativo, não recomendação.`;
          ELX.market?.note(`${d.symbol} · ${d.price} ${d.currency} (${d.changePct >= 0 ? '+' : ''}${d.changePct}%) · tend. ${d.trend} · RSI ${d.rsi14 ?? '—'}`);
          return `Dados EDUCATIVOS de ${d.name} (${d.symbol}): preço ${d.price} ${d.currency}, variação ${d.changePct}% no dia, tendência ${d.trend}, SMA20 ${d.sma20}, SMA50 ${d.sma50}, RSI ${d.rsi14}, faixa recente ${d.low60} a ${d.high60}. Explique de forma EDUCATIVA o que isso indica (tendência, RSI sobrecompra acima de 70 / sobrevenda abaixo de 30, suportes/resistências) e ENCERRE lembrando que é leitura educativa, não recomendação de investimento. NUNCA diga para comprar/vender nem indique o "melhor" ativo.`;
        }
        case 'portfolio_add': {
          if (!a.titulo) return 'Qual investimento devo registrar, Senhor? Ex.: Tesouro Selic 2029.';
          const r = await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }).then(x => x.json()).catch(() => ({}));
          if (!r.ok) return 'Não consegui registrar na carteira agora.';
          ELX.portfolio?.render(r.items);
          return `Registrei ${a.titulo} na carteira${a.valor ? `, R$ ${a.valor}` : ''}, Senhor. Confirme com discrição. É informativo, não recomendação.`;
        }
        case 'portfolio_remove': {
          const r = await fetch(`/api/portfolio?ref=${encodeURIComponent(a.ref || '')}`, { method: 'DELETE' }).then(x => x.json()).catch(() => ({}));
          ELX.portfolio?.render(r.items || []);
          return r.ok ? 'Removido da carteira, Senhor.' : 'Não encontrei esse item na carteira.';
        }
        case 'portfolio_view': {
          const r = await fetch('/api/portfolio').then(x => x.json()).catch(() => ({ items: [] }));
          ELX.portfolio?.render(r.items);
          if (!r.items || !r.items.length) return 'Sua carteira está vazia, Senhor. Quer que eu registre suas aplicações?';
          return `Carteira (educativo, não recomendação): ${r.items.map(i => `${i.titulo}${i.valor ? ` R$ ${i.valor}` : ''}`).join('; ')}. Total R$ ${r.total}. Apresente em fala natural; para a taxa de hoje, ofereça buscar na internet.`;
        }
        case 'ia_sem_medo': {
          const d = await fetch('/api/ia-sem-medo').then(x => x.json()).catch(() => null);
          if (d && d.url) ELX.web?.open(d.url, 'IA SEM MEDO · Advanced Tech TI');
          const focus = (a.focus || 'geral');
          if (!d || !d.kb) return 'Abri o site do curso IA SEM MEDO no Visor, Senhor. Posso te apresentar os 8 módulos, a parte "Sobre o curso" ou para quem serve.';
          return `${d.kb}\n\nFOCO: ${focus}. O site já ABRIU no Visor. Seja o GAROTO-PROPAGANDA do IA SEM MEDO: fale com energia e clareza (voz — sem listas), diga que abriu o site, faça o resumo vendedor e ofereça aprofundar em módulos, "Sobre o curso" (níveis avançados: Lovable/Manus/Gemini/Agentes) ou para quem serve. Seja fiel ao conteúdo; não invente preços.`;
        }
        case 'get_emails': {
          const r = await fetch(`/api/email?q=${encodeURIComponent(a.query || '')}&max=${a.max || 8}`).then(x => x.json());
          if (!r.connected) return 'Gmail não conectado. O operador precisa clicar em EMAIL na plataforma para autorizar.';
          if (r.error) return 'ERRO ao ler emails: ' + r.error;
          ELX.email?.render(r.items);
          return r.items.length
            ? r.items.map((e, i) => `${i + 1}. ${e.unread ? '(não lido) ' : ''}De ${e.from}: ${e.subject} — ${e.snippet}`).join('\n')
            : 'Nenhum email encontrado.';
        }
        case 'read_email': {
          if (!a.id) return 'Preciso do id do email — use get_emails antes para listá-los.';
          const r = await fetch(`/api/email?id=${encodeURIComponent(a.id)}`).then(x => x.json());
          if (!r.connected) return 'Gmail não conectado. O operador precisa clicar em EMAIL na plataforma para autorizar.';
          if (r.error) return 'ERRO ao abrir o email: ' + r.error;
          const m = r.mail || {};
          return `De: ${m.from}\nAssunto: ${m.subject}\nData: ${m.date}\n\n${(m.body || '').slice(0, 4000)}`;
        }
        case 'switch_camera': {
          try {
            const r = await ELX.cam.switchByHint(a.target || 'externa');
            return r.ok ? `Câmera alternada para: ${r.msg}. A visão computacional usará essa câmera de alta definição.` : 'Não foi possível trocar a câmera: ' + r.msg;
          } catch (e) { return 'ERRO ao trocar de câmera: ' + e.message; }
        }
        /* DOCUMENTOS NO AO VIVO. Antes: '/api/document?text=1' sempre, e a rota
           devolvia calada os primeiros 40 mil caracteres — num PDF de 300
           páginas o ELION falado analisava 13% e concluía como se tivesse lido
           tudo. Agora tem os mesmos dois modos do texto: busca no documento
           INTEIRO (query) e leitura paginada com aviso de continuação. */
        case 'read_document': {
          const q = String(a.query || '').trim();
          const parte = Math.max(parseInt(a.parte, 10) || 1, 1);
          const u = q ? `/api/document?query=${encodeURIComponent(q)}`
                      : `/api/document?text=1&parte=${parte}`;
          const d = await fetch(u).then(x => x.json());
          if (!d.active) return 'Nenhum documento ativo. Peça ao operador para enviar um documento pelo botão DOC da plataforma.';
          const cab = `Documento "${d.name}"${d.pages ? ` (${d.pages} págs)` : ''} · ${d.chars} caracteres`;
          if (q) {
            if (!d.ocorrencias) return `${cab} · busca por "${q}": nenhuma ocorrência literal. Tente outra palavra/sinônimo, ou leia por partes (parte:1 a ${d.totalPartes}).`;
            return `${cab} · busca por "${q}" · ${d.ocorrencias} trecho(s):\n\n${d.text}\n\n` +
              'Responda a partir DESTES trechos, citando de que parte veio cada fato. Na fala, seja breve: a conclusão e o número/cláusula que a sustenta.';
          }
          return `${cab}${d.totalPartes > 1 ? ` · PARTE ${d.parte} de ${d.totalPartes}` : ''}:\n\n${d.text || ''}` +
            (d.aviso ? `\n\n⚠ ${d.aviso} NUNCA diga que leu o documento inteiro sem chegar à última parte — se o operador quer só um ponto específico, prefira chamar de novo com query.` : '');
        }
        case 'enroll_face': {
          try {
            if (!a.name || !String(a.name).trim()) return 'ERRO: preciso do NOME da pessoa antes de memorizar o rosto — pergunte quem é e chame de novo com o nome.';
            const r = await ELX.cam.enroll(a.name, a.relation || '');
            return r.ok ? `Rosto de ${a.name} memorizado no reconhecimento facial.` : 'Não consegui memorizar: ' + r.msg;
          } catch (e) { return 'ERRO ao cadastrar rosto: ' + e.message; }
        }
        case 'enroll_voice': {
          // no modo AO VIVO o microfone já está aberto: avisa e escuta em seguida
          try {
            const seg = Math.min(Math.max(a.seconds || 3, 2), 8);
            // sem nome NÃO cadastra: o fallback 'pessoa' criava um perfil-fantasma
            // que competia com os reais na identificação (ficou a 4 Hz do Theo)
            if (!a.name || !String(a.name).trim()) return 'ERRO: preciso do NOME da pessoa antes de memorizar a voz — pergunte com quem fala e chame de novo com o nome.';
            const r = await ELX.voiceid.enroll(a.name, a.relation || '', seg * 1000, { usarUltima: !!a.use_last_voice });
            return r.ok
              ? `Voz de ${a.name} memorizada (${r.msg}). Confirme com naturalidade — daqui em diante você a reconhece.`
              : `Não consegui memorizar a voz: ${r.msg}. Peça para falar mais e mais perto do microfone.`;
          } catch (e) { return 'ERRO ao cadastrar a voz: ' + e.message; }
        }
        case 'identify_voice': {
          try {
            const seg = Math.min(Math.max(a.seconds || 2, 1), 6);
            const r = await ELX.voiceid.identify(seg * 1000);
            return ELX.voiceid.descrever(r) || 'Não consegui identificar — peça para a pessoa falar um pouco mais.';
          } catch (e) { return 'ERRO ao identificar a voz: ' + e.message; }
        }
        /* VIGILÂNCIA e INVESTIGAÇÃO — no modo LIVE quem executa é o navegador.
           Estavam anunciadas ao modelo sem executor aqui: ele chamava, não
           recebia nada e dizia ao operador que o modo estava fora do ar. */
        case 'watch_check': {
          const u = '/api/watch?acao=check' + (a.varrer ? '&varrer=1' : '');
          const r = await fetch(u).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          if (!r.total) {
            return r.alvos
              ? `Nenhuma novidade nos ${r.alvos} temas sob vigilância. Última varredura: ${r.ultimaVarredura || 'ainda não rodou'}. Diga isso de forma breve — nada novo é boa notícia, sem rodeio.`
              : 'Nenhum tema sob vigilância ainda. Ofereça colocar os clientes e assuntos dele em monitoramento.';
          }
          return r.texto + '\n\nRelate em fala natural, do mais relevante para o menos. Destaque PRAZOS (licitação com data de encerramento é urgente) e o que ainda não virou notícia.';
        }
        case 'watch_add': {
          const termo = String(a.termo || '').trim();
          if (!termo) return 'ERRO: informe o que devo colocar sob vigilância.';
          const r = await fetch('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termo, fontes: a.fontes, uf: a.uf }) }).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          return r.jaExistia
            ? `"${termo}" já estava sob vigilância. Confirme e ofereça mostrar as novidades.`
            : `Vigilância ativada para "${termo}" — agora são ${r.total} temas. Estou registrando o que JÁ existe como histórico; daqui em diante só aviso o que for NOVO. Varre sozinho a cada 3 horas.`;
        }
        case 'watch_manage': {
          const act = String(a.action || 'list').toLowerCase();
          if (act === 'remove') {
            const r = await fetch(`/api/watch?termo=${encodeURIComponent(a.termo || '')}`, { method: 'DELETE' }).then(x => x.json());
            return r.ok ? `Removido da vigilância. Restam ${r.total} temas.` : `Não encontrei "${a.termo}" na vigilância.`;
          }
          const r = await fetch('/api/watch?acao=list').then(x => x.json());
          if (!r.total) return 'Nenhum tema sob vigilância ainda.';
          return `${r.total} temas sob vigilância: ${r.alvos.map(x => x.termo).join(', ')}. ` +
            `${r.pendentes ? r.pendentes + ' novidade(s) pendente(s).' : 'Sem novidades pendentes.'} Última varredura: ${r.ultimaVarredura || 'ainda não rodou'}.`;
        }
        case 'lottery_simulate': {
          const q = new URLSearchParams({ game: a.game || '' });
          if (a.draws)    q.set('draws', a.draws);
          if (a.strategy) q.set('strategy', a.strategy);
          if (a.count)    q.set('count', a.count);
          if (a.numbers)  q.set('numbers', a.numbers);
          if (Array.isArray(a.fixed)   && a.fixed.length)   q.set('fixed', a.fixed.join(','));
          if (Array.isArray(a.exclude) && a.exclude.length) q.set('exclude', a.exclude.join(','));
          const r = await fetch('/api/lottery-sim?' + q).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          ELX.lotterySim?.render?.(r);
          return r.relatorio +
            '\n\nNarre como um matemático honesto explicando a um colega. A DECLARAÇÃO OBRIGATÓRIA é inegociável — diga-a com suas palavras, sem suavizar. Se ele quiser vantagem REAL, recomende a estratégia "antipopular" e explique: mesma chance de ganhar, menor chance de dividir.';
        }
        case 'deep_investigate': {
          const q = String(a.termo || a.query || '').trim();
          if (!q) return 'ERRO: informe o que devo investigar.';
          const r = await fetch(`/api/deep-investigate?q=${encodeURIComponent(q)}` +
            `${a.fontes ? '&fontes=' + encodeURIComponent(a.fontes) : ''}${a.uf ? '&uf=' + encodeURIComponent(a.uf) : ''}`).then(x => x.json());
          if (r.error) return 'ERRO: ' + r.error;
          if (r.noticias?.length) ELX.news?.render?.(r.noticias.map(n => ({ src: n.fonte, title: n.titulo, link: n.url, ts: Date.now() })));
          return r.relatorio + '\n\nApresente em fala natural, separando REGISTRO OFICIAL de COBERTURA DE IMPRENSA. Destaque o que ainda NÃO virou notícia — é aí que está o valor.';
        }
        case 'analyze_camera': {
          try {
            const d = await ELX.cam.analyze({ prompt: a.focus || '', speak: false });
            const subs = (d.subjects || []).map(s => s.type === 'pessoa'
              ? `${s.label || 'pessoa'}: ~${s.age || '?'}, ${s.emotion || '?'}, ${s.behavior || ''}`
              : `${s.label || s.type}`).join('; ');
            return `Visão computacional concluída e exibida no monitor. Pessoas: ${d.scene?.peopleCount ?? 0}, animais: ${d.scene?.animalCount ?? 0}. ${subs ? 'Detecções: ' + subs + '. ' : ''}Narração: "${d.narration}". Repasse ao operador com naturalidade.`;
          } catch (e) {
            return 'ERRO ao acessar a câmera: ' + e.message;
          }
        }
        case 'open_screen': {
          const canon = s => {
            const t = String(s || '').toLowerCase().trim();
            if (!t) return '';
            if (/\btudo\b|todas|geral/.test(t)) return 'all';
            if (/c[âa]m[ae]ra|vis[ãa]o|olho|sensor [óo]ptico|webcam/.test(t)) return 'camera';
            if (/whats|zap/.test(t)) return 'whatsapp';
            if (/not[íi]cia|news|manchete|jornal|\bintel\b/.test(t)) return 'noticias';
            if (/clima|tempo|previs[ãa]o|meteoro/.test(t)) return 'clima';
            if (/agenda|compromisso|calend[áa]rio/.test(t)) return 'agenda';
            if (/segundo c[ée]rebro|c[ée]rebro|cerebro|painel de controle|painel de segundo|\bbrain\b|grafo de n/.test(t)) return 'brain';
            if (/mercado|investiment|a[çc][õo]es|bolsa|mapa de a[çc]|trading|cripto|ticker|\bativo\b|gr[áa]fico/.test(t)) return 'market';
            if (/carteira|portf[óo]lio|aplica[çc]|tesouro/.test(t)) return 'carteira';
            if (/e-?mail|gmail|caixa de entrada|correio/.test(t)) return 'email';
            if (/conselho|council|tribunal|war ?room|delibera/.test(t)) return 'conselho';
            if (/ia sem medo|meu curso|advancedtech|garoto.?propaganda/.test(t)) return 'curso';
            if (/\bsite\b|\bweb\b|navegador|p[áa]gina|\burl\b/.test(t)) return 'site';
            if (/tela|painel|visor|isso|essa|aberto|aberta|janela/.test(t)) return 'visor';
            return t;
          };
          const screen = canon(a.screen);
          const q = String(a.query || '').trim();
          switch (screen) {
            case 'camera': ELX.screens.open('camera'); return 'Câmera ativada no monitor óptico, Senhor — sensor ligado. Ainda não analisei a cena; se quiser saber o que estou vendo, é só pedir. Confirme que a câmera abriu.';
            case 'whatsapp': ELX.screens.open('whatsapp'); return 'Painel do WhatsApp aberto no Visor. Confirme ao operador.';
            case 'brain': ELX.screens.open('brain'); return 'Painel de Controle — Segundo Cérebro aberto. Confirme que o grafo de nós está na tela.';
            case 'market': {
              const symbol = (q || 'IBOV').toUpperCase().replace(/\s+/g, '');
              ELX.screens.open('market', { symbol });
              const d = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`).then(x => x.json()).catch(() => ({}));
              return `Investimentos — mapa de ações aberto em tela cheia para ${symbol}, Senhor. ${d && !d.error ? `Preço ${d.price} ${d.currency} (${d.changePct >= 0 ? '+' : ''}${d.changePct}%), tendência ${d.trend}, RSI ${d.rsi14 ?? '—'}. ` : ''}Faça a leitura EDUCATIVA e lembre que não é recomendação.`;
            }
            case 'carteira': { const r = await fetch('/api/portfolio').then(x => x.json()).catch(() => ({ items: [] })); ELX.portfolio?.render(r.items); return r.items && r.items.length ? 'Carteira aberta no Visor. Apresente as aplicações (educativo, não recomendação).' : 'Carteira aberta — está vazia. Ofereça registrar as aplicações.'; }
            case 'email': { const r = await fetch('/api/email?max=8').then(x => x.json()).catch(() => ({})); if (!r.connected) { ELX.email?.connect(); return 'O painel de e-mail precisa de conexão com o Gmail, Senhor. Iniciei o login se estiver configurado.'; } ELX.email?.render(r.items); return r.items && r.items.length ? 'Caixa de entrada aberta no Visor. ' + r.items.slice(0, 6).map((e, i) => `${i + 1}. ${e.unread ? '(não lido) ' : ''}${e.from}: ${e.subject}`).join('; ') : 'Caixa de entrada aberta — nenhum e-mail encontrado.'; }
            case 'noticias': { const { items } = await fetch('/api/news?limit=8').then(x => x.json()); ELX.news?.render(items); return 'Notícias abertas e atualizadas. ' + (items || []).slice(0, 6).map((n, i) => `${i + 1}. ${n.title}`).join('; '); }
            case 'clima': { const p = await fetch(`/api/weather?q=${encodeURIComponent(q || 'Santos')}`).then(x => x.json()); if (p.error) return 'ERRO: ' + p.error; ELX.clima?.render(p); return `Clima aberto: ${p.city}, ${p.current.desc}, ${p.current.temp}°C.`; }
            case 'agenda': { const { items } = await fetch('/api/agenda').then(x => x.json()); ELX.agenda?.render(items); return items.length ? 'Agenda aberta. ' + items.slice(0, 6).map(i => `${i.date} ${i.time} ${i.title}`).join('; ') : 'Agenda aberta — sem compromissos.'; }
            case 'conselho': ELX.screens.open('council'); return 'Abri o seletor do Conselho de Decisão. Se já tiver a decisão, posso convocar direto.';
            case 'curso': { const d = await fetch('/api/ia-sem-medo').then(x => x.json()).catch(() => null); if (d && d.url) ELX.web?.open(d.url, 'IA SEM MEDO · Advanced Tech TI'); return d && d.kb ? `${d.kb}\n\nO site abriu no Visor. Apresente como garoto-propaganda, fiel ao conteúdo.` : 'Abri o site do curso IA SEM MEDO no Visor, Senhor.'; }
            case 'site': { let u = q; if (!u) return 'Para abrir um site preciso do endereço, Senhor. Qual site abro?'; if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, ''); ELX.web?.open(u, ''); return `Site aberto no Visor: ${u}.`; }
            default: return `Não reconheci a tela "${a.screen}", Senhor. Posso abrir: câmera, whatsapp, notícias, clima, agenda, segundo cérebro, investimentos, carteira, e-mails, conselho ou o curso IA Sem Medo.`;
          }
        }
        case 'close_screen': {
          const canon = s => {
            const t = String(s || '').toLowerCase().trim();
            if (!t) return '';
            if (/\btudo\b|todas|geral/.test(t)) return 'all';
            if (/c[âa]m[ae]ra|vis[ãa]o|olho|sensor|webcam/.test(t)) return 'camera';
            if (/whats|zap/.test(t)) return 'whatsapp';
            if (/segundo c[ée]rebro|c[ée]rebro|cerebro|painel de controle|\bbrain\b|grafo/.test(t)) return 'brain';
            if (/mercado|investiment|a[çc][õo]es|bolsa|mapa de a[çc]|gr[áa]fico|ativo/.test(t)) return 'market';
            if (/carteira|portf[óo]lio|aplica[çc]/.test(t)) return 'carteira';
            if (/e-?mail|gmail|correio/.test(t)) return 'email';
            if (/conselho|council|tribunal/.test(t)) return 'conselho';
            if (/curso|ia sem medo/.test(t)) return 'curso';
            if (/not[íi]cia|clima|tempo|agenda|compromisso/.test(t)) return 'fixo';
            if (/\bsite\b|\bweb\b|p[áa]gina/.test(t)) return 'site';
            if (/tela|painel|visor|isso|essa|aberto|janela/.test(t)) return 'visor';
            return t;
          };
          const target = canon(a.target || a.screen);
          if (target === 'fixo') return 'Esse painel é fixo na interface, Senhor — fica sempre visível, não há o que fechar.';
          ELX.screens.close(target);
          return `Pronto, Senhor — fechei ${target === 'all' ? 'todas as telas' : target === 'camera' ? 'a câmera' : 'a tela'}. Confirme com naturalidade.`;
        }
        case 'lottery_result': {
          const qs = `q=${encodeURIComponent(a.game || '')}` + (a.contest ? `&c=${a.contest}` : '') + (a.numbers ? `&n=${encodeURIComponent(a.numbers)}` : '');
          const r = await fetch(`/api/lottery?${qs}`).then(x => x.json());
          if (r.error) return 'Não consegui o resultado agora: ' + r.error;
          ELX.lottery?.render(r);
          const dz = r.dezenas.map(n => String(n).padStart(2, '0')).join(', ');
          let s = `${r.nome}, concurso ${r.concurso} (${r.data}): ${dz}.`;
          const f1 = r.premiacoes?.[0];
          if (f1) s += ` ${f1.faixa}: ${f1.ganhadores ? f1.ganhadores + ' ganhador(es), ' + 'R$ ' + Number(f1.premio).toLocaleString('pt-BR') + ' cada' : 'acumulou'}.`;
          if (r.conferencia) s += ` Conferência: ${r.conferencia.acertos.length} acerto(s)${r.conferencia.acertos.length ? ' (' + r.conferencia.acertos.map(n => String(n).padStart(2, '0')).join(', ') + ')' : ''}.`;
          if (r.acumulado && r.proxEstimativa) s += ` Acumulou! Próximo estimado em R$ ${Number(r.proxEstimativa).toLocaleString('pt-BR')}.`;
          return s + ' Apresente ao operador de forma natural, sem incentivar apostas.';
        }
        case 'youtube_watch': {
          const q = (a.query || '').trim();
          if (!q) return 'Sobre o que o senhor quer o vídeo?';
          const f = (a.filtro || a.duracao || a.periodo || '').toLowerCase();
          const r = await fetch(`/api/youtube?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}&n=12`).then(x => x.json());
          if (r.error || !r.videos?.length) return 'Não consegui buscar no YouTube agora: ' + (r.error || 'sem resultados');
          const i = Math.min(Math.max((a.escolher || 1) - 1, 0), r.videos.length - 1);
          const v = r.videos[i];
          ELX.monitor?.open(v, r.videos);
          const outros = r.videos.filter(x => x.id !== v.id).slice(0, 4)
            .map((x, n) => `${n + 1}. [${x.duracao}] ${x.titulo} — ${x.canal}`).join('; ');
          return `Monitor aberto com "${v.titulo}" do canal ${v.canal} (${v.duracao}${v.views ? ', ' + v.views : ''}) — CARREGADO E EM PAUSA, ainda não tocando. ` +
            `Outros resultados: ${outros}. Anuncie o que encontrou em fala natural, ofereça trocar por outro se não for o que ele queria, e PERGUNTE se já está pronto para assistir. Só chame monitor_play depois que ele confirmar.`;
        }
        case 'monitor_play': {
          const ok = ELX.monitor?.play?.();
          if (!ok) return 'Não há vídeo carregado no monitor agora.';
          return 'Exibição iniciada. A audição fica suspensa até o operador usar o botão de comando do monitor ou fechar a tela — apenas confirme brevemente e não espere mais nada por voz.';
        }
        case 'cyber_scan': {
          const r = await fetch(`/api/cyber?focus=${encodeURIComponent(a.focus || 'geral')}`).then(x => x.json());
          if (r.error) return 'Falha na varredura: ' + r.error;
          ELX.cyber?.render(r);
          const at = r.resumoAtaques, tipos = Object.entries(at.porTipo).map(([k, v]) => `${k} (${v})`).join(', ');
          const orig = at.ipsAtacantes.map(x => `${x.ip}${x.geo ? ' de ' + (x.geo.cidade || '?') + '/' + (x.geo.pais || '?') : ''}`).join('; ');
          return `Cyber Security, nível ${r.nivel}. Tentativas de ataque nos últimos 15 minutos: ${at.totalTentativas}${tipos ? ' — ' + tipos : ''}. ${orig ? 'Origem: ' + orig + '. ' : ''}` +
            `Conexões externas ativas: ${r.rede.conexoesExternas.length}. Indícios de malware: ${r.sistema.malwareIndicios.length ? r.sistema.malwareIndicios.join('; ') : 'nenhum'}. ` +
            `Relate como analista de SOC: nível, achados críticos, origem geográfica e recomendações defensivas. Não sugira contra-ataque.`;
        }
        default:
          return `ERRO: ferramenta ${name} indisponível no modo LIVE.`;
      }
    } catch (e) {
      return 'ERRO: ' + e.message;
    }
  }

  async function liveStart() {
    try {
      if (conv.on) convStop();
      stopSpeak();
      liveBtn.disabled = true;
      const sess = await fetch('/api/live/session', { method: 'POST' }).then(r => r.json());
      if (sess.error) throw new Error(sess.error);

      const pc = new RTCPeerConnection();
      live.pc = pc;
      live.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      live.mic.getTracks().forEach(t => pc.addTrack(t, live.mic));

      pc.ontrack = e => {
        live.audio = new Audio();
        live.audio.srcObject = e.streams[0];
        live.audio.play().catch(() => {});
        const liveSrc = ensureCtx().createMediaStreamSource(e.streams[0]);
        liveSrc.connect(analyser);   // esfera reage à voz LIVE
        liveSrc.connect(lipAn);      // lip-sync também, no modo AO VIVO
      };

      /* canal de eventos: function calling — o LIVE preenche os quadrantes de verdade */
      const dc = pc.createDataChannel('oai-events');
      dc.onmessage = async ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type !== 'response.function_call_arguments.done') return;
        let args = {}; try { args = JSON.parse(msg.arguments || '{}'); } catch {}
        const output = await liveExecTool(msg.name, args);
        dc.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: msg.call_id, output: String(output).slice(0, 4000) },
        }));
        dc.send(JSON.stringify({ type: 'response.create' }));
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const model = sess.model || 'gpt-realtime';
      const sdpUrl = sess.mode === 'legacy'
        ? `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`
        : `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`;
      const resp = await fetch(sdpUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sess.token}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!resp.ok) {
        let code = '';
        try { code = JSON.parse(await resp.text())?.error?.code || ''; } catch {}
        if (resp.status === 429 || code === 'insufficient_quota') {
          const e = new Error('quota'); e.quota = true; throw e;
        }
        throw new Error('falha na conexão de voz (HTTP ' + resp.status + (code ? ' — ' + code : '') + ')');
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });

      live.on = true;
      liveBtn.classList.add('on');
      liveBtn.disabled = false;
      ELX.setState('live');
      ELX.toast?.('Link neural estabelecido — conversa em tempo real com interrupção natural.', 'green');
      document.getElementById('ledVoice')?.classList.add('on');
    } catch (e) {
      liveStopInternal();
      if (e.quota) {
        ELX.toast?.('Modo AO VIVO exige créditos na conta OpenAI (platform.openai.com → Billing). O modo conversa 🎤 continua gratuito.', 'red');
        ELX.voice?.speak('Senhor, o modo ao vivo requer créditos na conta OpenAI, que estão esgotados no momento. Sugiro o modo conversa pelo microfone — gratuito e com a mesma inteligência.');
      } else {
        ELX.toast?.('Modo AO VIVO indisponível: ' + e.message, 'red');
      }
      // cooldown: evita marteladas no botão (e rate-limit em cima de rate-limit)
      setTimeout(() => { liveBtn.disabled = false; }, 4000);
    }
  }
  function liveStopInternal() {
    live.pc?.close();
    live.mic?.getTracks().forEach(t => t.stop());
    if (live.audio) live.audio.srcObject = null;
    live.pc = live.mic = live.audio = null;
    live.on = false;
    liveBtn.classList.remove('on');
    if (ELX.state === 'live') ELX.setState('idle');
  }
  liveBtn.addEventListener('click', () => (live.on ? liveStopInternal() : liveStart()));

  /* ═════════ waveform do dock ═════════ */
  const wave = document.getElementById('wave');
  const wg = wave.getContext('2d');
  function drawWave() {
    requestAnimationFrame(drawWave);
    const W = wave.width, H = wave.height;
    wg.clearRect(0, 0, W, H);
    const st = ELX.state;
    const color = st === 'listening' ? '#00ff9d' : st === 'live' ? '#ff5e76' : '#00e5ff';
    wg.strokeStyle = color;
    wg.lineWidth = 1.4;
    wg.shadowColor = color;
    wg.shadowBlur = 6;
    wg.beginPath();
    const useMicViz = st === 'listening' && vad.an;
    if (useMicViz) {
      vad.an.getByteTimeDomainData(vad.data);
      const step = Math.ceil(vad.data.length / W);
      for (let x = 0; x < W; x++) {
        const v = vad.data[Math.min(x * step, vad.data.length - 1)] / 128 - 1;
        const y = H / 2 + v * (H / 2 - 4);
        x === 0 ? wg.moveTo(x, y) : wg.lineTo(x, y);
      }
    } else if (analyser && !simOn && (st === 'speaking' || st === 'live')) {
      analyser.getByteTimeDomainData(timeData);
      const step = Math.ceil(timeData.length / W);
      for (let x = 0; x < W; x++) {
        // menos volume da onda quando o agente fala (amplitude amortecida)
        const v = (timeData[Math.min(x * step, timeData.length - 1)] / 128 - 1) * 0.6;
        const y = H / 2 + v * (H / 2 - 4);
        x === 0 ? wg.moveTo(x, y) : wg.lineTo(x, y);
      }
    } else {
      const t = performance.now() / 1000;
      const amp = simOn ? 10 : (st === 'thinking' ? 5 : 2.2);
      for (let x = 0; x < W; x++) {
        const y = H / 2 + Math.sin(x * 0.07 + t * 2.6) * amp * Math.sin(t * 1.3 + x * 0.012);
        x === 0 ? wg.moveTo(x, y) : wg.lineTo(x, y);
      }
    }
    wg.stroke();
  }
  drawWave();

  /* Esc interrompe fala + geração */
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { ELX.agent?.interrupt('esc'); if (!conv.on) ELX.setState('idle'); }
  });

  /* ═════════ SUSPENDER/RETOMAR AUDIÇÃO — usado pelo Monitor de vídeo ═════════
     Quando um vídeo toca no monitor, o som vaza pelos alto-falantes e o
     microfone capta essa voz como se fosse o operador (falso barge-in, ele
     "ouve" o vídeo e reage). Solução: desligar de vez a captação (STT + VAD +
     a faixa de áudio do modo AO VIVO) enquanto o vídeo toca, e só devolver
     quando o operador pedir a palavra (push-to-talk) ou fechar o monitor. */
  function suspendListening() {
    if (listenSuspended) return;
    listenSuspended = true;
    suspendedConv = conv.on;
    suspendedLive = live.on;
    stopSTT();
    if (conv.on) vadStop();                                    // solta o tap isolado do mic
    if (live.on && live.mic) live.mic.getTracks().forEach(t => t.enabled = false); // corta o envio, mantém a sessão
    if (ELX.state === 'listening') ELX.setState('idle');
  }
  function resumeListening() {
    if (!listenSuspended) return;
    listenSuspended = false;
    if (suspendedConv && conv.on) { vadStart(); if (ELX.state === 'idle') startSTT(); }
    if (suspendedLive && live.on && live.mic) live.mic.getTracks().forEach(t => t.enabled = true);
  }
  /** escuta UM comando (usado pelo botão "🎙 falar" do monitor, com o vídeo em pausa) */
  function pushToTalkOnce() {
    if (!SR) { ELX.toast?.('Reconhecimento de voz não suportado. Use Chrome ou Edge.', 'red'); return false; }
    stopSTT();
    startSTT();
    return true;
  }

  ELX.voice = {
    speak, stop: stopSpeak, hold,
    /* Executor das ferramentas do LIVE exposto para VERIFICAÇÃO: é o único
       caminho que o agente falado percorre, e sem um gancho só dá para testá-lo
       falando com o microfone — o que não é teste, é demonstração. */
    execTool: liveExecTool,
    startSTT, stopSTT, ensureCtx,
    suspendListening, resumeListening, pushToTalkOnce,
    cfg: VOICE_CFG,
    get speaking() { return speaking; },
    get conv() { return conv.on; },
    get listenSuspended() { return listenSuspended; },
  };
})();
