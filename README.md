# ELION-X

**Central de comando por inteligência artificial — classe JARVIS.**
Plataforma web que conversa por voz e texto, enxerga pelas câmeras, reconhece pessoas
pelo rosto e pela voz, opera o WhatsApp, investiga fontes primárias oficiais e vigia
continuamente temas de interesse — tudo executando **localmente**, na máquina do operador.

<sub>Advanced Tech TI · Arquiteto e operador: Dione Cardoso</sub>

---

| | |
|---|---|
| **41** capacidades | **29** rotas de API |
| **30** serviços externos | **~13k** linhas de código |
| **3** dependências npm | **0** frameworks |

---

## Índice

- [Como rodar](#como-rodar)
- [Acesso pelo celular](#acesso-pelo-celular)
- [Arquitetura](#arquitetura)
- [Mapa de arquivos](#mapa-de-arquivos)
- [As 41 capacidades](#as-41-capacidades)
- [Base de conhecimento (prompts)](#base-de-conhecimento-prompts)
- [Integrações](#integrações)
- [Configuração](#configuração)
- [Segurança](#segurança)
- [Como estender](#como-estender)

---

## Como rodar

```bash
git clone https://github.com/dionecardoso0001/elion-x.git
cd elion-x
npm install

cp .env.example .env      # e preencha ANTHROPIC_API_KEY

node server.js            # → http://localhost:3001
```

Abra no **Chrome ou Edge** — o reconhecimento de voz do navegador só existe neles.
Clique em **INICIAR SISTEMA** e permita microfone, câmera e localização.

Diagnóstico: `GET /api/status`

---

## Acesso pelo celular

O ELION-X **não roda no celular** — ele roda no PC. O que o celular faz é abrir a
interface pela rede. Por isso o PC precisa estar ligado e com o servidor no ar.

### O jeito certo: túnel HTTPS (funciona em 4G/5G e em qualquer Wi-Fi)

```bash
node scripts/mobile.mjs        # ou o atalho "ELION-X Mobile.bat" no Windows
```

O script sobe o núcleo (se ainda não estiver no ar), abre um túnel HTTPS da
Cloudflare e mostra um QR Code no navegador do PC. Escaneie com o celular e
pronto — o link `https://….trycloudflare.com` é acessível de **qualquer rede**,
inclusive do 4G/5G longe de casa.

Na primeira execução ele baixa o `cloudflared` (~52 MB) para `bin/`. Esse binário
não é versionado (é pesado demais para o clone), e é por isso que o atalho falhava
em uma máquina recém-clonada: sem ele, não havia túnel nenhum.

O túnel só existe enquanto a janela ficar aberta, e o endereço muda a cada
execução. **Enquanto está aberto, o link é público** — quem tiver a URL fala com o
seu ELION-X, com acesso ao Gmail, WhatsApp e arquivos conectados. Não compartilhe
e feche a janela ao terminar.

### O jeito limitado: IP local (celular e PC na mesma rede)

Com o celular no **mesmo Wi-Fi** do PC, dá para abrir `http://<ip-do-pc>:3001`.
Isso inclui o caso em que **o PC está no hotspot do celular**: aí os dois estão na
mesma rede, e o IP local funciona sem túnel nenhum.

O atalho **`ELION-X QR.bat`** sobe o núcleo e abre a página `/qr`, que lista todos os
endereços em que o celular alcança este PC e gera o QR de cada um. Se houver túnel
aberto, ele aparece como primeira opção.

Funciona para texto, mas **microfone e câmera não abrem**: o navegador só libera
esses recursos em HTTPS ou em `localhost`. Voz e visão no celular exigem o túnel.

**Se o QR do endereço local não abrir**, quase sempre é o Firewall do Windows
barrando a porta. Em um PowerShell **como administrador**:

```powershell
netsh advfirewall firewall add rule name="ELION-X 3001" dir=in action=allow protocol=TCP localport=3001
```

> Dados móveis do celular **não** alcançam o PC de casa sem o túnel — a operadora usa
> NAT e não existe rota da internet até a sua máquina. Não é configuração de Wi-Fi.

> Um QR do túnel **não é reutilizável**: o endereço `trycloudflare.com` muda a cada
> execução, então um QR salvo ou fotografado antes já não abre.

Se usar Gmail pelo celular, ajuste `PUBLIC_URL` no `.env` para a URL do túnel — o
callback do OAuth do Google é montado a partir dela.

---

## Arquitetura

O servidor mantém uma conversa contínua com o modelo. Quando o modelo decide usar uma
ferramenta, o servidor a executa (ou delega ao navegador), devolve o resultado e o ciclo
recomeça — até **seis voltas** por mensagem.

```
Fala ou texto
     ↓
Contexto montado    ← memória · agenda · GPS · documento · vigilância · biometria
     ↓
Claude (streaming)
     ↓
Precisa de ferramenta? ──sim──→ Executa ──┐
     │                                     │
     não                                   └──↺ até 6 voltas
     ↓
Resposta falada + exibida
```

### Dois caminhos de execução

| Modo | Quem executa | Consequência |
|---|---|---|
| **Texto / Conversa** | Servidor (Node.js) | Acesso a disco, rede e processos |
| **Ao Vivo** | Navegador | Exige executor próprio + rota HTTP |

> ⚠️ **Armadilha das cinco camadas.** Uma ferramenta nova precisa ser registrada em
> cinco lugares (ver [Como estender](#como-estender)). Faltando o executor do navegador,
> o recurso funciona por texto e parece *"fora do ar"* por voz.

---

## Mapa de arquivos

| Arquivo | Linhas | Responsabilidade |
|---|---:|---|
| `server.js` | 3.798 | Núcleo: laço agêntico, 41 ferramentas, 29 rotas, base de conhecimento |
| `assets/cyber.js` | 1.615 | Módulo de Cyber Security — painel e análise defensiva |
| `assets/app.css` | 1.067 | Identidade visual holográfica |
| `assets/quadrants.js` | 1.054 | Painéis, monitor virtual, controle de telas por voz |
| `assets/voice.js` | 1.002 | Voz: síntese, reconhecimento, modo ao vivo, sincronia labial |
| `assets/sphere.js` | 786 | Esfera 3D — shaders, rastros de fumaça, luzes cósmicas |
| `assets/avatar.js` | 765 | Avatar holográfico e movimento labial por formantes |
| `assets/agent.js` | 535 | Cliente do laço agêntico e eventos de interface |
| `assets/cyber.css` | 478 | Estilo do painel de segurança |
| `assets/voiceid.js` | 436 | Biometria vocal — captura, pitch, LTAS, identificação |
| `index.html` | 363 | Estrutura da interface |
| `wa.mjs` | 360 | Integração WhatsApp |
| `intel.mjs` | 289 | Investigação em fontes primárias |
| `security.mjs` | 190 | Varredura defensiva de rede e sistema |
| `assets/face.js` | 119 | Reconhecimento facial |
| `docs.mjs` | 113 | Extração de documentos (PDF, DOCX, PPTX, XLSX) |

### Stack

| Camada | Tecnologia | Decisão |
|---|---|---|
| Servidor | Node.js · `http.createServer` | **Zero framework**. Sem Express, sem build |
| Interface | HTML5 · CSS3 · JS puro | Sem React, sem empacotador |
| 3D | Three.js · WebGL · GLSL | Shaders próprios via `onBeforeCompile` |
| Áudio | Web Audio API | Formantes (lábios) e LTAS (biometria) |
| Transmissão | Server-Sent Events | Resposta palavra a palavra, interrompível |
| Persistência | JSON em disco | Sem banco. Estado auditável a olho nu |

**Dependências (3):** `pdf-parse` · `jszip` · `whatsapp-web.js`

---

## As 41 capacidades

<details>
<summary><b>Percepção e identidade</b> (5)</summary>

| Ferramenta | O que faz |
|---|---|
| `analyze_camera` | Visão computacional: conta pessoas, lê emoção facial, descreve vestuário |
| `switch_camera` | Alterna entre webcam integrada e câmera externa |
| `enroll_face` | Memoriza biometricamente o rosto de uma pessoa |
| `enroll_voice` | Cadastra a voz; aceita aproveitar a voz recém-ouvida de um desconhecido |
| `identify_voice` | Diz quem está falando; se for de fora, informa o perfil demográfico |
</details>

<details>
<summary><b>Investigação e vigilância</b> (7)</summary>

| Ferramenta | O que faz |
|---|---|
| `deep_investigate` | Consulta registros oficiais em paralelo (licitações, reguladores, imprensa, pesquisa, diários) |
| `watch_add` | Coloca tema ou empresa sob vigilância contínua |
| `watch_check` | Relata apenas o que é novo desde o último aviso |
| `watch_manage` | Lista ou remove temas monitorados |
| `investigate_news` | Investigação jornalística ao vivo |
| `web_search` | Busca na internet por fatos atuais |
| `get_ai_news` | Manchetes do feed curado de IA e tecnologia |
</details>

<details>
<summary><b>Comunicação</b> (8)</summary>

| Ferramenta | O que faz |
|---|---|
| `wa_list_chats` | Lista conversas recentes do WhatsApp |
| `wa_read_chat` | Lê histórico por nome aproximado |
| `wa_find_contact` | Localiza contato por nome falado ou parcial |
| `wa_send_message` | Envia mensagem em nome do operador |
| `wa_allow` | Gerencia lista de permissão de resposta automática |
| `wa_auto_reply` | Liga/desliga a resposta automática |
| `get_emails` | Lê a caixa de entrada do Gmail (somente leitura) |
| `read_email` | Abre o corpo completo de um e-mail |
</details>

<details>
<summary><b>Conhecimento e decisão</b> (5)</summary>

| Ferramenta | O que faz |
|---|---|
| `read_document` | Lê PDF, Word, PowerPoint, Excel, texto e código — grandes vêm em partes |
| `council_review` | Conselho de Decisão: 5 conselheiros + síntese |
| `memory_save` | Grava fato ou preferência na memória permanente |
| `memory_remove` | Apaga item da memória |
| `ia_sem_medo` | Carrega a base do curso IA Sem Medo |
</details>

<details>
<summary><b>Operação e rotina</b> (16)</summary>

| Ferramenta | O que faz |
|---|---|
| `agenda_add` · `agenda_list` · `agenda_update` · `agenda_remove` | Gestão da agenda |
| `open_screen` · `close_screen` | Abre/fecha qualquer painel por voz |
| `open_website` | Abre site no visor flutuante |
| `youtube_watch` · `monitor_play` | Pesquisa e exibe em monitor virtual |
| `get_weather` | Meteorologia oficial brasileira + GPS |
| `lottery_result` | Resultados oficiais das loterias da Caixa |
| `cyber_scan` | Varredura defensiva com geolocalização de origem |
| `analyze_market` | Gráfico ao vivo com leitura técnica **educativa** |
| `portfolio_add` · `portfolio_view` · `portfolio_remove` | Carteira declarada manualmente |
</details>

---

## Base de conhecimento (prompts)

A personalidade e a competência do ELION-X **não vêm de treinamento próprio**: vêm de uma
base de conhecimento montada dinamicamente a cada mensagem, em `systemPrompt()`
(`server.js`).

### Identidade — o núcleo

> *"Você é ELION-X, a inteligência central de uma plataforma de comando holográfica de
> última geração — um sistema da classe JARVIS."*

### Blocos injetados a cada mensagem

| Bloco | Conteúdo |
|---|---|
| Data e hora | Momento atual em Brasília, por extenso |
| Localização | GPS do computador como **fonte autoritativa** — nunca deduzir da agenda |
| `memBlock` | Últimos 40 fatos da memória permanente |
| `agBlock` | Agenda completa já carregada — dispensa consulta |
| `portfolioBlock` | Carteira de investimentos declarada |
| `docContextBlock` | Documento ativo: nome + prévia (conteúdo vem sob demanda) |
| `watchBlock` | Temas sob vigilância e novidades pendentes |
| Rostos e vozes | Quem a plataforma reconhece biometricamente |

> **Decisão de economia:** o documento ativo entra no contexto só como nome e prévia.
> O conteúdo completo só é carregado quando o agente chama `read_document` — evita
> gastar milhares de tokens em toda mensagem trivial.

### Outros prompts do sistema

| Constante | Papel |
|---|---|
| `LIVE_INSTRUCTIONS` | Instruções do modo AO VIVO (OpenAI Realtime) |
| `VISION_SYSTEM` | Módulo de visão computacional — emula FER e reconhecimento de vestuário |
| `COUNCIL_ADVISORS` | Os 5 métodos de raciocínio do Conselho |
| `IA_SEM_MEDO_KB` | Base de conhecimento do curso |

### Conselho de Decisão (DMAD)

Cinco conselheiros com métodos **deliberadamente distintos**, revisão anônima entre pares
e síntese pela presidência. Um avaliador independente mede a **diversidade real** — se a
convergência veio de métodos distintos ou é concordância teatral.

| Conselheiro | Método |
|---|---|
| **O Contrário** | Falsificação — steelman da posição oposta |
| **O Executor** | Viabilidade — recursos, prazos, primeiro passo |
| **O Estrategista** | Consequência de segunda ordem |
| **O Outsider** | Analogia de outro setor |
| **A Sentinela** | Risco e exposição |

---

## Integrações

<details>
<summary><b>IA e voz</b></summary>

| Serviço | Uso |
|---|---|
| `api.anthropic.com` | Claude — raciocínio, ferramentas, visão de documentos |
| `api.openai.com` | Realtime — modo de voz ao vivo |
| `api.elevenlabs.io` | Voz premium (opcional; padrão é síntese gratuita) |
</details>

<details>
<summary><b>Fontes primárias oficiais</b></summary>

| Serviço | O que antecipa |
|---|---|
| `pncp.gov.br` | Edital publicado semanas antes de virar notícia |
| `efts.sec.gov` | Fato comunicado ao regulador antes do anúncio |
| `api.queridodiario.ok.org.br` | Contrato e decreto municipal na origem |
| `news.google.com` | Imprensa brasileira nacional e regional |
| `api.gdeltproject.org` | Imprensa mundial |
| `export.arxiv.org` | Artigo antecede a tecnologia em 6–18 meses |
| `servicebus2.caixa.gov.br` | Resultados oficiais das loterias |
</details>

<details>
<summary><b>Dados e produtividade</b></summary>

| Serviço | Uso |
|---|---|
| `gmail.googleapis.com` | E-mail (OAuth 2.0, somente leitura) |
| `apiprevmet3.inmet.gov.br` | Meteorologia oficial (INMET) |
| `brasilapi.com.br` | Previsão CPTEC |
| `api.open-meteo.com` | Meteorologia global + geocodificação |
| `nominatim.openstreetmap.org` | Endereço a partir do GPS |
| `query1.finance.yahoo.com` | Cotações |
| `s3.tradingview.com` | Gráficos de ativos |
| `api.tavily.com` | Busca web estruturada |
</details>

> **Princípio:** toda fonte é pública e oficial. A plataforma não acessa sistema sem
> autorização nem consome dado obtido indevidamente. A vantagem vem de **ler a fonte
> primária antes de ela virar pauta** — não de acesso privilegiado.

---

## Configuração

Copie `.env.example` para `.env`. Só a primeira é obrigatória.

| Variável | Finalidade |
|---|---|
| `ANTHROPIC_API_KEY` | Acesso ao Claude — **obrigatória** |
| `OPENAI_API_KEY` | Modo de voz ao vivo |
| `TAVILY_API_KEY` | Busca na web |
| `GOOGLE_CLIENT_ID` / `_SECRET` | OAuth do Gmail |
| `ELEVENLABS_API_KEY` / `_VOICE_ID` | Voz premium (opcional) |
| `CLAUDE_MODEL` · `LIVE_VOICE` · `EDGE_VOICE` | Modelo e timbres |
| `PORT` · `PUBLIC_URL` · `CHROME_PATH` | Rede e navegador |
| `WA_HEADFUL` · `WA_WEB_VERSION` | Controle da sessão WhatsApp |

### Estado persistente

Onze arquivos JSON em `data/` — `agenda` · `memory` · `faces` · `voices` · `portfolio`
· `watch` · `geo` · `wa-allow` · `wa-log` · `obsidian` · `google-token`.

**Copiar essa pasta é fazer o backup completo da plataforma.**

---

## Segurança

`data/` **nunca** é versionado. Contém:

| Arquivo | Conteúdo sensível |
|---|---|
| `google-token.json` | Token OAuth **ativo** do Gmail |
| `wa-session/` | Sessão do WhatsApp — permite **personificar o operador** |
| `faces.json` · `voices.json` | Biometria facial e vocal da família |
| `memory.json` | Memória pessoal e profissional |
| `watch.json` | Carteira de clientes sob vigilância |

### Princípios permanentes

- Credenciais aparecem por **nome**, jamais por valor
- Cofre de anotações (Obsidian) em modo **somente leitura**
- Resposta automática do WhatsApp exige **lista de permissão explícita** por contato
- Análise de mercado é **educativa** — nunca recomendação de investimento
- Cyber Security é **estritamente defensivo** — nunca ataca, nunca sugere contra-ataque
- Voz só é gravada com **nome declarado** — nunca em segredo

---

## Como estender

### Criar uma ferramenta nova — as cinco camadas

```
1. TOOLS[]                    server.js    → definição e input_schema
2. case 'nome'                server.js    → executor do servidor (execTool)
3. bullet no systemPrompt()   server.js    → o agente precisa saber que existe
4. LIVE_TOOL_NAMES[]          server.js    → liberação para o modo AO VIVO
5. case 'nome'                voice.js     → executor do NAVEGADOR (liveExecTool)
```

**A camada 5 é a mais esquecida.** Sintoma: funciona por texto, falha por voz.

### Verificador automático

```js
const live = fs.readFileSync('server.js','utf8')
  .match(/const LIVE_TOOL_NAMES = \[(.*?)\];/s)[1]
  .match(/'([^']+)'/g).map(s => s.replace(/'/g,''));
const voz = new Set((fs.readFileSync('assets/voice.js','utf8')
  .match(/case '[a-zA-Z_]+'/g) || []).map(s => s.replace(/case '|'/g,'')));
console.log(live.filter(t => !voz.has(t)));   // tem de sair []
```

Se a ferramenta precisar de rota HTTP (modo ao vivo), acrescente em `server.js` e faça o
executor do navegador chamá-la.

---

## Licença

Projeto proprietário — **Advanced Tech TI**. Todos os direitos reservados.
