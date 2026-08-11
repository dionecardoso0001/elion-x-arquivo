/**
 * ELION-X · COSMOS — sistema solar cinematográfico em WebGL
 *
 * Por que WebGL e não canvas 2D: no 2D a "luz" é um degradê radial colado por
 * cima. Não existe normal, não existe incidência, não existe terminador — daí
 * a leitura de plástico. Aqui cada corpo é geometria esférica de verdade,
 * iluminada por uma fonte na posição do Sol, com o sombreamento calculado por
 * pixel no shader. É essa diferença que separa ilustração de fotografia.
 *
 * Superfícies são PROCEDURAIS (FBM em GLSL), não texturas de arquivo. Decisão
 * deliberada: evita depender de imagem externa, funciona offline, não levanta
 * questão de licença ou crédito e permite variação contínua sem costura.
 *
 * Fica ATRÁS do grafo de nós, que segue em canvas 2D — a malha cognitiva é a
 * informação; o cosmos é o palco.
 */
(() => {
  'use strict';
  if (typeof THREE === 'undefined') { console.warn('[cosmos] Three.js ausente'); return; }

  const cv = document.getElementById('cosmos');
  if (!cv) return;

  /* ─────────────── renderer: cor e tom cinematográficos ─────────────── */
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true,
                                             powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputEncoding = THREE.sRGBEncoding;          // r128: gerenciamento sRGB
  renderer.toneMapping = THREE.ACESFilmicToneMapping;    // curva de cinema
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 4000);
  camera.position.set(46, 26, 196);
  camera.lookAt(2, -2, -6);

  /* ─────────────── ruído compartilhado pelos shaders ─────────────── */
  const RUIDO = `
    vec3 hash3(vec3 p){
      p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6)));
      return fract(sin(p)*43758.5453123)*2.0-1.0;
    }
    float ruido(vec3 p){
      vec3 i = floor(p), f = fract(p);
      vec3 u = f*f*(3.0-2.0*f);
      return mix(mix(mix(dot(hash3(i+vec3(0,0,0)),f-vec3(0,0,0)), dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),
                     mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
                 mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),
                     mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z)*0.5+0.5;
    }
    float fbm(vec3 p, int oit){
      float v=0.0, a=0.5;
      for(int i=0;i<8;i++){ if(i>=oit) break; v += ruido(p)*a; p*=2.03; a*=0.5; }
      return v;
    }
    // FBM com domínio deslocado por outro FBM: cria turbulência, não borrão
    float turb(vec3 p, int oit){
      vec3 q = vec3(fbm(p, 3), fbm(p+vec3(5.2,1.3,2.7), 3), fbm(p+vec3(1.7,9.2,4.4), 3));
      return fbm(p + 2.4*q, oit);
    }
  `;

  const VERT = `
    varying vec3 vN;      // normal em espaço de mundo
    varying vec3 vP;      // posição em espaço de mundo
    varying vec3 vL;      // posição local (para amostrar a superfície girando)
    uniform float uGiro;
    void main(){
      float c = cos(uGiro), s = sin(uGiro);
      vec3 pr = vec3(position.x*c - position.z*s, position.y, position.x*s + position.z*c);
      vL = normalize(pr);
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position,1.0);
      vP = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  /* superfícies por tipo — cada uma com sua física visual */
  const SUPERFICIE = {
    mercurio: `
      float m = fbm(vL*4.0, 5);
      float cr = fbm(vL*14.0, 4);
      vec3 base = mix(vec3(0.42,0.40,0.38), vec3(0.24,0.23,0.22), m);
      base *= 0.85 + 0.30*smoothstep(0.35,0.65,cr);
      cor = base;`,
    venus: `
      float n = turb(vL*3.2 + vec3(0.0, uT*0.010, 0.0), 6);
      float faixa = 0.5+0.5*sin(vL.y*7.0 + n*3.4);
      cor = mix(vec3(0.86,0.68,0.38), vec3(0.98,0.92,0.74), n*0.65+faixa*0.35);`,
    marte: `
      float largo = fbm(vL*2.6, 5);
      float fino  = fbm(vL*12.0, 4);
      vec3 claro = vec3(0.86,0.56,0.36), escuro = vec3(0.34,0.18,0.13);
      cor = mix(escuro, claro, smoothstep(0.30,0.72,largo));
      cor *= 0.90 + 0.20*fino;
      float gelo = smoothstep(0.86,0.97,abs(vL.y));
      cor = mix(cor, vec3(0.94,0.93,0.90), gelo);`,
    jupiter: `
      float onda = turb(vec3(vL.x*1.2, vL.y*5.0, vL.z*1.2) + vec3(uT*0.006,0.0,0.0), 5);
      float lat = vL.y + (onda-0.5)*0.16;
      float f = 0.5+0.5*sin(lat*17.0);
      vec3 claro = vec3(0.92,0.84,0.70), escuro = vec3(0.58,0.36,0.21);
      cor = mix(escuro, claro, f);
      cor = mix(cor, claro*1.06, (turb(vL*7.0,4)-0.5)*0.5);
      // Grande Mancha Vermelha
      vec2 d = vec2((atan(vL.z,vL.x)/6.2831 + 0.30), vL.y + 0.22);
      d.x = fract(d.x+0.5)-0.5;
      float g = 1.0 - smoothstep(0.0, 1.0, length(vec2(d.x*3.2, d.y*7.0)));
      cor = mix(cor, vec3(0.72,0.32,0.20), g*0.92);`,
    saturno: `
      float onda = turb(vec3(vL.x*1.1, vL.y*4.2, vL.z*1.1) + vec3(uT*0.004,0.0,0.0), 5);
      float f = 0.5+0.5*sin((vL.y+(onda-0.5)*0.14)*13.0);
      cor = mix(vec3(0.72,0.62,0.42), vec3(0.95,0.90,0.74), f);`,
    urano: `
      float n = turb(vL*2.4 + vec3(0.0,uT*0.004,0.0), 5);
      float f = 0.5+0.5*sin(vL.y*7.0+n*1.6);
      cor = mix(vec3(0.55,0.80,0.83), vec3(0.78,0.94,0.95), f*0.55+n*0.45);`,
    netuno: `
      float n = turb(vL*2.8 + vec3(0.0,uT*0.006,0.0), 5);
      float f = 0.5+0.5*sin(vL.y*9.0+n*2.2);
      cor = mix(vec3(0.10,0.22,0.62), vec3(0.34,0.55,0.92), f*0.5+n*0.5);
      vec2 d = vec2(fract(atan(vL.z,vL.x)/6.2831 + 0.62 + 0.5)-0.5, vL.y-0.26);
      float g = 1.0 - smoothstep(0.0,1.0, length(vec2(d.x*3.6, d.y*8.0)));
      cor = mix(cor, vec3(0.05,0.10,0.34), g*0.72);`,
    lua: `
      float m = fbm(vL*3.2, 5);
      float cr = fbm(vL*16.0, 4);
      vec3 alt = vec3(0.70,0.69,0.67), mar = vec3(0.30,0.30,0.32);
      cor = mix(alt, mar, smoothstep(0.52,0.72,m));
      cor *= 0.82 + 0.36*smoothstep(0.30,0.70,cr);`,
    plutao: `
      float m = fbm(vL*3.6, 5);
      cor = mix(vec3(0.62,0.54,0.44), vec3(0.32,0.27,0.22), m);
      cor *= 0.88 + 0.24*fbm(vL*15.0,3);`,
  };

  /* ─────────────── planeta rochoso/gasoso genérico ─────────────── */
  function fazPlaneta(tipo, raio) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uT:{value:0}, uGiro:{value:Math.random()*6.28}, uSol:{value:new THREE.Vector3()} },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec3 vN; varying vec3 vP; varying vec3 vL;
        uniform float uT; uniform vec3 uSol;
        ${RUIDO}
        void main(){
          vec3 cor;
          ${SUPERFICIE[tipo] || 'cor = vec3(0.5);'}
          vec3 N = normalize(vN);
          vec3 L = normalize(uSol - vP);
          // LAMBERT com terminador suavizado — a borda dura denuncia render pobre
          float dif = dot(N,L);
          float luz = smoothstep(-0.22, 0.34, dif);
          // luz rasante avermelhada no terminador, como no nascer do sol visto do espaço
          float rasante = smoothstep(0.0,0.30,dif) * (1.0-smoothstep(0.30,0.72,dif));
          vec3 quente = vec3(1.0,0.66,0.40) * rasante * 0.22;
          // escurecimento de limbo: perda de luz na borda do disco
          vec3 V = normalize(cameraPosition - vP);
          float limbo = pow(max(dot(N,V),0.0), 0.42);
          vec3 fin = cor * (luz*1.16 + 0.055) * limbo + quente;
          gl_FragColor = vec4(fin, 1.0);
        }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(raio, 96, 64), mat);
    m.userData.mat = mat;
    return m;
  }

  /* ─────────────── TERRA: quatro camadas independentes ─────────────── */
  function fazTerra(raio) {
    const grupo = new THREE.Group();

    const matSolo = new THREE.ShaderMaterial({
      uniforms: { uT:{value:0}, uGiro:{value:1.2}, uSol:{value:new THREE.Vector3()} },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec3 vN; varying vec3 vP; varying vec3 vL;
        uniform float uT; uniform vec3 uSol;
        ${RUIDO}
        void main(){
          // continentes: uma oitava larga manda na forma, as finas rendilham a costa
          float forma = fbm(vL*1.9, 3)*0.70 + fbm(vL*4.6, 3)*0.22 + fbm(vL*11.0, 3)*0.08;
          float lat = abs(vL.y);
          float cont = forma + 0.10 - lat*0.13;
          float terra = smoothstep(0.495, 0.525, cont);      // costa curta = litoral nítido
          vec3 oceano = mix(vec3(0.03,0.12,0.30), vec3(0.02,0.05,0.16),
                            smoothstep(0.30,0.50,0.52-cont));
          vec3 selva = vec3(0.09,0.24,0.10), campo = vec3(0.26,0.31,0.13),
               deserto = vec3(0.55,0.44,0.24), serra = vec3(0.34,0.31,0.27);
          vec3 solo = mix(selva, campo, smoothstep(0.05,0.42,lat));
          solo = mix(solo, deserto, smoothstep(0.14,0.34,lat)*0.75);
          solo = mix(solo, serra, smoothstep(0.53,0.60,cont));
          vec3 cor = mix(oceano, solo, terra);
          float gelo = smoothstep(0.80,0.93,lat);
          cor = mix(cor, vec3(0.86,0.90,0.94), gelo);

          vec3 N = normalize(vN);
          vec3 L = normalize(uSol - vP);
          float dif = dot(N,L);
          float luz = smoothstep(-0.20, 0.30, dif);

          // LUZES NOTURNAS: só no lado escuro e só onde há terra
          float noite = 1.0 - smoothstep(-0.16, 0.06, dif);
          float cidades = smoothstep(0.66, 0.90, fbm(vL*22.0, 4)) * terra
                        * (1.0 - smoothstep(0.52,0.72,lat));
          vec3 brilho = vec3(1.0,0.80,0.46) * cidades * noite * 0.85;

          // reflexo especular do oceano — só na água, e estreito
          vec3 V = normalize(cameraPosition - vP);
          vec3 H = normalize(L+V);
          float esp = pow(max(dot(N,H),0.0), 90.0) * (1.0-terra) * luz * 0.55;

          float rasante = smoothstep(0.0,0.26,dif)*(1.0-smoothstep(0.26,0.66,dif));
          float limbo = pow(max(dot(N,V),0.0), 0.40);
          vec3 fin = cor*(luz*1.14+0.050)*limbo + brilho + esp
                   + vec3(1.0,0.55,0.32)*rasante*0.16;
          gl_FragColor = vec4(fin,1.0);
        }`,
    });
    const solo = new THREE.Mesh(new THREE.SphereGeometry(raio, 128, 84), matSolo);
    grupo.add(solo);

    // NUVENS: esfera própria, girando em ritmo diferente do solo
    const matNuvem = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uT:{value:0}, uGiro:{value:0}, uSol:{value:new THREE.Vector3()} },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec3 vN; varying vec3 vP; varying vec3 vL;
        uniform float uT; uniform vec3 uSol;
        ${RUIDO}
        void main(){
          float n = turb(vL*3.0 + vec3(0.0,uT*0.004,0.0), 5);
          float cint = 0.5+0.5*sin(vL.y*6.2);          // cinturões equatoriais
          float d = n*0.78 + cint*0.22;
          float a = smoothstep(0.54, 0.80, d);
          if(a < 0.01) discard;
          vec3 N=normalize(vN), L=normalize(uSol-vP);
          float luz = smoothstep(-0.18,0.30,dot(N,L));
          gl_FragColor = vec4(vec3(1.0,0.99,0.98)*(luz*1.05+0.02), a*0.80);
        }`,
    });
    const nuvem = new THREE.Mesh(new THREE.SphereGeometry(raio*1.016, 96, 64), matNuvem);
    grupo.add(nuvem);

    grupo.userData = { solo, nuvem, matSolo, matNuvem };
    return grupo;
  }

  /* ─────────────── ATMOSFERA: casca invertida com Fresnel ─────────────── */
  function fazAtmosfera(raio, cor, forca) {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      uniforms: { uSol:{value:new THREE.Vector3()}, uCor:{value:new THREE.Color(cor)}, uF:{value:forca} },
      vertexShader: `
        varying vec3 vN; varying vec3 vP;
        void main(){ vN = normalize(mat3(modelMatrix)*normal);
          vec4 wp = modelMatrix*vec4(position,1.0); vP = wp.xyz;
          gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vN; varying vec3 vP;
        uniform vec3 uSol; uniform vec3 uCor; uniform float uF;
        void main(){
          vec3 N=normalize(vN), V=normalize(cameraPosition-vP), L=normalize(uSol-vP);
          // a casca é BackSide: a normal aponta para dentro, daí o sinal invertido
          float fres = pow(1.0 - abs(dot(N,V)), 3.0);
          float luz = smoothstep(-0.42, 0.42, dot(-N,L));     // só brilha do lado do Sol
          gl_FragColor = vec4(uCor, fres*luz*uF);
        }`,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(raio, 64, 48), mat);
  }

  /* ─────────────── ANÉIS DE SATURNO: geometria com alfa radial ─────────────── */
  function fazAneis(rInt, rExt, raioPlaneta) {
    const geo = new THREE.RingGeometry(rInt, rExt, 256, 8);
    // reescreve UV para que u seja o RAIO normalizado (o padrão do RingGeometry não serve)
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      uv.setXY(i, (Math.hypot(x, y) - rInt) / (rExt - rInt), 0.5);
    }
    const mat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      uniforms: { uSol:{value:new THREE.Vector3()}, uCentro:{value:new THREE.Vector3()},
                  uRp:{value:raioPlaneta} },
      vertexShader: `
        varying vec2 vUv; varying vec3 vP;
        void main(){ vUv=uv; vec4 wp=modelMatrix*vec4(position,1.0); vP=wp.xyz;
          gl_Position=projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; varying vec3 vP;
        uniform vec3 uSol; uniform vec3 uCentro; uniform float uRp;
        ${RUIDO}
        void main(){
          float r = vUv.x;
          // divisões: a de Cassini é a larga; as finas dão textura de partícula
          float dens = 0.55 + 0.45*sin(r*54.0);
          dens *= smoothstep(0.00,0.06,r) * (1.0-smoothstep(0.90,1.00,r));
          dens *= 1.0 - 0.92*smoothstep(0.40,0.46,r)*(1.0-smoothstep(0.52,0.58,r)); // Cassini
          dens *= 0.75 + 0.45*fbm(vec3(r*180.0, 0.0, 0.0), 3);
          vec3 cor = mix(vec3(0.52,0.45,0.34), vec3(0.88,0.82,0.66), 0.35+0.65*fract(r*7.0));
          // SOMBRA DO PLANETA sobre o anel: distância do ponto ao eixo Sol→centro
          vec3 dir = normalize(uCentro - uSol);
          vec3 rel = vP - uSol;
          float t = dot(rel, dir);
          float d = length(rel - dir*t);
          float sombra = (t > 0.0) ? smoothstep(uRp*1.06, uRp*0.72, d) : 0.0;
          float luz = 1.0 - sombra*0.90;
          gl_FragColor = vec4(cor*luz, clamp(dens,0.0,1.0)*0.92);
        }`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = Math.PI / 2;
    m.userData.mat = mat;
    return m;
  }

  /* ─────────────── SOL: plasma animado + coroa ─────────────── */
  function fazSol(raio) {
    const g = new THREE.Group();
    const matS = new THREE.ShaderMaterial({
      uniforms: { uT:{value:0}, uGiro:{value:0} },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec3 vN; varying vec3 vP; varying vec3 vL;
        uniform float uT;
        ${RUIDO}
        void main(){
          // duas escalas de convecção em ritmos diferentes: a superfície nunca repete
          float gran = turb(vL*7.0 + vec3(0.0, uT*0.030, 0.0), 5);
          float sup  = turb(vL*2.4 - vec3(0.0, uT*0.016, 0.0), 4);
          float e = gran*0.62 + sup*0.38;
          vec3 fundo  = vec3(1.00,0.34,0.05);
          vec3 medio  = vec3(1.00,0.62,0.14);
          vec3 quente = vec3(1.00,0.92,0.66);
          vec3 cor = mix(fundo, medio, smoothstep(0.30,0.58,e));
          cor = mix(cor, quente, smoothstep(0.58,0.86,e));
          // manchas: convecção suprimida
          float ma = turb(vL*1.7 + vec3(3.0,uT*0.006,0.0), 4);
          cor = mix(cor, vec3(0.42,0.11,0.02), smoothstep(0.70,0.86,ma)*0.85);
          // escurecimento de limbo — o Sol real é bem mais escuro na borda
          vec3 V = normalize(cameraPosition - vP);
          float limbo = pow(max(dot(normalize(vN),V),0.0), 0.55);
          gl_FragColor = vec4(cor*(0.55+0.85*limbo)*1.5, 1.0);
        }`,
    });
    g.add(new THREE.Mesh(new THREE.SphereGeometry(raio, 128, 84), matS));

    /* CORONA em painel que encara a câmera, NÃO em cascas concêntricas.
       Cada casca esférica com Fresnel gera um anel visível na sua borda — o
       resultado eram argolas de cebola em volta do Sol. Um painel único com
       queda radial contínua resolve, e ainda custa um draw call em vez de
       quatro. */
    const matC = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 } },
      vertexShader: `varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; uniform float uT;
        ${RUIDO}
        void main(){
          vec2 d = vUv*2.0-1.0;
          float r = length(d);
          if(r > 1.0) discard;
          float ang = atan(d.y, d.x);
          // línguas de plasma: ruído ao longo do ângulo, deslizando devagar
          float ling = 0.72 + 0.55*fbm(vec3(cos(ang)*2.2, sin(ang)*2.2, uT*0.05), 4);
          // duas quedas somadas: o núcleo fecha rápido, o halo se estende
          float perto = pow(max(0.0, 1.0 - r/0.34), 2.2);
          float longe = pow(max(0.0, 1.0 - r), 2.6);
          float a = (perto*0.85 + longe*0.42) * ling;
          // pulsação com dois senos incomensuráveis: nunca se repete igual
          a *= 0.88 + 0.12*sin(uT*0.31)*(0.6+0.4*sin(uT*0.137));
          vec3 cor = mix(vec3(1.0,0.42,0.08), vec3(1.0,0.86,0.52), pow(max(0.0,1.0-r),1.8));
          gl_FragColor = vec4(cor, clamp(a,0.0,1.0)*1.45);
        }`,
    });
    const painel = new THREE.Mesh(new THREE.PlaneGeometry(raio * 9.0, raio * 9.0), matC);
    painel.onBeforeRender = (r, s, cam) => painel.quaternion.copy(cam.quaternion); // sempre de frente
    g.add(painel);
    g.userData = { matS, coroas: [matC] };
    return g;
  }

  /* ─────────────── campo estelar em três camadas de parallax ─────────────── */
  function fazEstrelas(qtd, raio, tam, brilho) {
    const pos = new Float32Array(qtd * 3), cor = new Float32Array(qtd * 3);
    const c = new THREE.Color();
    for (let i = 0; i < qtd; i++) {
      // distribuição não uniforme: aglomera em faixas, como a Via Láctea
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const r = raio * (0.75 + Math.random() * 0.25);
      const s = Math.sqrt(1 - u * u) * (0.55 + 0.45 * Math.pow(Math.random(), 0.4));
      pos[i*3] = r*s*Math.cos(th); pos[i*3+1] = r*u*0.55; pos[i*3+2] = r*s*Math.sin(th);
      // temperatura de cor: da anã vermelha à azul
      const t = Math.random();
      c.setHSL(t < 0.55 ? 0.08 + Math.random()*0.06 : (t < 0.88 ? 0.14 : 0.58),
               t < 0.55 ? 0.55 : 0.35, 0.62 + Math.random()*0.32);
      cor[i*3]=c.r; cor[i*3+1]=c.g; cor[i*3+2]=c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(cor, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({
      size: tam, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: brilho, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
  }

  /* ─────────────── órbita: elipse fina com queda de opacidade ─────────────── */
  function fazOrbita(raio, incl) {
    const pts = [];
    for (let i = 0; i <= 512; i++) {
      const a = i / 512 * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * raio, 0, Math.sin(a) * raio * incl));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({
      color: 0x8fb8d8, transparent: true, opacity: 0.16, depthWrite: false,
    }));
  }

  /* ═══════════════ MONTAGEM DA CENA ═══════════════ */
  /* Escala CINEMATOGRÁFICA comprimida — não é escala astronômica. As
     distâncias reais tornariam os planetas invisíveis; a ordem é preservada,
     as proporções não. A coluna 'alt' tira os corpos de uma faixa única e
     cria planos de profundidade, como pede a composição de referência. */
  const CORPOS = [
    // nome        raio  órbita  vel     giro   alt   atmosfera(cor, força)
    ['mercurio',   2.4,   38,   0.062,  0.05,  0.10,  null],
    ['venus',      4.2,   52,   0.046,  0.02, -0.16,  [0xffd9a0, 0.55]],
    ['terra',      4.6,   70,   0.038,  0.30,  0.22,  [0x6ab4ff, 1.05]],
    ['marte',      3.2,   88,   0.030,  0.28, -0.10,  [0xe08a5a, 0.32]],
    ['jupiter',   13.0,  116,   0.017,  0.55,  0.30,  null],
    ['saturno',   11.0,  148,   0.013,  0.50, -0.26,  null],
    ['urano',      6.8,  178,   0.010, -0.22,  0.34,  [0x9fe8ee, 0.60]],
    ['netuno',     6.4,  206,   0.008,  0.24, -0.34,  [0x5f8dff, 0.62]],
    ['plutao',     1.9,  232,   0.006,  0.10,  0.40,  null],
  ];

  const INCL = 0.42;                       // achatamento das elipses na tela
  const SOL_R = 26;
  const sol = fazSol(SOL_R);
  sol.position.set(-104, 14, 44);           // fora do enquadramento à esquerda
  scene.add(sol);
  const solPos = sol.position.clone();

  const luzSol = new THREE.PointLight(0xfff2dc, 2.6, 0, 2);
  luzSol.position.copy(solPos);
  scene.add(luzSol);
  scene.add(new THREE.AmbientLight(0x14243a, 0.34));   // preenchimento mínimo, só para o preto não morrer

  const planetas = [];
  for (const [tipo, raio, orb, vel, giro, alt, atm] of CORPOS) {
    const grupo = new THREE.Group();
    const corpo = (tipo === 'terra') ? fazTerra(raio) : fazPlaneta(tipo, raio);
    grupo.add(corpo);

    if (atm) grupo.add(fazAtmosfera(raio * 1.055, atm[0], atm[1]));

    let aneis = null;
    if (tipo === 'saturno') {
      aneis = fazAneis(raio * 1.18, raio * 2.05, raio);
      aneis.rotation.x = Math.PI/2 - 0.52; aneis.rotation.y = 0.30;             // inclinação tridimensional
      grupo.add(aneis);
    }
    if (tipo === 'urano') {
      const a = fazAneis(raio * 1.42, raio * 1.72, raio);
      a.rotation.x = Math.PI / 2; a.rotation.y = 1.35;
      a.material.uniforms.uCentro = { value: new THREE.Vector3() };
      grupo.add(a); aneis = a;
    }
    scene.add(grupo);
    scene.add(fazOrbita(orb, INCL));
    planetas.push({ tipo, grupo, corpo, aneis, orb, vel, giro, alt,
                    fase: Math.random() * Math.PI * 2, raio });
  }

  // Lua acompanhando a Terra
  const terra = planetas.find(p => p.tipo === 'terra');
  const lua = fazPlaneta('lua', 0.78);
  scene.add(lua);

  scene.add(fazEstrelas(2600, 900, 1.5, 0.85));
  scene.add(fazEstrelas(1800, 1500, 2.4, 0.55));
  scene.add(fazEstrelas(900, 2400, 3.6, 0.32));

  /* ─────────────── laço ─────────────── */
  let W = 0, H = 0, t0 = performance.now(), pausado = false;
  function redimensiona() {
    W = innerWidth; H = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 1.75);   // teto: acima disso o ganho não paga
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // enquadramento panorâmico: a cena tem de caber na largura, não na altura
    camera.fov = W / H < 1.5 ? 54 : 46;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', redimensiona);
  redimensiona();

  function quadro() {
    requestAnimationFrame(quadro);
    if (pausado) return;
    const t = (performance.now() - t0) / 1000;

    sol.userData.matS.uniforms.uT.value = t;
    sol.userData.matS.uniforms.uGiro.value = t * 0.008;
    for (const c of sol.userData.coroas) c.uniforms.uT.value = t;

    for (const p of planetas) {
      const a = t * p.vel + p.fase;
      p.grupo.position.set(Math.cos(a)*p.orb, p.alt*p.orb*0.26 + Math.sin(a)*p.orb*INCL*0.18, Math.sin(a)*p.orb*INCL);
      const mats = p.tipo === 'terra'
        ? [p.corpo.userData.matSolo, p.corpo.userData.matNuvem]
        : [p.corpo.userData.mat];
      mats.forEach((m, i) => {
        m.uniforms.uT.value = t;
        m.uniforms.uGiro.value = t * p.giro * (i === 1 ? 1.35 : 1);   // nuvem corre mais que o solo
        m.uniforms.uSol.value.copy(solPos);
      });
      p.grupo.children.forEach(ch => {
        const u = ch.material && ch.material.uniforms;
        if (u && u.uSol) u.uSol.value.copy(solPos);
        if (u && u.uCentro) u.uCentro.value.copy(p.grupo.position);
      });
    }

    if (terra) {
      const la = t * 0.42;
      lua.position.set(terra.grupo.position.x + Math.cos(la) * 5.6,
                       terra.grupo.position.y + Math.sin(la) * 1.4,
                       terra.grupo.position.z + Math.sin(la) * 5.6);
      lua.userData.mat.uniforms.uT.value = t;
      lua.userData.mat.uniforms.uGiro.value = la;
      lua.userData.mat.uniforms.uSol.value.copy(solPos);
    }

    renderer.render(scene, camera);
  }
  quadro();

  // respeita quem pediu menos movimento
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) pausado = true;

  window.ELXCosmos = {
    get pausado() { return pausado; },
    pausar(v) { pausado = v !== undefined ? !!v : !pausado; if (!pausado) quadro(); },
    cena: scene, camera, renderer,
  };
})();
