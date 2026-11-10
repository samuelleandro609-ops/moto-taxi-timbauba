"use strict";

/**
 * moto-taxi-backend
 *
 * Backend do Moto Taxi Timbauba. Cria cobrancas Pix via Mercado Pago.
 * Uso unico: a DIARIA (R$ 5) que o mototaxi paga para rodar no app.
 * O comercio NAO paga nada a dona e nao usa este backend: o comercio paga
 * a entrega direto ao entregador, e o passageiro paga a corrida direto ao
 * mototaxi (Pix dele ou dinheiro), sem passar pelo app.
 *
 * O token de acesso do Mercado Pago vem SOMENTE da variavel de ambiente
 * MP_ACCESS_TOKEN. Nunca coloque o token no codigo, em arquivo ou em log.
 * Sem MP_ACCESS_TOKEN, /create-pix responde 503 e nunca gera QR falso.
 *
 * Presenca e chamados (/presence, /calls): o site e estatico e cada
 * aparelho so ve o proprio localStorage. Estes endpoints guardam em
 * MEMORIA quem esta online e quais chamados estao pendentes, para que um
 * celular e um PC vejam a mesma coisa. Nao ha banco de dados: se o
 * servico reiniciar (Render Free dorme), presenca e chamados somem e os
 * aparelhos reenviam o heartbeat / recriam o chamado. Nada aqui usa
 * chave ou token.
 *
 * Valores (/settings): a Administracao edita corrida, entrega e diaria;
 * o servidor guarda em MEMORIA e todos os aparelhos leem daqui, para o
 * valor valer em todos os aparelhos e nao so onde foi editado.
 *
 * Contas (/auth): registro e login no SERVIDOR (telefone + senha), para
 * a mesma conta funcionar em qualquer aparelho — antes a conta so
 * existia no localStorage de cada aparelho e a conta criada no celular
 * nao existia no PC (o login no PC dizia "incorreto" mesmo com a senha
 * certa). Senhas nunca ficam em texto claro: scrypt com salt (crypto
 * nativo, sem dependencia nova). Contas e sessoes ficam em accounts.json
 * (escrita atomica: grava temporario e renomeia), lido na inicializacao.
 * A primeira conta registrada vira admin (como era no aparelho: a
 * primeira conta criada). No Render Free o disco e efemero: se o
 * servico reiniciar, o arquivo some e as contas voltam pela migracao
 * automatica do app (ele reenvia a conta local uma vez); no VPS o disco
 * persiste e nada se perde. O Postgres gratuito do Render NAO serve
 * aqui: ele expira e e apagado depois de ~30 dias, entao as contas
 * sumiriam sozinhas.
 *
 * Comunicacao na corrida: SO o chat de AUDIO "Converse com o
 * mototaxi" (/calls/:id/messages) — audio gravado (nao ao vivo),
 * mais a foto do local. O texto foi REMOVIDO do chat (o TTS que lia
 * a mensagem digitada nao funcionou). O VoIP ao vivo (walkie-talkie,
 * WebRTC) foi REMOVIDO (nao funcionou): sem botao de falar, sem
 * codigo WebRTC e sem os endpoints de sinalizacao /calls/:id/signal.
 * A voz de navegacao (turn-by-turn) e o aviso "O destino e..."
 * continuam — sao separados do chat.
 *
 * v1.5.0: chamado/rota PERSISTE (GET /calls?callerPhone busca o
 * chamado ativo de quem chamou; POST /calls/:id/touch mantem o
 * chamado vivo enquanto o app esta aberto; POST /calls/:id/cancel
 * cancela — cliente ou moto; TTLs maiores); modo gratuito da diaria
 * (freeFee em /settings — com ele ligado o moto trabalha sem pagar,
 * sem Pix; com ele desligado o Pix vale como antes); chat da corrida
 * (/calls/:id/messages — audio gravado e foto entre cliente e moto).
 * GET /calls?excludeCaller tira o
 * chamado da lista de quem chamou (o chamado so vai para os motos).
 *
 * v1.6.0: a conta da DONA (a primeira registrada, administradora)
 * e ISENTA da diaria — nao paga nada e fica liberada para trabalhar
 * (feeExempt: true na conta, persistido em accounts.json; o app le
 * em GET /auth/me). Os demais mototaxis continuam pagando a diaria
 * de R$ 5 (ou o modo gratuito quando ligado). O servidor passa a
 * conferir a diaria em POST /presence (ficar online / heartbeat) e
 * em POST /calls/:id/accept: conta conhecida sem diaria valida
 * recebe 402 fee_required; conta isenta, com paidUntil valido ou
 * com freeFee ligado passa. Conta desconhecida (chave antiga sem
 * conta no servidor) segue como antes.
 *
 * v1.7.0: dias de validade da diaria configuraveis (feeDays em
 * /settings, padrao 1): UM pagamento do valor da diaria vale por N
 * dias — a dona escolhe N na Administracao e o valor da diaria so
 * muda se ela mudar. POST /auth/fee passa a calcular o paidUntil no
 * servidor (agora + feeDays * 24h); feeExempt e freeFee nao mudam.
 *
 * v1.8.0: chamados em grupo (so para passageiro): POST /calls aceita
 * os campos opcionais groupId (string, max 128), groupIndex e
 * groupTotal (inteiro 1 a 5). Um pedido de N motos cria N chamados
 * com o mesmo groupId, groupIndex 1..N e groupTotal N; cada chamado
 * continua independente e o aceite continua atomico (o primeiro
 * aceita, o segundo recebe 409 call_not_pending). Os tres campos
 * sao devolvidos em callPublic() em todas as respostas de chamado.
 * Um mototaxi so aceita UM chamado: quem ja tem um chamado aceito
 * ativo recebe 409 driver_already_has_call ao tentar aceitar outro
 * (os N chamados vao para N mototaxis diferentes).
 * REMOVIDO na v1.8.7 (decisao dela 09/11): o multi-moto acabou —
 * cada conta so chama UMA moto por vez. Os campos de grupo passam
 * a ser ignorados (todo chamado e avulso) e POST /calls rejeita
 * com 409 already_has_active_call quem ja tem um chamado ativo.
 * Chat so audio (decisao dela): POST /calls/:id/messages aceita
 * audio gravado (data URL audio/* em base64, max 200000 caracteres,
 * ate 60 s) e foto; o texto nao e mais enviado pelo app (o TTS do
 * chat foi removido). A voz de navegacao nao muda.
 *
 * v1.8.1: cancelamento pelo MOTOTAXI devolve o chamado para espera —
 * POST /calls/:id/cancel pelo mototaxi que aceitou (key ==
 * acceptedBy) num chamado aceito volta o chamado para status
 * "pending", phase "aguardando", acceptedBy/acceptedName limpos e
 * devolve returnedToPending: true: o chamado volta a apitar para os
 * outros mototaxis online aceitarem, o cliente continua vendo como
 * esperando e o mototaxi fica livre para aceitar outro chamado. O
 * cancelamento pelo CLIENTE nao muda: cancela o chamado de vez
 * (status "cancelled").
 *
 * v1.8.2: audio do chat aceita parametros MIME (;codecs=opus) — o
 * MediaRecorder do Chrome/Android produz
 * data:audio/webm;codecs=opus;base64,... e o regex anterior
 * rejeitava com 400 invalid_audio: o audio "enviado" nunca era
 * salvo. Nenhuma outra mudanca de comportamento.
 *
 * v1.8.7: multi-moto REMOVIDO (decisao dela 09/11): cada conta so
 * pode chamar UMA moto por vez. POST /calls rejeita com 409
 * already_has_active_call quem ja tem um chamado ATIVO (pendente
 * ou aceito — a mesma definicao do GET /calls?callerPhone);
 * concluido/cancelado/expirado nao bloqueia. Os campos groupId,
 * groupIndex e groupTotal passam a ser IGNORADOS no corpo do
 * POST /calls: todo chamado nasce avulso (groupId null,
 * groupIndex 1, groupTotal 1) e a validacao invalid_group some —
 * um cliente antigo que mandar groupTotal > 1 cria UM chamado so,
 * nunca um grupo. Os tres campos continuam em callPublic() com
 * os valores avulsos, para o app antigo nao quebrar ao ler.
 * O resto nao muda: aceite de um toque, um chamado por mototaxi
 * (409 driver_already_has_call), cancelamento (mototaxi volta
 * para espera, cliente cancela de vez), chat de audio, diaria
 * e Pix continuam iguais.
 *
 * v1.8.8: dias da diaria POR CONTA + editar conta (pedidos dela
 * 09/11): cada conta pode ter o proprio feeDays (inteiro >= 1,
 * guardado em accounts.json; null/ausente = usar a configuracao
 * geral em /settings). POST /auth/fee calcula o paidUntil com o
 * feeDays DA CONTA quando definido, senao o geral — mudar o
 * feeDays nao altera um paidUntil ja pago, vale para o proximo
 * pagamento. Novo PATCH /auth/users/:id (so admin) edita name,
 * phone e feeDays da conta (feeDays null volta ao geral); so
 * mexe nesses tres campos — nunca em isAdmin nem feeExempt.
 * GET /auth/users (e toda resposta com a conta) passa a incluir
 * feeDays (null quando nao definido). MP_API_BASE (env, so para
 * teste local) permite apontar o Mercado Pago para um mock.
 *
 * v1.8.9: ENTREGA ja coletada nao pode ser cancelada pelo MOTOTAXI
 * (regra dela 09/11): POST /calls/:id/cancel pelo mototaxi que aceitou
 * uma entrega com phase "coleta_confirmada" devolve 409
 * delivery_already_collected e o chamado continua aceito — ele ja esta
 * com o produto e tem que entregar ate o fim. A caminho da coleta o
 * cancelamento continua como antes (volta para espera) e a corrida
 * (passageiro) nao muda, nem o cancelamento pelo cliente.
 *
 * v1.8.11: VERIFICACAO DE QUEM PODE TRABALHAR DE GRACA (decisao dela
 * 10/11): com o modo gratuito ligado, trabalhar de graca exige a conta
 * LIBERADA pela dona (freeAuthorized: true na conta, persistido em
 * accounts.json). A dona gera um CODIGO de 6 digitos para a conta
 * (POST /auth/free-code/generate, so admin; uso unico, vale 30 min;
 * gerar outro invalida o anterior) e manda no WhatsApp dela mesma; o
 * mototaxi digita o codigo no app (POST /auth/free-code/verify) e a
 * conta fica liberada — o codigo so vale para a conta para a qual foi
 * gerado. A liberacao persiste na conta: desligou o gratuito, ninguem
 * trabalha de graca (nem quem ja digitou o codigo) e tem que pagar a
 * diaria; ligou de novo, quem ja foi liberado trabalha de graca sem
 * digitar nada. A dona REVOGA a liberacao com PATCH /auth/users/:id
 * {freeAuthorized:false} (e pode liberar direto com true). A diaria
 * PAGA continua valendo como antes (quem pagou trabalha sem codigo)
 * e a conta isenta (a dona) tambem. O servidor passa a conferir em
 * POST /presence e POST /calls/:id/accept: conta conhecida sem
 * diaria valida e sem liberacao no modo gratuito recebe 402
 * free_authorization_required (erro distinto de fee_required, que
 * continua para a diaria vencida com o gratuito desligado).
 * GET /auth/users (e toda resposta com a conta) passa a incluir
 * freeAuthorized. Os codigos vivem em free-codes.json (persistido).
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MP_API =
  (process.env.MP_API_BASE || "").trim() ||
  "https://api.mercadopago.com/v1/payments";
// MP_API_BASE (env, SO para teste local): aponta a API do Mercado Pago
// para outro endereco — o test-local.js usa um mock local para testar
// o POST /auth/fee sem chamar o Mercado Pago de verdade. Sem ela, o
// padrao acima vale e nada muda em producao.
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://moto-taxi-timbauba.onrender.com";

// CORS manual e estrito: so o site do Moto Taxi Timbauba recebe
// Access-Control-Allow-Origin. Outra origem nao recebe o cabecalho,
// entao o navegador dela bloqueia a resposta. Requisicoes sem Origin
// (curl, servidor-para-servidor) passam sem cabecalho CORS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.sendStatus(204);
    }
  }
  return next();
});
app.use(express.json({ limit: "256kb" }));

// Corpo JSON invalido -> 400 em JSON (em vez do HTML padrao do Express).
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ error: "invalid_json", message: "Corpo JSON invalido." });
  }
  return next(err);
});

function mpToken() {
  const t = (process.env.MP_ACCESS_TOKEN || "").trim();
  return t || null;
}

function tokenNotConfigured(res) {
  return res.status(503).json({
    error: "token_not_configured",
    message:
      "MP_ACCESS_TOKEN is not configured on this server. Set it in the Render dashboard Environment settings."
  });
}

async function mpRequest(path, options) {
  const token = mpToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    };
    // O Mercado Pago exige X-Idempotency-Key em POST /v1/payments: sem
    // ele a API recusa com 502 "Header X-Idempotency-Key can't be null".
    // Quem chama passa a chave (no /create-pix e o external_ref, unico
    // por cobranca, entao uma repeticao nao cria outra cobranca).
    if (options && options.idempotencyKey) {
      headers["X-Idempotency-Key"] = String(options.idempotencyKey);
    }
    const resp = await fetch(MP_API + path, {
      method: (options && options.method) || "GET",
      body: options && options.body ? options.body : undefined,
      signal: controller.signal,
      headers
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    return { status: resp.status, ok: resp.ok, data, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

function mpErrorDetail(result) {
  if (result.data && (result.data.message || result.data.error)) {
    return String(result.data.message || result.data.error);
  }
  return result.raw ? String(result.raw) : "Mercado Pago error";
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "moto-taxi-backend", version: "1.8.11" });
});

app.post("/create-pix", requireAuth, async (req, res) => {
  if (!mpToken()) return tokenNotConfigured(res);

  const body = req.body || {};
  const amount = body.amount;
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const external_ref =
    typeof body.external_ref === "string" ? body.external_ref.trim() : "";
  const payer_email =
    typeof body.payer_email === "string" ? body.payer_email.trim() : "";

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: "invalid_amount",
      message: "amount must be a positive number."
    });
  }
  if (!description) {
    return res
      .status(400)
      .json({ error: "missing_description", message: "description is required." });
  }
  if (!external_ref) {
    return res.status(400).json({
      error: "missing_external_ref",
      message: "external_ref is required."
    });
  }
  if (!payer_email || payer_email.indexOf("@") === -1) {
    return res.status(400).json({
      error: "invalid_payer_email",
      message: "payer_email must be a valid email address."
    });
  }

  try {
    const result = await mpRequest("", {
      method: "POST",
      idempotencyKey: external_ref,
      body: JSON.stringify({
        transaction_amount: amount,
        description,
        payment_method_id: "pix",
        payer: { email: payer_email },
        external_reference: external_ref
      })
    });

    if (!result.ok) {
      return res.status(502).json({
        error: "mercadopago_error",
        status: result.status,
        detail: mpErrorDetail(result).slice(0, 500)
      });
    }

    const d = result.data || {};
    const tx =
      (d.point_of_interaction && d.point_of_interaction.transaction_data) || {};
    // Registra a cobranca (valor + valor da diaria na hora): o /auth/fee
    // confere o pagamento contra isto, e nao contra um valor mandado
    // pelo aparelho.
    prunePixCharges();
    pixCharges.set(external_ref, { amount, fee: appSettings.fee, createdAt: Date.now() });
    savePixCharges(); // persiste na hora: a cobrança sobrevive ao reinicio
    return res.status(201).json({
      id: d.id,
      status: d.status,
      qr_code: tx.qr_code || d.qr_code || null,
      qr_code_base64: tx.qr_code_base64 || d.qr_code_base64 || null,
      ticket_url: tx.ticket_url || d.ticket_url || null
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Mercado Pago request timed out."
        : "Could not reach Mercado Pago.";
    return res.status(502).json({ error: "mercadopago_unreachable", message: msg });
  }
});

app.get("/payment/:id", requireAuth, async (req, res) => {
  if (!mpToken()) return tokenNotConfigured(res);

  const id = String(req.params.id || "").trim();
  if (!id) {
    return res
      .status(400)
      .json({ error: "missing_id", message: "payment id is required." });
  }

  try {
    const result = await mpRequest("/" + encodeURIComponent(id), {
      method: "GET"
    });

    if (!result.ok) {
      return res.status(502).json({
        error: "mercadopago_error",
        status: result.status,
        detail: mpErrorDetail(result).slice(0, 500)
      });
    }

    const d = result.data || {};
    return res.json({
      id: d.id,
      status: d.status,
      status_detail: d.status_detail || null,
      transaction_amount: d.transaction_amount,
      external_reference: d.external_reference || null
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Mercado Pago request timed out."
        : "Could not reach Mercado Pago.";
    return res.status(502).json({ error: "mercadopago_unreachable", message: msg });
  }
});

// ---------------------------------------------------------------------------
// Valores (corrida, entrega, diaria) — sincronizacao entre aparelhos
//
// A Administracao do site edita os valores; o site grava aqui (POST
// /settings) e todos os aparelhos leem daqui (GET /settings, a cada
// ~25 s). Antes nao havia rota no servidor e o valor so mudava no
// aparelho onde foi editado (o mototaxi continuava vendo R$ 8).
// Em MEMORIA, como presenca e chamados: se o servico reiniciar, volta
// aos padroes (corrida 8, entrega 7, diaria 5) e a Administracao grava
// de novo. settingsAt e o carimbo da alteracao: so vale o mais recente,
// para um aparelho atrasado nao ressuscitar um valor antigo.
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = { ride: 8, delivery: 7, fee: 5, freeFee: false, feeDays: 1 };
let appSettings = { ...DEFAULT_SETTINGS, settingsAt: 0 };

// Persistencia dos ajustes (v1.8.4): settings.json ao lado do server.js,
// escrita atomica (tmp + rename), mesmo padrao do accounts.json. Sem isto,
// o freeFee e os valores viviam SO na memoria: quando o Render Free
// dormia/reiniciava, tudo voltava para o padrao (freeFee=false) e a
// Administracao continuava mostrando "ativado" — o servidor bloqueava
// conta nova por falta de diaria (402) mesmo com o gratis "ligado" na
// tela, e a dona tinha que desligar e ligar de novo para liberar. Com o
// arquivo, o gratis sobrevive ao sono (o disco persiste na suspensao);
// num redeploy (disco apagado) volta ao padrao, mas o carimbo abaixo faz
// os aparelhos aplicarem o reset em vez de divergirem.
const SETTINGS_FILE =
  process.env.SETTINGS_FILE || path.join(__dirname, "settings.json");

function loadAppSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      // Sem arquivo (1a subida ou disco apagado no redeploy): carimbo
      // FRESCO, nao 0 — assim os aparelhos aplicam o reset (padrao) em
      // vez de ignorarem um carimbo 0 e manterem um gratis que o
      // servidor nao tem mais.
      appSettings.settingsAt = Date.now();
      return;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (typeof data.ride === "number" && data.ride >= 0) appSettings.ride = data.ride;
      if (typeof data.delivery === "number" && data.delivery >= 0) appSettings.delivery = data.delivery;
      if (typeof data.fee === "number" && data.fee >= 0) appSettings.fee = data.fee;
      if (typeof data.feeDays === "number" && Number.isInteger(data.feeDays) && data.feeDays >= 1)
        appSettings.feeDays = data.feeDays;
      if (typeof data.freeFee === "boolean") appSettings.freeFee = data.freeFee;
      if (typeof data.settingsAt === "number" && data.settingsAt > 0) appSettings.settingsAt = data.settingsAt;
      else appSettings.settingsAt = Date.now();
    } else {
      console.log("settings.json invalido (formato inesperado); comecando com os padroes.");
      appSettings.settingsAt = Date.now();
    }
  } catch (err) {
    console.log("nao foi possivel ler settings.json (" + err.message + "); comecando com os padroes.");
    appSettings.settingsAt = Date.now();
  }
}

function saveAppSettings() {
  try {
    const tmp = SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(appSettings), "utf8");
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (err) {
    console.log("nao foi possivel gravar settings.json: " + err.message);
  }
}

// Dias de validade da diaria (v1.7.0): UM pagamento do valor da diaria
// vale por feeDays dias — a dona escolhe N na Administracao (padrao 1,
// ou seja, 24h como antes). O VALOR da diaria so muda se ela mudar;
// aqui so muda por quantos dias o valor pago fica valendo. POST
// /auth/fee calcula paidUntil = agora + feeDays * 24h no servidor.

// Modo gratuito da diaria: quando freeFee e true, o mototaxi trabalha
// sem pagar a diaria (sem Pix, sem trava). Com freeFee false, o Pix
// vale como antes (pagamento obrigatorio, paidUntil = agora +
// feeDays * 24h). Zerar o valor da diaria SOZINHO nao deixa gratis —
// sem a flag, a trava continua exigindo paidUntil e ninguem consegue
// ficar online.
function pickBoolean(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "sim") return true;
      if (s === "false" || s === "0" || s === "nao" || s === "não") return false;
    }
  }
  return undefined;
}

function pickNumber(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

// Dias de validade da diaria: so vale inteiro positivo (1, 2, 7...).
// Devolve undefined quando o campo nao veio (null tambem conta como
// ausente, como em pickNumber); devolve null quando veio um valor
// invalido (0, negativo, fracao, texto nao-numerico, booleano) —
// o chamador responde 400 e nao altera nada.
function pickFeeDays(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "number") {
      return Number.isInteger(v) && v > 0 ? v : null;
    }
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    return null;
  }
  return undefined;
}

function settingsPublic() {
  const s = appSettings;
  // Devolve todas as variacoes de nome que o site pode usar, no topo e
  // aninhadas em "settings", para o aparelho achar os valores do jeito
  // que ele espera.
  return {
    ok: true,
    ride: s.ride,
    delivery: s.delivery,
    fee: s.fee,
    feeDays: s.feeDays,
    fee_days: s.feeDays,
    diasDiaria: s.feeDays,
    freeFee: !!s.freeFee,
    free_fee: !!s.freeFee,
    diariaGratis: !!s.freeFee,
    ridePrice: s.ride,
    deliveryPrice: s.delivery,
    dailyFee: s.fee,
    corrida: s.ride,
    entrega: s.delivery,
    diaria: s.fee,
    settingsAt: s.settingsAt,
    settings: {
      ride: s.ride,
      delivery: s.delivery,
      fee: s.fee,
      feeDays: s.feeDays,
      fee_days: s.feeDays,
      diasDiaria: s.feeDays,
      freeFee: !!s.freeFee,
      free_fee: !!s.freeFee,
      diariaGratis: !!s.freeFee,
      ridePrice: s.ride,
      deliveryPrice: s.delivery,
      dailyFee: s.fee,
      corrida: s.ride,
      entrega: s.delivery,
      diaria: s.fee,
      settingsAt: s.settingsAt
    }
  };
}

// GET /settings — valores atuais para todos os aparelhos.
app.get("/settings", (req, res) => {
  return res.json(settingsPublic());
});

// POST /settings — a Administracao grava os valores novos. Corpo com os
// valores e settingsAt (carimbo). So vale se o carimbo for mais recente
// que o guardado; um POST mais antigo nao sobrescreve o mais novo.
app.post("/settings", requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const ride = pickNumber(body, ["ride", "ridePrice", "priceRide", "corrida", "ride_value"]);
  const delivery = pickNumber(body, ["delivery", "deliveryPrice", "priceDelivery", "entrega", "delivery_value"]);
  const fee = pickNumber(body, ["fee", "dailyFee", "diaria", "daily_fee", "daily", "fee_value"]);
  const feeDays = pickFeeDays(body, ["feeDays", "fee_days", "diasDiaria"]);
  const freeFee = pickBoolean(body, ["freeFee", "free_fee", "free", "diariaGratis", "gratis"]);
  const at = pickNumber(body, ["settingsAt", "updatedAt", "timestamp", "version"]);

  if (feeDays === null) {
    // Dias de validade invalido (0, negativo, fracao ou nao-numerico):
    // 400 e nao altera nada — nem os outros valores do mesmo POST.
    return res.status(400).json({
      error: "invalid_feeDays",
      message: "feeDays must be a positive integer."
    });
  }
  if (ride === undefined && delivery === undefined && fee === undefined && feeDays === undefined && freeFee === undefined) {
    return res.status(400).json({
      error: "invalid_settings",
      message: "at least one of ride, delivery, fee, feeDays or freeFee must be provided."
    });
  }
  const incomingAt = typeof at === "number" ? at : Date.now();
  if (incomingAt < appSettings.settingsAt) {
    // Carimbo mais antigo que o guardado: nao sobrescreve.
    return res.json({ ok: true, stale: true, ...settingsPublic() });
  }
  if (ride !== undefined) appSettings.ride = ride;
  if (delivery !== undefined) appSettings.delivery = delivery;
  if (fee !== undefined) appSettings.fee = fee;
  if (feeDays !== undefined) appSettings.feeDays = feeDays;
  if (freeFee !== undefined) appSettings.freeFee = freeFee;
  appSettings.settingsAt = incomingAt;
  saveAppSettings(); // persiste na hora: o gratis e os valores sobrevivem ao sono do Render Free
  return res.json({ ok: true, ...settingsPublic() });
});

// ---------------------------------------------------------------------------
// Presenca e chamados (sincronizacao entre aparelhos, nos DOIS sentidos)
//
// O site e estatico: cada aparelho so ve o proprio localStorage. Estes
// endpoints guardam em MEMORIA quem esta online e quais chamados estao
// pendentes, para que qualquer aparelho veja o mesmo estado — um celular
// online aparece no PC e um PC online aparece no celular; um chamado
// feito em qualquer aparelho chega ao mototaxi em qualquer aparelho.
// Nao ha banco de dados: se o servico reiniciar (Render Free dorme),
// presenca e chamados somem e os aparelhos reenviam o heartbeat /
// recriam o chamado. Nada aqui usa chave ou token.
// ---------------------------------------------------------------------------

const PRESENCE_TTL_MS = 15000; // heartbeat recente: ultimos 15 s
// O chamado/rota PERSISTE: so termina quando alguem cancela ou conclui
// (ou conclui a entrega/corrida). Por isso os prazos sao longos —
// fechar a janela ou o app nao pode apagar o chamado. O app mantem o
// chamado vivo com POST /calls/:id/touch enquanto esta aberto, e ao
// reabrir busca o chamado ativo (GET /calls?callerPhone / ?mine).
const CALL_PENDING_TTL_MS = 60 * 60 * 1000; // chamado pendente expira em 60 min
const CALL_ACTIVE_TTL_MS = 180 * 60 * 1000; // aceito expira em 180 min (3 h)
const CALL_DONE_TTL_MS = 10 * 60 * 1000; // concluido/cancelado fica visivel por 10 min

// key (chave da conta) -> { key, name, photo, bike, plate, lat, lng, online, updatedAt }
const presence = new Map();
// id -> { id, callerName, callerPhone, targetKey, targetName, type, pickup,
//         destination, amount, groupId, groupIndex, groupTotal, status, phase,
//         acceptedBy, acceptedName, createdAt, updatedAt, completedAt }
// groupId/groupIndex/groupTotal existem so por compatibilidade com o app
// antigo: desde a v1.8.7 todo chamado nasce avulso (null/1/1) — o
// multi-moto foi removido e os campos do corpo do POST /calls sao
// ignorados.
const calls = new Map();
let callSeq = 0;

// Cobrancas Pix da diaria ja criadas (external_ref -> {amount, fee,
// createdAt}): o /auth/fee confere o pagamento contra o valor cobrado e
// contra o valor da diaria na hora da cobranca, para ninguem liberar a
// diaria com um pagamento de outro valor. PERSISTIDAS em pix-charges.json
// (v1.8.10, mesmo padrao atomico do settings.json): antes viviam SO na
// memoria e sumiam no reinicio — ai o /auth/fee caia para o valor ATUAL
// da diaria e recusava um pagamento feito com o valor ANTIGO (ex.: a
// dona mudou a diaria de R$ 10 para R$ 1 e o mototaxi pagou a cobrança
// de R$ 10 gerada antes da mudança: o pagamento era rejeitado e a
// diaria nao liberava, mesmo com o dinheiro pago). Com o arquivo, a
// cobrança sobrevive ao reinicio e o pagamento do valor cobrado e
// aceito. Validade 24h (prune), como antes.
const PIX_CHARGES_FILE =
  process.env.PIX_CHARGES_FILE || path.join(__dirname, "pix-charges.json");
const pixCharges = new Map();
function loadPixCharges() {
  try {
    if (!fs.existsSync(PIX_CHARGES_FILE)) return;
    const raw = fs.readFileSync(PIX_CHARGES_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (v && typeof v.amount === "number" && typeof v.createdAt === "number") {
          pixCharges.set(k, { amount: v.amount, fee: v.fee, createdAt: v.createdAt });
        }
      }
    }
  } catch (err) {
    console.log("nao foi possivel ler pix-charges.json (" + err.message + "); comecando sem cobrancas registradas.");
  }
  prunePixCharges();
}
function savePixCharges() {
  try {
    const obj = {};
    pixCharges.forEach((v, k) => { obj[k] = v; });
    const tmp = PIX_CHARGES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, PIX_CHARGES_FILE);
  } catch (err) {
    console.log("nao foi possivel gravar pix-charges.json: " + err.message);
  }
}
function prunePixCharges() {
  const now = Date.now();
  let removed = false;
  pixCharges.forEach((v, k) => {
    if (now - (v.createdAt || 0) > 24 * 3600 * 1000) { pixCharges.delete(k); removed = true; }
  });
  if (removed) savePixCharges();
}

// CODIGOS DE LIBERACAO PARA TRABALHAR DE GRACA (v1.8.11): a dona gera
// um codigo de 6 digitos para UMA conta (POST /auth/free-code/generate)
// e manda no WhatsApp dela mesma; o mototaxi digita no app (POST
// /auth/free-code/verify). Uso unico, vale 30 min; gerar outro para
// a mesma conta invalida o anterior. Persistido em free-codes.json
// para sobreviver ao reinicio (igual ao pix-charges.json).
const FREE_CODES_FILE =
  process.env.FREE_CODES_FILE || path.join(__dirname, "free-codes.json");
const FREE_CODE_TTL_MS = 30 * 60 * 1000; // codigo vale 30 minutos
let freeCodes = []; // {code, accountId, createdAt, expiresAt, used}

function loadFreeCodes() {
  try {
    if (!fs.existsSync(FREE_CODES_FILE)) return;
    const raw = fs.readFileSync(FREE_CODES_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data)) {
      freeCodes = data.filter(
        (c) =>
          c &&
          typeof c.code === "string" &&
          typeof c.accountId === "string" &&
          typeof c.expiresAt === "number"
      );
    }
  } catch (err) {
    console.log("nao foi possivel ler free-codes.json (" + err.message + "); comecando sem codigos.");
  }
  pruneFreeCodes();
}
function saveFreeCodes() {
  try {
    const tmp = FREE_CODES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(freeCodes), "utf8");
    fs.renameSync(tmp, FREE_CODES_FILE);
  } catch (err) {
    console.log("nao foi possivel gravar free-codes.json: " + err.message);
  }
}
function pruneFreeCodes() {
  const now = Date.now();
  const kept = freeCodes.filter((c) => (c.expiresAt || 0) > now);
  if (kept.length !== freeCodes.length) {
    freeCodes = kept;
    saveFreeCodes();
  }
}

function cleanStr(v, max) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function freshPresence(p) {
  return Date.now() - p.updatedAt <= PRESENCE_TTL_MS;
}

function callPublic(c) {
  return {
    id: c.id,
    callerName: c.callerName,
    callerPhone: c.callerPhone,
    targetKey: c.targetKey,
    targetName: c.targetName,
    type: c.type,
    pickup: c.pickup,
    destination: c.destination,
    amount: c.amount,
    groupId: c.groupId !== undefined && c.groupId !== null ? c.groupId : null,
    groupIndex: c.groupIndex !== undefined && c.groupIndex !== null ? c.groupIndex : 1,
    groupTotal: c.groupTotal !== undefined && c.groupTotal !== null ? c.groupTotal : 1,
    status: c.status,
    phase: c.phase,
    acceptedBy: c.acceptedBy,
    acceptedName: c.acceptedName,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    completedAt: c.completedAt
  };
}

function pruneStores() {
  const now = Date.now();
  for (const [key, p] of presence) {
    if (now - p.updatedAt > PRESENCE_TTL_MS) presence.delete(key);
  }
  for (const [id, c] of calls) {
    const ttl =
      c.status === "pending"
        ? CALL_PENDING_TTL_MS
        : c.status === "accepted"
          ? CALL_ACTIVE_TTL_MS
          : CALL_DONE_TTL_MS;
    if (now - c.updatedAt > ttl) {
      calls.delete(id);
      chatMessages.delete(id);
    }
  }
}
setInterval(pruneStores, 10000).unref();

// POST /presence — heartbeat do mototaxi (chamado a cada poucos segundos
// enquanto ele esta online). Corpo: { key, name, photo, bike, plate, lat,
// lng, online, busy }. online=false tira o moto da lista na hora. busy=true
// diz que ele esta em servico (com viagem ativa) — o app le de volta no
// GET /presence para mostrar "Em servico" nos outros aparelhos. Se photo
// vier vazia, mantem a foto do heartbeat anterior.
app.post("/presence", (req, res) => {
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!key) {
    return res
      .status(400)
      .json({ error: "missing_key", message: "key is required." });
  }
  if (body.online !== true) {
    presence.delete(key);
    return res.json({ ok: true, online: false, key });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return res
      .status(400)
      .json({ error: "invalid_location", message: "lat/lng are required." });
  }
  // Diaria: so fica online (e mantem o heartbeat) quem tem a diaria
  // valida — paga, isento (a dona) ou modo gratuito ligado COM a conta
  // liberada pela dona (freeAuthorized, v1.8.11). Conta conhecida sem
  // diaria valida recebe 402: free_authorization_required no modo
  // gratuito sem liberacao, fee_required nos demais casos. Conta
  // desconhecida (chave antiga, sem conta no servidor) segue como antes.
  const account = findAccountById(key);
  if (account && !isFeeValid(account)) {
    const reason = feeBlockReason(account);
    if (reason === "free_authorization_required") {
      return res.status(402).json({
        error: "free_authorization_required",
        message: "free work requires the admin authorization code."
      });
    }
    return res.status(402).json({
      error: "fee_required",
      message: "daily fee is required to go online."
    });
  }
  const prev = presence.get(key);
  const photo = cleanStr(body.photo, 200000);
  presence.set(key, {
    key,
    name: cleanStr(body.name, 80),
    photo: photo || (prev ? prev.photo : ""),
    bike: cleanStr(body.bike, 80),
    plate: cleanStr(body.plate, 16),
    lat,
    lng,
    online: true,
    busy: body.busy === true,
    updatedAt: Date.now()
  });
  return res.json({ ok: true, online: true, key });
});

// GET /presence — motos online agora (so as com heartbeat nos ultimos 15 s).
app.get("/presence", (req, res) => {
  pruneStores();
  const drivers = [];
  for (const p of presence.values()) {
    if (!freshPresence(p)) continue;
    drivers.push({
      key: p.key,
      name: p.name,
      photo: p.photo,
      bike: p.bike,
      plate: p.plate,
      lat: p.lat,
      lng: p.lng,
      busy: p.busy === true,
      updatedAt: p.updatedAt
    });
  }
  return res.json({ ok: true, drivers, count: drivers.length });
});

// POST /calls — cria um chamado. Corpo: { callerName, callerPhone,
// targetKey (null = para qualquer moto), targetName, type
// ("corrida"|"entrega"), pickup, destination, amount }.
// Uma conta, UM chamado ativo por vez (v1.8.7): quem ja tem um
// chamado pendente ou aceito recebe 409 already_has_active_call —
// a mesma definicao de "ativo" do GET /calls?callerPhone. Concluido,
// cancelado ou expirado nao bloqueia: depois de terminar o primeiro,
// um novo chamado e aceito. Isto impede um cliente antigo de criar
// varios chamados (ou grupos) mandando varios POST /calls.
// Os campos groupId, groupIndex e groupTotal (v1.8.0, multi-moto)
// sao IGNORADOS desde a v1.8.7: todo chamado nasce avulso
// (groupId null, groupIndex 1, groupTotal 1) e nao existe mais
// validacao invalid_group — um cliente antigo que mandar
// groupTotal > 1 cria UM chamado so, nunca um grupo.
app.post("/calls", (req, res) => {
  pruneStores();
  const body = req.body || {};
  const type = cleanStr(body.type, 20);
  if (type !== "corrida" && type !== "entrega") {
    return res.status(400).json({
      error: "invalid_type",
      message: 'type must be "corrida" or "entrega".'
    });
  }
  const pickup = cleanStr(body.pickup, 300);
  const destination = cleanStr(body.destination, 300);
  if (!pickup || !destination) {
    return res.status(400).json({
      error: "missing_address",
      message: "pickup and destination are required."
    });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({
      error: "invalid_amount",
      message: "amount must be a number >= 0."
    });
  }
  const callerPhone = cleanStr(body.callerPhone, 32);
  // Uma conta, um chamado ativo por vez: procura um chamado pendente
  // ou aceito do MESMO chamador (mesma chave que o codigo ja usa —
  // callerPhone, igual a logica de callParty). Chamado concluido ou
  // cancelado nao bloqueia. Sem callerPhone nao da para identificar
  // quem chama, entao nao ha o que checar (o app sempre manda).
  if (callerPhone) {
    for (const other of calls.values()) {
      if (other.status !== "pending" && other.status !== "accepted") continue;
      if (!sameCaller(other.callerPhone, callerPhone)) continue;
      return res.status(409).json({
        error: "already_has_active_call",
        message: "voce ja tem um chamado ativo.",
        call: callPublic(other)
      });
    }
  }
  const id =
    "call_" +
    Date.now().toString(36) +
    "_" +
    (callSeq++).toString(36) +
    Math.floor(Math.random() * 1296).toString(36);
  const now = Date.now();
  const call = {
    id,
    callerName: cleanStr(body.callerName, 80),
    callerPhone,
    targetKey: cleanStr(body.targetKey, 128) || null,
    targetName: cleanStr(body.targetName, 80) || null,
    type,
    pickup,
    destination,
    amount,
    // Grupo neutralizado (v1.8.7): os campos do corpo sao ignorados —
    // todo chamado e avulso, sempre.
    groupId: null,
    groupIndex: 1,
    groupTotal: 1,
    status: "pending",
    phase: "aguardando",
    acceptedBy: null,
    acceptedName: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  calls.set(id, call);
  return res.status(201).json({ ok: true, call: callPublic(call) });
});

// GET /calls — chamados pendentes (padrao). ?status=all lista todos;
// ?mine=<key> lista os aceitos por aquele mototaxi (para ele acompanhar
// o chamado ativo dele em qualquer aparelho); ?callerPhone=<telefone>
// lista os chamados ATIVOS (pendente ou aceito) de quem chamou — e o
// que o app usa ao reabrir para RESTAURAR o chamado/rota que estava
// em andamento; ?excludeCaller=<telefone> tira da lista os chamados
// feitos por aquele telefone — e o que os motos usam para o chamado
// NAO aparecer para quem chamou (só vai para quem esta trabalhando).
app.get("/calls", (req, res) => {
  pruneStores();
  const status = cleanStr(req.query.status, 20) || "pending";
  const mine = cleanStr(req.query.mine, 128);
  const callerPhone = normalizePhone(req.query.callerPhone || "");
  const excludeCaller = normalizePhone(req.query.excludeCaller || "");
  const list = [];
  for (const c of calls.values()) {
    if (callerPhone) {
      // Chamado ativo de quem chamou: so pendente ou aceito.
      if (normalizePhone(c.callerPhone) !== callerPhone) continue;
      if (c.status !== "pending" && c.status !== "accepted") continue;
    } else if (mine) {
      if (c.acceptedBy !== mine) continue;
    } else if (status !== "all" && c.status !== status) {
      continue;
    }
    // O chamado nunca aparece para quem chamou.
    if (excludeCaller && normalizePhone(c.callerPhone) === excludeCaller) continue;
    list.push(callPublic(c));
  }
  list.sort((a, b) => a.createdAt - b.createdAt);
  return res.json({ ok: true, calls: list, count: list.length });
});

// GET /calls/:id — detalhe de um chamado.
app.get("/calls/:id", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/accept — um mototaxi aceita o chamado. Corpo:
// { key, name }. So o primeiro aceita (os outros recebem 409 e o
// chamado some da lista de pendentes deles). Se o chamado foi dirigido
// a um moto (targetKey), so ele pode aceitar (403 para os demais).
// Um mototaxi so aceita UM chamado: quem ja tem um chamado aceito
// ativo recebe 409 driver_already_has_call ("voce ja aceitou um
// chamado") ao tentar aceitar outro.
app.post("/calls/:id/accept", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status !== "pending") {
    return res.status(409).json({
      error: "call_not_pending",
      message: "call is already " + c.status + ".",
      call: callPublic(c)
    });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!key) {
    return res
      .status(400)
      .json({ error: "missing_key", message: "key is required." });
  }
  // Ninguem aceita o proprio chamado: as guardas existiam so no app
  // (a lista filtrava), mas a API aceitava — com duas contas, o autor
  // do chamado podia aceita-lo.
  if (key === c.callerPhone) {
    return res.status(403).json({
      error: "cannot_accept_own_call",
      message: "you cannot accept your own call."
    });
  }
  if (c.targetKey && c.targetKey !== key) {
    return res.status(403).json({
      error: "not_targeted_driver",
      message: "this call is directed to another driver."
    });
  }
  // Diaria: so aceita chamado quem tem a diaria valida — paga,
  // isento (a dona) ou modo gratuito ligado COM a conta liberada
  // pela dona (freeAuthorized, v1.8.11). Conta conhecida sem diaria
  // valida recebe 402: free_authorization_required no modo gratuito
  // sem liberacao, fee_required nos demais casos. Conta desconhecida
  // segue como antes.
  const account = findAccountById(key);
  if (account && !isFeeValid(account)) {
    const reason = feeBlockReason(account);
    if (reason === "free_authorization_required") {
      return res.status(402).json({
        error: "free_authorization_required",
        message: "free work requires the admin authorization code."
      });
    }
    return res.status(402).json({
      error: "fee_required",
      message: "daily fee is required to accept calls."
    });
  }
  // Um mototaxi so aceita UM chamado (v1.8.0, mantido na v1.8.7):
  // quem ja tem um chamado aceito ativo nao pode aceitar outro.
  // Erro distinto do call_not_pending
  // (caso 1: o chamado ja foi aceito por outro): aqui e o caso 2, o
  // mototaxi ja tem um chamado ("voce ja aceitou um chamado"). A
  // checagem fica no mesmo handler, antes de marcar o aceite (atomica).
  for (const other of calls.values()) {
    if (
      other.id !== c.id &&
      other.status === "accepted" &&
      other.acceptedBy === key
    ) {
      return res.status(409).json({
        error: "driver_already_has_call",
        message: "voce ja aceitou um chamado.",
        call: callPublic(other)
      });
    }
  }
  c.status = "accepted";
  c.phase = "a_caminho_coleta";
  c.acceptedBy = key;
  c.acceptedName = cleanStr(body.name, 80);
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/phase — atualiza a fase do chamado. Corpo:
// { phase } — ex.: "coleta_confirmada", "a_caminho_entrega".
// Nao aceita fase em chamado ja concluido (409).
app.post("/calls/:id/phase", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed") {
    return res.status(409).json({
      error: "call_completed",
      message: "call is already completed.",
      call: callPublic(c)
    });
  }
  if (c.status === "cancelled" || c.status === "canceled") {
    return res.status(409).json({
      error: "call_cancelled",
      message: "call is cancelled.",
      call: callPublic(c)
    });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!key) {
    return res
      .status(400)
      .json({ error: "missing_key", message: "key is required." });
  }
  // So as duas pontas (quem chamou ou o mototaxi que aceitou) podem
  // mudar a fase — antes, qualquer um com o id do chamado confirmava a
  // coleta, gravava "cancelada" num chamado aceito ou qualquer outra
  // fase, e cada POST renovava o TTL do chamado.
  const isDriver = callParty(c, "driver", key);
  const isCaller = callParty(c, "caller", key);
  if (!isDriver && !isCaller) {
    return res.status(403).json({
      error: "not_call_party",
      message: "only the caller or the driver who accepted can change the phase."
    });
  }
  const phase = cleanStr(body.phase, 40);
  if (!phase) {
    return res
      .status(400)
      .json({ error: "missing_phase", message: "phase is required." });
  }
  const knownPhases = ["coleta_confirmada", "a_caminho_entrega", "cancelada", "aguardando", "concluido", "cancelado", "chegou"];
  if (knownPhases.indexOf(phase) < 0) {
    return res
      .status(400)
      .json({ error: "invalid_phase", message: "unknown phase." });
  }
  c.phase = phase;
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/complete — conclui o chamado. Corpo: { key }.
// So o mototaxi que aceitou pode concluir (403 para outro).
app.post("/calls/:id/complete", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed") {
    return res.json({ ok: true, call: callPublic(c) });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!key) {
    return res
      .status(400)
      .json({ error: "missing_key", message: "key is required." });
  }
  if (c.acceptedBy && key && c.acceptedBy !== key) {
    return res.status(403).json({
      error: "not_accepted_driver",
      message: "only the driver who accepted can complete this call."
    });
  }
  c.status = "completed";
  c.phase = "concluido";
  c.completedAt = Date.now();
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/cancel — cancela o chamado. Corpo: { key } (id da
// conta). Pode cancelar: o CLIENTE que chamou (o telefone da conta
// bate com callerPhone) ou o MOTOTAXI que aceitou (key == acceptedBy).
// REGRA (v1.8.1): quem cancela muda o resultado — o CLIENTE cancela
// o chamado de vez (status "cancelled", phase "cancelado", visivel
// por 10 min); o MOTOTAXI que cancela um chamado aceito DEVOLVE o
// chamado para espera (status "pending", phase "aguardando",
// acceptedBy/acceptedName limpos, returnedToPending: true): o chamado
// volta a apitar para os outros mototaxis online aceitarem e o
// cliente continua vendo como esperando (procurando mototaxi). O
// mototaxi fica livre para aceitar outro chamado. Vale em chamado
// pendente ou aceito — o cliente cancela desde "procurando mototaxi"
// e durante toda a espera e a rota. Cancelado fica visivel por 10 min
// (como concluido) e depois some. Cancelar de novo um chamado ja
// cancelado/concluido devolve o estado atual (sem erro), para um
// toque duplo nao quebrar nada.
// REGRA (v1.8.9): excecao — o MOTOTAXI nao pode cancelar uma ENTREGA cuja
// coleta ja foi confirmada (phase "coleta_confirmada"): ele ja esta com o
// produto e tem que entregar ate o fim. Recebe 409
// delivery_already_collected e o chamado continua aceito. Corrida
// (passageiro) e cancelamento pelo CLIENTE nao mudam.
app.post("/calls/:id/cancel", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed" || c.status === "cancelled") {
    return res.json({ ok: true, already: true, call: callPublic(c) });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  const isDriver = !!c.acceptedBy && key === c.acceptedBy;
  const isCaller = callParty(c, "caller", key);
  if (!isDriver && !isCaller) {
    return res.status(403).json({
      error: "not_call_party",
      message: "only the caller or the driver who accepted can cancel this call."
    });
  }
  // REGRA (v1.8.9): o MOTOTAXI nao pode cancelar uma ENTREGA ja coletada —
  // ele ja esta com o produto e tem que entregar ate o fim. A coleta
  // confirmada e a phase "coleta_confirmada" no servidor. Vale SO para
  // entrega; corrida (passageiro) nao muda, e o CLIENTE cancelar nao
  // muda (cancela de vez, como antes). Um app antigo que tentar recebe
  // 409 e a viagem continua aceita.
  if (isDriver && c.type === "entrega" && c.phase === "coleta_confirmada") {
    return res.status(409).json({
      error: "delivery_already_collected",
      message: "delivery already collected: driver cannot cancel after pickup is confirmed."
    });
  }
  // Mototaxi cancela um chamado aceito: volta para espera (v1.8.1).
  // acceptedBy e null em chamado pendente, entao esse ramo so vale
  // para chamado aceito — pendente cancelado pelo cliente cai no
  // ramo de baixo, como antes.
  if (isDriver && c.status === "accepted") {
    c.status = "pending";
    c.phase = "aguardando";
    c.acceptedBy = null;
    c.acceptedName = null;
    c.completedAt = null;
    c.updatedAt = Date.now();
    return res.json({ ok: true, returnedToPending: true, call: callPublic(c) });
  }
  c.status = "cancelled";
  c.phase = "cancelado";
  c.completedAt = Date.now();
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// POST /calls/:id/touch — uma ponta avisa que ainda esta com o app
// aberto no chamado (o app chama a cada poll do chamado ativo, dos
// dois lados). Atualiza o updatedAt para o chamado nao expirar
// enquanto alguem esta olhando — fechar a janela e reabrir nao apaga
// o chamado. So as duas pontas do chamado podem dar touch (403 para
// outra chave).
app.post("/calls/:id/touch", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status === "completed" || c.status === "cancelled") {
    return res.json({ ok: true, call: callPublic(c) });
  }
  const body = req.body || {};
  const key = cleanStr(body.key, 128);
  if (!callParty(c, "driver", key) && !callParty(c, "caller", key)) {
    return res.status(403).json({
      error: "not_call_party",
      message: "only a party of this call can touch it."
    });
  }
  c.updatedAt = Date.now();
  return res.json({ ok: true, call: callPublic(c) });
});

// ---------------------------------------------------------------------------
// Parte do chamado — quem e cada ponta
//
// driver: a chave da conta que aceitou o chamado. caller: a conta que
// criou o chamado — callerPhone guarda o ID DA CONTA (myKey do app,
// "acc_..."), nao o telefone; chamado antigo, de antes das contas,
// guarda o telefone e cai na comparacao por telefone abaixo. Usado
// pelo cancelamento, pelo touch e pelo chat, para so as duas pontas do
// chamado agirem nele. (O VoIP ao vivo foi removido: nao funcionou.)
// ---------------------------------------------------------------------------

// Confere se a chave pertence a ponta indicada daquele chamado.
function callParty(call, side, key) {
  if (!key) return false;
  if (side === "driver") {
    return !!call.acceptedBy && key === call.acceptedBy;
  }
  if (side === "caller") {
    // BUG (08/11): callerPhone guarda o ID DA CONTA (myKey do app),
    // nao o telefone — o app cria o chamado com callerPhone=myKey().
    // O codigo antigo comparava os digitos do id com o telefone da
    // conta e NUNCA batia: quem chamou levava 403 not_call_party no
    // chat (enviar e receber audio), no cancelamento e no touch — so
    // o mototaxi funcionava. A chave que e o proprio id guardado no
    // chamado e a conta que criou o chamado. O teste direto so vale
    // para id de conta ("acc_..."): chamado antigo com telefone no
    // callerPhone continua exigindo a conta cujo telefone bate.
    if (
      typeof call.callerPhone === "string" &&
      call.callerPhone.indexOf("acc_") === 0 &&
      key === call.callerPhone
    ) {
      return true;
    }
    const acc = findAccountById(key);
    if (!acc || !acc.phone) return false;
    return normalizePhone(call.callerPhone) === acc.phone;
  }
  return false;
}

// Mesmo chamador? Usado pelo POST /calls (v1.8.7) para a regra de
// uma conta, um chamado ativo por vez. Compara a mesma chave que o
// codigo ja usa (callerPhone): id de conta ("acc_...") por igualdade
// direta, ou telefone pelos digitos (mesma comparacao do GET
// /calls?callerPhone). A comparacao por digitos so vale quando
// nenhum dos dois e id de conta — o id tem digitos ("k1") que
// casariam por engano com um telefone.
function sameCaller(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf("acc_") === 0 || b.indexOf("acc_") === 0) return false;
  const pa = normalizePhone(a);
  const pb = normalizePhone(b);
  return !!pa && pa === pb;
}

// ---------------------------------------------------------------------------
// Chat da corrida ("Converse com o mototaxi") — mensagens de texto
//
// Durante o chamado (aguardando ou em rota), cliente e mototaxi
// trocam mensagens de texto; o app de quem recebe LE em voz alta
// (speechSynthesis, volume maximo) para os dois ficarem atentos.
// O texto passa pelo servidor para chegar no outro aparelho (o app e
// estatico e cada aparelho so ve o proprio localStorage). A mensagem
// tambem serve para o cliente mandar o ponto de referencia ou o nome
// da rua quando o GPS nao marcou preciso.
//
// POST /calls/:id/messages { from, key, audio?, photo?, text? } — envia
// (audio gravado, data URL audio/* em base64 ate 200000 caracteres,
// ate 60 s; foto opcional, data URL base64 ate 200000 caracteres —
// o cliente manda foto do local, da casa ou da referencia, e o
// mototaxi ve no chat dele; texto ainda aceito pelo servidor por
// compatibilidade, mas o app nao envia mais texto). GET
// /calls/:id/messages?for=...&key=...&since=... —
// devolve TODAS as mensagens com seq > since (das duas pontas, em
// ordem), para o app remontar a conversa ao reabrir. So as duas
// pontas do chamado (mesma regra de parte do chamado). Fila em
// MEMORIA, descartada junto com o chamado.
// ---------------------------------------------------------------------------

const CHAT_MAX_PER_CALL = 100;
const CHAT_MAX_LEN = 500;

// id do chamado -> { seq, messages: [{ seq, from, text, photo, audio, durationSec, at }] }
const chatMessages = new Map();

function chatPublic(m) {
  return {
    seq: m.seq,
    from: m.from,
    text: m.text,
    photo: m.photo || "",
    audio: m.audio || "",
    durationSec: m.durationSec || 0,
    at: m.at
  };
}

app.post("/calls/:id/messages", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  if (c.status !== "pending" && c.status !== "accepted") {
    return res.status(409).json({
      error: "call_not_active",
      message: "messages are only available while the call is pending or accepted."
    });
  }
  const body = req.body || {};
  const from = cleanStr(body.from, 10);
  if (from !== "driver" && from !== "caller") {
    return res.status(400).json({
      error: "invalid_from",
      message: 'from must be "driver" or "caller".'
    });
  }
  const key = cleanStr(body.key, 128);
  if (!callParty(c, from, key)) {
    return res.status(403).json({
      error: "not_call_party",
      message: "this key does not belong to a party of this call."
    });
  }
  const text = cleanStr(body.text, CHAT_MAX_LEN);
  // Foto do local (opcional): o cliente manda foto da casa, do ponto
  // onde esta ou da referencia, tirada na hora pela camera ou da
  // galeria; o mototaxi ve no chat dele. Data URL JPEG/PNG/WebP em
  // base64, reduzida no aparelho; max 200000 caracteres (~150 KB)
  // para caber no limite de 256 KB do corpo JSON.
  let photo = "";
  if (typeof body.photo === "string" && body.photo.trim() !== "") {
    photo = body.photo.trim();
    if (photo.length > 200000 || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photo)) {
      return res.status(400).json({
        error: "invalid_photo",
        message: "photo must be a data:image/jpeg|png|webp base64 URL up to 200000 characters."
      });
    }
  }
  // Audio gravado (v1.8.0, chat so audio; v1.8.2 aceita parametros
  // MIME como ;codecs=opus): o app grava com o microfone
  // (MediaRecorder, ate 60 s) e manda como data URL audio/* em
  // base64; max 200000 caracteres (~150 KB) para caber no limite de
  // 256 KB do corpo JSON. Quem recebe aperta para ouvir. O regex
  // aceita parametros do tipo (;codecs=opus) porque o MediaRecorder
  // do Chrome/Android produz data:audio/webm;codecs=opus;base64,...
  // e a versao anterior rejeitava esse formato com 400 invalid_audio
  // (o audio "enviado" nunca chegava a ser salvo).
  let audio = "";
  let durationSec = 0;
  if (typeof body.audio === "string" && body.audio.trim() !== "") {
    audio = body.audio.trim();
    if (
      audio.length > 200000 ||
      !/^data:audio\/[a-z0-9.+-]+(?:;[^;,=]+=[^;,]+)*;base64,/.test(audio)
    ) {
      return res.status(400).json({
        error: "invalid_audio",
        message: "audio must be a data:audio/* base64 URL up to 200000 characters."
      });
    }
    if (typeof body.durationSec === "number" && Number.isFinite(body.durationSec)) {
      durationSec = Math.max(1, Math.min(60, Math.round(body.durationSec)));
    }
  }
  if (!text && !photo && !audio) {
    return res.status(400).json({
      error: "missing_content",
      message: "audio, photo or text is required."
    });
  }
  let queue = chatMessages.get(c.id);
  if (!queue) {
    queue = { seq: 0, messages: [] };
    chatMessages.set(c.id, queue);
  }
  queue.seq += 1;
  queue.messages.push({
    seq: queue.seq,
    from,
    text,
    photo,
    audio,
    durationSec,
    at: Date.now()
  });
  // Fila limitada: descarta as mais antigas para nao crescer sem fim.
  while (queue.messages.length > CHAT_MAX_PER_CALL) queue.messages.shift();
  // Mandar mensagem mantem o chamado vivo (como o touch).
  c.updatedAt = Date.now();
  return res.status(201).json({ ok: true, seq: queue.seq });
});

app.get("/calls/:id/messages", (req, res) => {
  const c = calls.get(String(req.params.id || ""));
  if (!c) {
    return res
      .status(404)
      .json({ error: "call_not_found", message: "call not found." });
  }
  const side = cleanStr(req.query.for, 10);
  if (side !== "driver" && side !== "caller") {
    return res.status(400).json({
      error: "invalid_for",
      message: 'for must be "driver" or "caller".'
    });
  }
  const key = cleanStr(req.query.key, 128);
  if (!callParty(c, side, key)) {
    return res.status(403).json({
      error: "not_call_party",
      message: "this key does not belong to a party of this call."
    });
  }
  const since = Number(req.query.since) || 0;
  const queue = chatMessages.get(c.id);
  const lastSeq = queue ? queue.seq : 0;
  const messages = [];
  if (queue) {
    for (const m of queue.messages) {
      if (m.seq > since) messages.push(chatPublic(m));
    }
  }
  return res.json({ ok: true, messages, lastSeq });
});

// ---------------------------------------------------------------------------
// Contas (/auth) — registro e login no SERVIDOR
//
// Por que no servidor: a conta antes so existia no localStorage de cada
// aparelho (mtt_contas_v1). A conta criada no celular nao existia no PC
// e o login no PC dizia "incorreto" mesmo com a senha certa. Agora a
// conta vive no servidor e o mesmo telefone + senha entra em qualquer
// aparelho; o aparelho guarda so o token da sessao (nunca a senha).
//
// Senhas: scrypt (crypto nativo) com salt aleatorio de 16 bytes;
// guardamos "salt:hash" em hexadecimal. Nada de texto claro em arquivo,
// em log ou em resposta. Comparacao com timingSafeEqual.
//
// Persistencia: accounts.json ao lado do server.js, escrita atomica
// (grava accounts.json.tmp e renomeia por cima — um corte no meio nao
// corrompe o arquivo). Lido na inicializacao; se nao existir ou estiver
// corrompido, comeca vazio e registra o aviso no log. No Render Free o
// disco e efemero (reinicio apaga o arquivo): as contas voltam pela
// migracao automatica do app, que reenvia a conta local quando o
// servidor nao a conhece. No VPS (disco persistente) nada se perde.
// O Postgres gratuito do Render NAO serve aqui: ele expira e e apagado
// depois de ~30 dias (foi o que aconteceu com o banco do Gestor), entao
// as contas sumiriam sozinhas. Quando o app for para o VPS, este mesmo
// arquivo ja e a persistencia definitiva, sem mudar nada no codigo.
//
// Admin: a primeira conta registrada no servidor vira admin
// (isAdmin=true), como antes era a primeira conta criada no aparelho.
// So o admin lista usuarios, redefine senha e apaga conta. Apagar nao
// permite apagar a propria conta nem outra conta admin.
//
// Diaria: paidUntil (fim da diaria paga, em ms) fica na conta, para a
// diaria paga valer na conta em qualquer aparelho — antes ela so valia
// no aparelho onde foi paga. O app grava via POST /auth/fee depois de
// confirmar o Pix pago (mesma validacao de antes, no aparelho).
// Isencao (v1.6.0): a conta da DONA (primeira registrada,
// administradora) NAO paga diaria — feeExempt: true na conta,
// persistido em accounts.json, devolvido em GET /auth/me (e em
// toda resposta com a conta). O app trata feeExempt como liberado.
// O servidor confere a diaria em POST /presence e em
// POST /calls/:id/accept (402 fee_required sem diaria valida).
// ---------------------------------------------------------------------------

const ACCOUNTS_FILE =
  process.env.ACCOUNTS_FILE || path.join(__dirname, "accounts.json");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sessao vale 30 dias

let authStore = { version: 1, accounts: [], tokens: [], usedFeePayments: {} };

function loadAuthStore() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.accounts) && Array.isArray(data.tokens)) {
      authStore = data;
      if (!authStore.usedFeePayments || typeof authStore.usedFeePayments !== "object") authStore.usedFeePayments = {};
      pruneTokens();
      normalizeFeeExempt();
    } else {
      console.log("accounts.json invalido (formato inesperado); comecando vazio.");
    }
  } catch (err) {
    console.log("nao foi possivel ler accounts.json (" + err.message + "); comecando vazio.");
  }
}

function saveAuthStore() {
  try {
    const tmp = ACCOUNTS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(authStore), "utf8");
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (err) {
    console.log("nao foi possivel gravar accounts.json: " + err.message);
  }
}

// Isencao da diaria: SO a conta administradora (a primeira
// registrada, a dona) e isenta — nenhuma outra. Ao carregar o
// arquivo, normaliza: admin sem feeExempt ganha a isencao (cobre
// contas criadas antes da v1.6.0, que nao tinham o campo) e
// nao-admin com feeExempt perde (a isencao so nasce no registro da
// primeira conta). Grava de volta se algo mudou.
// Liberacao para trabalhar de graca (v1.8.11): conta sem o campo
// freeAuthorized (criada antes da v1.8.11) nasce nao-liberada.
function normalizeFeeExempt() {
  let changed = false;
  for (const a of authStore.accounts) {
    const exempt = !!a.isAdmin;
    if (!!a.feeExempt !== exempt) {
      a.feeExempt = exempt;
      changed = true;
    }
    if (typeof a.freeAuthorized !== "boolean") {
      a.freeAuthorized = false;
      changed = true;
    }
  }
  if (changed) saveAuthStore();
}

function normalizePhone(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\D/g, "");
}

function hashPassword(password, salt) {
  const hash = crypto.scryptSync(password, salt, 64);
  return salt + ":" + hash.toString("hex");
}

function newPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return hashPassword(password, salt);
}

function checkPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const expected = Buffer.from(parts[1], "hex");
  const actual = crypto.scryptSync(password, parts[0], 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Diaria valida? A conta esta liberada quando: e ISENTA (a dona,
// administradora — feeExempt: true), OU a diaria paga ainda nao
// venceu (paidUntil no futuro — vale sempre, com ou sem modo
// gratuito), OU o modo gratuito esta ligado (freeFee em /settings)
// E a conta foi LIBERADA pela dona (freeAuthorized: true, v1.8.11 —
// o codigo de liberacao). Sem liberacao, o gratuito nao libera
// ninguem. E o que o app usa (via GET /auth/me) e o que o servidor
// confere em /presence e em /calls/:id/accept.
function isFeeValid(account) {
  if (!account) return false;
  if (account.feeExempt) return true;
  if ((account.paidUntil || 0) > Date.now()) return true;
  if (appSettings.freeFee) return !!account.freeAuthorized;
  return false;
}

// Por que a conta NAO pode trabalhar (null = pode): distingue o
// bloqueio do modo gratuito sem liberacao (o app mostra o pedido do
// codigo) do bloqueio da diaria vencida (o app mostra o Pix).
// So e chamado quando isFeeValid ja deu false.
function feeBlockReason(account) {
  if (!account) return null;
  if (isFeeValid(account)) return null;
  if (appSettings.freeFee && !account.feeExempt && (account.paidUntil || 0) <= Date.now()) {
    return "free_authorization_required";
  }
  return "fee_required";
}

// Dias de validade da diaria DESTA conta (v1.8.8): a conta pode ter
// o proprio feeDays (definido pela dona na Administracao, via
// PATCH /auth/users/:id); sem ele (null/ausente/invalido), vale a
// configuracao geral (feeDays em /settings). Mudar o feeDays de
// uma conta NAO altera um paidUntil ja pago — vale para o PROXIMO
// pagamento, que o POST /auth/fee calcula com este valor.
function feeDaysForAccount(account) {
  if (
    account &&
    typeof account.feeDays === "number" &&
    Number.isInteger(account.feeDays) &&
    account.feeDays >= 1
  ) {
    return account.feeDays;
  }
  return appSettings.feeDays;
}

function accountPublic(a) {
  return {
    id: a.id,
    name: a.name,
    phone: a.phone,
    role: a.role,
    photo: a.photo || "",
    plate: a.plate || "",
    bike: a.bike || "",
    shopAddr: a.shopAddr || "",
    paidUntil: a.paidUntil || 0,
    isAdmin: !!a.isAdmin,
    feeExempt: !!a.feeExempt,
    // Liberada para trabalhar de graca (v1.8.11): a dona gerou o codigo
    // e a conta digitou — so vale enquanto o modo gratuito estiver
    // ligado. Incluido em toda resposta com a conta (GET /auth/users,
    // /auth/me, register, login...), para o app e a Administracao
    // mostrarem o status e a dona revogar quando quiser.
    freeAuthorized: !!a.freeAuthorized,
    // Dias da diaria desta conta (v1.8.8): null = usar a configuracao
    // geral (feeDays em /settings). Incluido em toda resposta com a
    // conta (GET /auth/users, /auth/me, register, login...), para a
    // Administracao mostrar e editar o valor por conta.
    feeDays:
      typeof a.feeDays === "number" &&
      Number.isInteger(a.feeDays) &&
      a.feeDays >= 1
        ? a.feeDays
        : null,
    feeValid: isFeeValid(a),
    createdAt: a.createdAt
  };
}

function newAccountId() {
  return "acc_" + Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
}

function findAccountByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return authStore.accounts.find((a) => a.phone === p) || null;
}

function findAccountById(id) {
  return authStore.accounts.find((a) => a.id === id) || null;
}

function pruneTokens() {
  const now = Date.now();
  authStore.tokens = authStore.tokens.filter((t) => t.expiresAt > now);
}

function issueToken(accountId) {
  pruneTokens();
  const token = crypto.randomBytes(32).toString("hex");
  authStore.tokens.push({
    token,
    accountId,
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  saveAuthStore();
  return token;
}

function accountFromToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const token = m[1].trim();
  pruneTokens();
  const rec = authStore.tokens.find((t) => t.token === token);
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return findAccountById(rec.accountId);
}

function requireAuth(req, res, next) {
  const account = accountFromToken(req);
  if (!account) {
    return res.status(401).json({ error: "unauthorized", message: "valid session token is required." });
  }
  req.account = account;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.account || !req.account.isAdmin) {
    return res.status(403).json({ error: "admin_only", message: "only the admin can do this." });
  }
  return next();
}

function revokeTokens(accountId) {
  authStore.tokens = authStore.tokens.filter((t) => t.accountId !== accountId);
}

// Limite simples contra tentativa de senha em sequencia: 10 falhas por
// telefone em 10 minutos -> 429. Em memoria; reinicio zera o contador.
const loginFailures = new Map();
function loginBlocked(phone) {
  const rec = loginFailures.get(phone);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > 10 * 60 * 1000) {
    loginFailures.delete(phone);
    return false;
  }
  return rec.count >= 10;
}
function loginFailed(phone) {
  const rec = loginFailures.get(phone) || { count: 0, firstAt: Date.now() };
  rec.count += 1;
  loginFailures.set(phone, rec);
}
function loginSucceeded(phone) {
  loginFailures.delete(phone);
}

// POST /auth/register — cria a conta no servidor. Corpo: { name, phone,
// password, role ("passageiro"|"mototaxi"|"comercio"), photo?, plate?,
// bike?, shopAddr? }. A primeira conta registrada vira admin. Se o
// telefone ja existir E a senha conferir, devolve a conta existente
// (migracao idempotente: o app reenvia a conta local sem duplicar).
app.post("/auth/register", (req, res) => {
  const body = req.body || {};
  const name = cleanStr(body.name, 80);
  const phone = normalizePhone(body.phone);
  const password = typeof body.password === "string" ? body.password : "";
  const role = cleanStr(body.role, 20);

  if (!name) {
    return res.status(400).json({ error: "missing_name", message: "name is required." });
  }
  if (!phone || phone.length < 8 || phone.length > 13) {
    return res.status(400).json({ error: "invalid_phone", message: "phone must have 8 to 13 digits." });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "invalid_password", message: "password must have at least 4 characters." });
  }
  if (role !== "passageiro" && role !== "mototaxi" && role !== "comercio") {
    return res.status(400).json({ error: "invalid_role", message: 'role must be "passageiro", "mototaxi" or "comercio".' });
  }

  const existing = findAccountByPhone(phone);
  if (existing) {
    if (checkPassword(password, existing.passHash)) {
      // Migracao repetida: a conta ja esta no servidor, so entra.
      const token = issueToken(existing.id);
      return res.json({ ok: true, migrated: true, token, account: accountPublic(existing) });
    }
    return res.status(409).json({ error: "phone_exists", message: "this phone is already registered." });
  }

  const isAdmin = authStore.accounts.length === 0;
  const account = {
    id: newAccountId(),
    name,
    phone,
    passHash: newPasswordHash(password),
    role,
    photo: cleanStr(body.photo, 200000),
    plate: cleanStr(body.plate, 16),
    bike: cleanStr(body.bike, 80),
    shopAddr: cleanStr(body.shopAddr, 300),
    paidUntil: 0,
    isAdmin,
    // A primeira conta (a dona, administradora) e ISENTA da diaria:
    // trabalha sem pagar nada. Nenhuma outra conta nasce isenta.
    feeExempt: isAdmin,
    // Nenhuma conta nasce liberada para trabalhar de graca (v1.8.11):
    // a liberacao so vem quando a dona gera o codigo e a conta digita.
    freeAuthorized: false,
    createdAt: Date.now()
  };
  authStore.accounts.push(account);
  saveAuthStore();
  const token = issueToken(account.id);
  return res.status(201).json({ ok: true, token, account: accountPublic(account) });
});

// POST /auth/login — entra com telefone + senha. Erros distintos para o
// app saber o que fazer: account_not_found (conta nao existe no
// servidor — o app tenta a migracao automatica) e invalid_password.
app.post("/auth/login", (req, res) => {
  const body = req.body || {};
  const phone = normalizePhone(body.phone);
  const password = typeof body.password === "string" ? body.password : "";
  if (!phone) {
    return res.status(400).json({ error: "invalid_phone", message: "phone is required." });
  }
  if (loginBlocked(phone)) {
    return res.status(429).json({ error: "too_many_attempts", message: "too many failed attempts; try again in a few minutes." });
  }
  const account = findAccountByPhone(phone);
  if (!account) {
    return res.status(404).json({ error: "account_not_found", message: "no account for this phone." });
  }
  if (!checkPassword(password, account.passHash)) {
    loginFailed(phone);
    return res.status(401).json({ error: "invalid_password", message: "wrong password." });
  }
  loginSucceeded(phone);
  const token = issueToken(account.id);
  return res.json({ ok: true, token, account: accountPublic(account) });
});

// GET /auth/me — quem esta logado com este token.
app.get("/auth/me", requireAuth, (req, res) => {
  return res.json({ ok: true, account: accountPublic(req.account) });
});

// POST /auth/logout — encerra a sessao (apaga o token).
app.post("/auth/logout", requireAuth, (req, res) => {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (m) {
    authStore.tokens = authStore.tokens.filter((t) => t.token !== m[1].trim());
    saveAuthStore();
  }
  // Sair cancela os chamados PENDENTES desta conta (08/11): pedido
  // abandonado nao fica apitando "Chamado solicitado" na proxima conta
  // nem nos outros mototaxis como chamado antigo da versao anterior.
  // Chamado ja aceito/em rota nao e tocado — ele continua e volta ao
  // reentrar. O app tambem cancela os pendentes antes de sair; isto
  // aqui e a rede de seguranca para quando o pedido do app nao chega.
  if (req.account) {
    const now = Date.now();
    for (const c of calls.values()) {
      if (c.status !== "pending") continue;
      const mine =
        c.callerPhone === req.account.id ||
        (req.account.phone &&
          normalizePhone(c.callerPhone) === req.account.phone);
      if (!mine) continue;
      c.status = "cancelled";
      c.phase = "cancelado";
      c.completedAt = now;
      c.updatedAt = now;
    }
  }
  return res.json({ ok: true });
});

// POST /auth/change-password — o proprio usuario troca a senha.
app.post("/auth/change-password", requireAuth, (req, res) => {
  const body = req.body || {};
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!checkPassword(current, req.account.passHash)) {
    return res.status(401).json({ error: "invalid_password", message: "current password is wrong." });
  }
  if (next.length < 4) {
    return res.status(400).json({ error: "invalid_password", message: "new password must have at least 4 characters." });
  }
  req.account.passHash = newPasswordHash(next);
  revokeTokens(req.account.id);
  saveAuthStore();
  const token = issueToken(req.account.id);
  return res.json({ ok: true, token, account: accountPublic(req.account) });
});

// POST /auth/fee — registra a diaria paga na conta (para valer em
// qualquer aparelho). O paidUntil e calculado NO SERVIDOR: agora +
// feeDays * 24h (v1.7.0 — antes o app mandava paidUntil de 24h fixo;
// v1.8.8 — feeDays e o DA CONTA quando definido, senao o geral).
// POST /auth/fee — libera a diaria DEPOIS de um Pix aprovado (v1.8.5).
// O corpo precisa de {payment_id} (o id do pagamento no Mercado Pago).
// O servidor confere no Mercado Pago: status "approved", referencia de
// cobranca de diaria ("diaria-..."), valor igual ao cobrado (ou ao valor
// atual da diaria, se a cobranca se perdeu no reinicio) — e recusa
// pagamento ja usado. Sem isto, qualquer conta logada liberava a diaria
// de graca chamando a rota sem pagar nada (o servidor confiava no app).
// RENOVACAO ACUMULA (v1.8.5): pagar antes de vencer estende a partir do
// fim da vigencia atual (max(paidUntil, agora) + feeDays*24h) — antes,
// pagar com dias restantes nao comprava nenhum dia extra. Reenvio do
// mesmo pagamento e idempotente: devolve o prazo atual sem estender de
// novo (o app reenvia quando a primeira tentativa se perdeu).
app.post("/auth/fee", requireAuth, async (req, res) => {
  const body = req.body || {};
  const paymentId =
    typeof body.payment_id === "string" && body.payment_id.trim()
      ? body.payment_id.trim()
      : typeof body.paymentId === "string" && body.paymentId.trim()
        ? body.paymentId.trim()
        : "";
  if (!paymentId) {
    return res.status(400).json({
      error: "missing_payment_id",
      message: "payment_id is required to grant the daily fee."
    });
  }
  if (!authStore.usedFeePayments) authStore.usedFeePayments = {};
  if (authStore.usedFeePayments[paymentId]) {
    // Pagamento ja usado (reenvio do app): nao estende de novo.
    return res.json({ ok: true, alreadyUsed: true, account: accountPublic(req.account) });
  }
  if (!mpToken()) return tokenNotConfigured(res);
  let pay;
  try {
    const result = await mpRequest("/" + encodeURIComponent(paymentId), { method: "GET" });
    if (!result.ok) {
      return res.status(502).json({
        error: "mercadopago_error",
        status: result.status,
        detail: mpErrorDetail(result).slice(0, 500)
      });
    }
    pay = result.data || {};
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Mercado Pago request timed out."
        : "Could not reach Mercado Pago.";
    return res.status(502).json({ error: "mercadopago_unreachable", message: msg });
  }
  if (pay.status !== "approved") {
    return res.status(402).json({
      error: "payment_not_approved",
      message: "the payment is not approved.",
      status: pay.status || null
    });
  }
  const ref = String(pay.external_reference || "");
  if (ref.indexOf("diaria-") !== 0) {
    return res.status(402).json({
      error: "payment_reference_mismatch",
      message: "the payment is not a daily fee charge."
    });
  }
  const amount = Number(pay.transaction_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(402).json({
      error: "payment_amount_mismatch",
      message: "the payment amount is invalid."
    });
  }
  // Valor esperado: o da cobranca registrada (e a cobranca tinha que ser
  // do valor da diaria na hora); sem registro (reinicio), o valor atual.
  const charge = pixCharges.get(ref);
  let expected = appSettings.fee;
  if (charge && typeof charge.amount === "number") {
    if (typeof charge.fee === "number" && Math.abs(charge.amount - charge.fee) > 0.01) {
      return res.status(402).json({
        error: "payment_amount_mismatch",
        message: "the charge was not created for the daily fee amount."
      });
    }
    expected = charge.amount;
  }
  if (Math.abs(amount - expected) > 0.01) {
    return res.status(402).json({
      error: "payment_amount_mismatch",
      message: "the payment amount does not match the daily fee charge."
    });
  }
  authStore.usedFeePayments[paymentId] = { accountId: req.account.id, usedAt: Date.now() };
  const base = Math.max(req.account.paidUntil || 0, Date.now());
  // Dias da diaria DESTA conta (v1.8.8): feeDays da conta quando
  // definido, senao a configuracao geral. Conta com feeDays=30 paga
  // 30 dias (720h); conta sem feeDays usa o geral. Mudar o feeDays
  // nao altera um paidUntil ja pago — so o proximo pagamento usa o
  // valor novo (a renovacao acumula a partir do fim da vigencia).
  req.account.paidUntil = base + feeDaysForAccount(req.account) * 24 * 3600 * 1000;
  saveAuthStore();
  return res.json({ ok: true, account: accountPublic(req.account) });
});

// POST /auth/free-code/generate — a DONA gera o codigo de liberacao
// para UMA conta (v1.8.11, so admin). Corpo: { accountId }. O codigo
// tem 6 digitos, vale 30 min e e de uso unico; gerar outro para a
// mesma conta invalida o anterior (os antigos sao apagados). O codigo
// e devolvido na resposta para a dona copiar e mandar no WhatsApp
// dela mesma — o servidor NAO manda WhatsApp nenhum. So existe no
// modo gratuito: com freeFee desligado, recusa 409 free_mode_off.
// Conta inexistente: 404.
app.post("/auth/free-code/generate", requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const target = findAccountById(accountId);
  if (!target) {
    return res.status(404).json({ error: "account_not_found", message: "account not found." });
  }
  if (!appSettings.freeFee) {
    return res.status(409).json({
      error: "free_mode_off",
      message: "free mode is off; the code only exists in free mode."
    });
  }
  pruneFreeCodes();
  freeCodes = freeCodes.filter((c) => c.accountId !== accountId);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Date.now();
  freeCodes.push({
    code,
    accountId,
    createdAt: now,
    expiresAt: now + FREE_CODE_TTL_MS,
    used: false
  });
  saveFreeCodes();
  return res.json({ ok: true, code, accountId, expiresAt: now + FREE_CODE_TTL_MS });
});

// POST /auth/free-code/verify — o MOTOTAXI digita o codigo que a dona
// mandou no WhatsApp (v1.8.11). Corpo: { code }. O codigo so vale
// para a conta de QUEM ESTA LOGADO (codigo de outra conta nao serve),
// se nao foi usado e se nao expirou (30 min). Certo: marca o codigo
// como usado e poe freeAuthorized=true na conta — ela trabalha de
// graca enquanto o gratuito estiver ligado. Errado/expirado/usado:
// 400 invalid_code (a mesma resposta para nao revelar qual e o
// motivo). Com freeFee desligado, recusa 409 free_mode_off — o
// codigo nao vale e a conta tem que pagar a diaria.
app.post("/auth/free-code/verify", requireAuth, (req, res) => {
  const body = req.body || {};
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!appSettings.freeFee) {
    return res.status(409).json({
      error: "free_mode_off",
      message: "free mode is off; pay the daily fee to work."
    });
  }
  if (!code) {
    return res.status(400).json({ error: "invalid_code", message: "invalid or expired code." });
  }
  pruneFreeCodes();
  const now = Date.now();
  const rec = freeCodes.find(
    (c) => c.code === code && c.accountId === req.account.id
  );
  if (!rec || rec.used || rec.expiresAt <= now) {
    return res.status(400).json({ error: "invalid_code", message: "invalid or expired code." });
  }
  rec.used = true;
  saveFreeCodes();
  req.account.freeAuthorized = true;
  saveAuthStore();
  return res.json({ ok: true, account: accountPublic(req.account) });
});

// GET /auth/users — admin lista as contas (para buscar pelo nome,
// redefinir senha e apagar conta). Nunca devolve o hash. Cada conta
// traz feeDays (v1.8.8): null quando a conta usa a configuracao
// geral, ou o numero de dias proprio dela.
app.get("/auth/users", requireAuth, requireAdmin, (req, res) => {
  const users = authStore.accounts.map(accountPublic);
  users.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return res.json({ ok: true, users, count: users.length });
});

// PATCH /auth/users/:id — o admin EDITA uma conta (v1.8.8, pedidos
// dela 09/11 10:42 e 10:43). Corpo: { name?, phone?, feeDays?,
// freeAuthorized? } — todos opcionais; feeDays pode ser inteiro >= 1
// (dias da diaria SO desta conta) ou null (volta a usar a
// configuracao geral); freeAuthorized (v1.8.11) e booleano: false
// REVOGA a liberacao para trabalhar de graca (a conta volta a
// precisar do codigo) e true libera direto, sem codigo. Valida TUDO
// antes de alterar qualquer coisa: valor invalido responde 400 e nao
// altera nada. So mexe nestes quatro campos — nunca em isAdmin,
// feeExempt, senha ou paidUntil: nem a propria conta do admin pode
// perder o admin ou a isencao por aqui.
// Mudar o feeDays nao altera um paidUntil ja pago (vale para o
// proximo pagamento). Conta inexistente: 404.
app.patch("/auth/users/:id", requireAuth, requireAdmin, (req, res) => {
  const target = findAccountById(String(req.params.id || ""));
  if (!target) {
    return res.status(404).json({ error: "account_not_found", message: "account not found." });
  }
  const body = req.body || {};
  let newName;
  let newPhone;
  let newFeeDays;
  let newFreeAuthorized;
  if (body.name !== undefined) {
    newName = cleanStr(body.name, 80);
    if (!newName) {
      return res.status(400).json({ error: "invalid_name", message: "name must not be empty." });
    }
  }
  if (body.phone !== undefined) {
    newPhone = normalizePhone(body.phone);
    if (!newPhone) {
      return res.status(400).json({ error: "invalid_phone", message: "phone must not be empty." });
    }
  }
  if (body.feeDays !== undefined) {
    if (body.feeDays === null) {
      newFeeDays = null;
    } else if (
      typeof body.feeDays === "number" &&
      Number.isInteger(body.feeDays) &&
      body.feeDays >= 1
    ) {
      newFeeDays = body.feeDays;
    } else {
      return res.status(400).json({
        error: "invalid_feeDays",
        message: "feeDays must be a positive integer or null."
      });
    }
  }
  if (body.freeAuthorized !== undefined) {
    if (typeof body.freeAuthorized !== "boolean") {
      return res.status(400).json({
        error: "invalid_freeAuthorized",
        message: "freeAuthorized must be a boolean."
      });
    }
    newFreeAuthorized = body.freeAuthorized;
  }
  if (newName !== undefined) target.name = newName;
  if (newPhone !== undefined) target.phone = newPhone;
  if (newFeeDays !== undefined) {
    if (newFeeDays === null) delete target.feeDays;
    else target.feeDays = newFeeDays;
  }
  if (newFreeAuthorized !== undefined) target.freeAuthorized = newFreeAuthorized;
  saveAuthStore();
  return res.json({ ok: true, account: accountPublic(target) });
});

// POST /auth/reset-password — o admin redefine a senha de um usuario.
// Corpo: { accountId } ou { phone }, e { newPassword }. Apaga as
// sessoes do usuario (ele entra de novo com a senha nova).
app.post("/auth/reset-password", requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 4) {
    return res.status(400).json({ error: "invalid_password", message: "new password must have at least 4 characters." });
  }
  let target = null;
  if (typeof body.accountId === "string" && body.accountId) {
    target = findAccountById(body.accountId);
  }
  if (!target && body.phone) target = findAccountByPhone(body.phone);
  if (!target) {
    return res.status(404).json({ error: "account_not_found", message: "account not found." });
  }
  target.passHash = newPasswordHash(newPassword);
  revokeTokens(target.id);
  saveAuthStore();
  let newToken = null;
  if (target.id === req.account.id) {
    // A dona redefiniu a PROPRIA senha: emite um token novo para ela nao
    // cair em ate 3 min (o validateSessionTick daria 401 com o token
    // revogado). O app guarda o token novo quando a resposta o traz.
    newToken = issueToken(target.id);
  }
  return res.json({ ok: true, account: accountPublic(target), token: newToken });
});

// DELETE /auth/users/:id — o admin apaga uma conta. Nao apaga a
// propria conta nem outra conta admin (mesma regra de antes). Apagar
// revoga os tokens: a conta apagada perde o acesso em TODOS os
// aparelhos (o token dela deixa de valer no servidor).
app.delete("/auth/users/:id", requireAuth, requireAdmin, (req, res) => {
  const target = findAccountById(String(req.params.id || ""));
  if (!target) {
    return res.status(404).json({ error: "account_not_found", message: "account not found." });
  }
  if (target.id === req.account.id) {
    return res.status(403).json({ error: "cannot_delete_self", message: "the admin cannot delete her own account." });
  }
  if (target.isAdmin) {
    return res.status(403).json({ error: "cannot_delete_admin", message: "an admin account cannot be deleted." });
  }
  // Apagar a conta cancela os chamados dela (como quem chamou e como
  // mototaxi que aceitou): sem isto, os chamados seguiam apitando para
  // os mototaxis ate o TTL (60 min pendente).
  calls.forEach((c) => {
    if (c.callerPhone === target.id || c.acceptedBy === target.id) {
      if (c.status === "pending" || c.status === "accepted") {
        c.status = "cancelled";
        c.updatedAt = Date.now();
      }
    }
  });
  authStore.accounts = authStore.accounts.filter((a) => a.id !== target.id);
  revokeTokens(target.id);
  saveAuthStore();
  return res.json({ ok: true, deleted: target.id });
});

loadAuthStore();
loadAppSettings();
loadPixCharges();
loadFreeCodes();

app.listen(PORT, () => {
  console.log("moto-taxi-backend listening on port " + PORT);
});
