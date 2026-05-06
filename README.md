# ELION-X AI Command Platform

Plataforma de inteligência artificial avançada com interface holográfica, chat em tempo real com Claude e sistema de voz bidirecional.

## Como rodar localmente

```bash
# 1. Clone o repositório
git clone https://github.com/SEU-USUARIO/elion-x.git
cd elion-x

# 2. Configure a API Key
cp .env.example .env
# Edite .env e adicione sua ANTHROPIC_API_KEY

# 3. Inicie o servidor
node server.js

# 4. Acesse
# http://localhost:3001
```

## Deploy no Railway

1. Faça push para o GitHub
2. Acesse [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Em **Variables**, adicione: `ANTHROPIC_API_KEY=sua-chave`
4. O Railway detecta automaticamente o `package.json` e roda `npm start`

## Variáveis de ambiente

| Variável | Descrição |
|----------|-----------|
| `ANTHROPIC_API_KEY` | Chave da API Anthropic Claude (**obrigatória**) |
| `PORT` | Porta do servidor (padrão: `3001`) |

## Stack

- **Frontend**: HTML5 + CSS3 + Vanilla JavaScript (sem frameworks)
- **Backend**: Node.js puro (sem dependências externas)
- **IA**: Claude Sonnet (Anthropic API) com streaming SSE
- **Voz**: Web Speech API (reconhecimento + síntese nativa do browser)
