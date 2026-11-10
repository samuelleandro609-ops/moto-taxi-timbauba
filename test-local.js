"use strict";

/**
 * test-local.js — testes locais do moto-taxi-backend (v1.8.11).
 *
 * Sobe o server.js numa porta de teste (PORT=3101) e testa por HTTP.
 * NAO chama nenhum endpoint /auth/* — os testes nunca tocam no
 * accounts.json real. O aceite usa chaves desconhecidas ("test-key-1",
 * "test-key-2"): conta desconhecida passa na checagem de diaria como
 * antes (so conta CONHECIDA sem diaria valida recebe 402).
 *
 * Uso: node test-local.js        (sai 0 se tudo passar, 1 se falhar)
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const PORT = 3101;
const BASE = "http://127.0.0.1:" + PORT;
// Arquivo de ajustes do servidor de teste (SETTINGS_FILE): fica no /tmp,
// nunca no diretorio do repo — o teste apaga no fim.
const SETTINGS_TEST_FILE = path.join(os.tmpdir(), "mtt-test-settings-1.8.9.json");
// Arquivo de contas do servidor de teste (ACCOUNTS_FILE): idem — o
// teste cria uma conta admin temporaria e apaga no fim.
const ACCOUNTS_TEST_FILE = path.join(os.tmpdir(), "mtt-test-accounts-1.8.9.json");
const PORT2 = 3102;
const BASE2 = "http://127.0.0.1:" + PORT2;
// (s) diaria por conta: arquivos proprios do servidor de teste do
// /auth/fee (terceira instancia) e porta do mock do Mercado Pago.
const SETTINGS_FEE_TEST_FILE = path.join(os.tmpdir(), "mtt-test-settings-fee-1.8.9.json");
const ACCOUNTS_FEE_TEST_FILE = path.join(os.tmpdir(), "mtt-test-accounts-fee-1.8.9.json");
const PORT3 = 3104;
const BASE3 = "http://127.0.0.1:" + PORT3;
const MOCK_MP_PORT = 3103;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log("  PASS " + name);
  } else {
    failed += 1;
    failures.push(name + (extra ? " — " + extra : ""));
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

async function reqBase(base, method, p, body) {
  const resp = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = null;
  }
  return { status: resp.status, data };
}

async function req(method, p, body) {
  return reqBase(BASE, method, p, body);
}

async function reqAuth(token, method, p, body) {
  return reqAuthBase(BASE, token, method, p, body);
}

async function reqAuthBase(base, token, method, p, body) {
  const resp = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = null;
  }
  return { status: resp.status, data };
}

function baseCall(overrides) {
  return Object.assign(
    {
      callerName: "Teste",
      callerPhone: "81999990000",
      targetKey: null,
      targetName: null,
      type: "corrida",
      pickup: "Rua A, 100",
      destination: "Rua B, 50",
      amount: 8
    },
    overrides || {}
  );
}

async function waitReadyBase(base) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await reqBase(base, "GET", "/");
      if (r.status === 200 && r.data && r.data.ok) return true;
    } catch (e) {
      // servidor ainda subindo
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitReady(child) {
  return waitReadyBase(BASE);
}

async function run() {
  try {
    fs.unlinkSync(SETTINGS_TEST_FILE);
  } catch (e) {
    // nao existia: nada a limpar
  }
  try {
    fs.unlinkSync(ACCOUNTS_TEST_FILE);
  } catch (e) {
    // nao existia: nada a limpar
  }
  // Modo Postgres (DATABASE_URL): o banco persiste entre execucoes, ao
  // contrario do arquivo que e apagado acima. Limpa a tabela auth_store
  // para o teste comecar do zero (1a conta vira admin). Sem isto, a 2a
  // execucao encontra as contas da 1a e a "1a conta" ja nao e admin.
  // Banco separado para o teste de diaria (secao s): a 3a instancia usa
  // seu proprio arquivo de contas no modo arquivo; no modo Postgres ela
  // precisa do proprio banco, senao a "Admin Fee" nao e a 1a conta.
  let feeDbUrl = null;
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require("pg");
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        await c.query("DROP TABLE IF EXISTS auth_store");
      } finally {
        await c.end();
      }
      const baseUrl = new URL(process.env.DATABASE_URL);
      const dbName = (baseUrl.pathname.replace(/\/$/, "").split("/").pop() || "mototaxi_test") + "_fee";
      const adminUrl = new URL(process.env.DATABASE_URL);
      adminUrl.pathname = "/postgres";
      const admin = new Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      try {
        await admin.query("CREATE DATABASE \"" + dbName.replace(/"/g, '""') + "\"");
      } catch (e) {
        if (!/already exists/.test(e.message)) throw e;
      } finally {
        await admin.end();
      }
      const feeUrl = new URL(process.env.DATABASE_URL);
      feeUrl.pathname = "/" + dbName;
      feeDbUrl = feeUrl.toString();
      // Limpa tambem o banco de diaria (persiste entre execucoes).
      const feeClient = new Client({ connectionString: feeDbUrl });
      await feeClient.connect();
      try {
        await feeClient.query("DROP TABLE IF EXISTS auth_store");
      } finally {
        await feeClient.end();
      }
    } catch (e) {
      console.log("aviso: nao foi possivel preparar o Postgres para o teste (" + e.message + ")");
    }
  }
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      SETTINGS_FILE: SETTINGS_TEST_FILE,
      ACCOUNTS_FILE: ACCOUNTS_TEST_FILE,
      MP_ACCESS_TOKEN: "" // sem token do Mercado Pago: /auth/fee e /create-pix respondem 503 de forma deterministica
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOut = "";
  child.stdout.on("data", (d) => {
    serverOut += d.toString();
  });
  child.stderr.on("data", (d) => {
    serverOut += d.toString();
  });

  try {
    if (!(await waitReady(child))) {
      console.log("FAIL servidor nao subiu na porta " + PORT);
      console.log(serverOut);
      process.exitCode = 1;
      return;
    }

    // (g) regressao: versao e settings
    console.log("== regressao: versao e settings ==");
    const root = await req("GET", "/");
    check("GET / retorna version 1.8.11", root.status === 200 && root.data && root.data.version === "1.8.11", JSON.stringify(root.data));
    const settings = await req("GET", "/settings");
    check("GET /settings traz feeDays 1", settings.status === 200 && settings.data && settings.data.feeDays === 1, JSON.stringify(settings.data));

    // (a) criar sem campos de grupo -> padroes
    console.log("== (a) chamado sem grupo: padroes ==");
    const plain = await req("POST", "/calls", baseCall());
    check(
      "criar sem grupo devolve 201 com groupId null, groupIndex 1, groupTotal 1",
      plain.status === 201 &&
        plain.data.call.groupId === null &&
        plain.data.call.groupIndex === 1 &&
        plain.data.call.groupTotal === 1,
      JSON.stringify(plain.data)
    );
    const plainId = plain.data && plain.data.call && plain.data.call.id;

    // (b) multi-moto REMOVIDO (v1.8.7): POST com campos de grupo cria
    // UM chamado avulso — groupId/groupIndex/groupTotal sao ignorados.
    // Chamador diferente do de (a): (a) deixou um chamado pendente e
    // a mesma conta nao pode ter dois ativos.
    console.log("== (b) campos de grupo ignorados: UM chamado avulso ==");
    const countB0 = (await req("GET", "/calls?status=all")).data.count;
    const grouped = await req(
      "POST",
      "/calls",
      baseCall({ callerPhone: "81999990010", groupId: "grp-teste-1", groupIndex: 2, groupTotal: 3 })
    );
    check(
      "criar com campos de grupo devolve 201 com groupId null, groupIndex 1, groupTotal 1 (avulso)",
      grouped.status === 201 &&
        grouped.data.call.groupId === null &&
        grouped.data.call.groupIndex === 1 &&
        grouped.data.call.groupTotal === 1,
      JSON.stringify(grouped.data)
    );
    const groupedId = grouped.data && grouped.data.call && grouped.data.call.id;
    const byId = await req("GET", "/calls/" + groupedId);
    check(
      "GET /calls/:id devolve o chamado avulso (sem grupo)",
      byId.status === 200 &&
        byId.data.call.groupId === null &&
        byId.data.call.groupIndex === 1 &&
        byId.data.call.groupTotal === 1,
      JSON.stringify(byId.data)
    );
    const list = await req("GET", "/calls");
    const listed = (list.data.calls || []).find((c) => c.id === groupedId);
    check(
      "GET /calls lista o chamado avulso (sem grupo)",
      !!listed && listed.groupId === null && listed.groupIndex === 1 && listed.groupTotal === 1,
      JSON.stringify(list.data)
    );
    const countB1 = (await req("GET", "/calls?status=all")).data.count;
    check(
      "POST com campos de grupo cria UM chamado so (count +1)",
      countB1 === countB0 + 1,
      "antes=" + countB0 + " depois=" + countB1
    );

    // (c) groupTotal "invalido" (0, 6, 2.5) nao rejeita mais: os
    // campos sao ignorados e o chamado nasce avulso (201). Cada
    // tentativa usa um chamador diferente — com o mesmo chamador,
    // a segunda ja daria 409 already_has_active_call (regra nova),
    // nao por causa do grupo.
    console.log("== (c) groupTotal invalido e ignorado (nao 400) ==");
    const before = await req("GET", "/calls?status=all");
    const countBefore = before.data.count;
    for (let i = 0; i < [0, 6, 2.5].length; i++) {
      const bad = [0, 6, 2.5][i];
      const r = await req("POST", "/calls", baseCall({ callerPhone: "8199999010" + i, groupTotal: bad }));
      check(
        "groupTotal " + bad + " -> 201 avulso (ignorado, sem invalid_group)",
        r.status === 201 &&
          r.data.call.groupId === null &&
          r.data.call.groupIndex === 1 &&
          r.data.call.groupTotal === 1,
        "status=" + r.status + " " + JSON.stringify(r.data)
      );
    }
    const after = await req("GET", "/calls?status=all");
    check(
      "tres chamados avulsos criados (count +3)",
      after.data.count === countBefore + 3,
      "antes=" + countBefore + " depois=" + after.data.count
    );

    // (d) groupIndex "invalido" tambem e ignorado (nao 400): o
    // chamado nasce avulso do mesmo jeito.
    console.log("== (d) groupIndex invalido e ignorado (nao 400) ==");
    const badIdx = [
      { groupIndex: 0, groupTotal: 3 },
      { groupIndex: 4, groupTotal: 3 },
      { groupIndex: 2 }, // sem groupTotal: antes era invalido (total 1, indice 2)
      { groupIndex: 6, groupTotal: 5 }
    ];
    for (let i = 0; i < badIdx.length; i++) {
      const bad = badIdx[i];
      const r = await req("POST", "/calls", baseCall(Object.assign({ callerPhone: "8199999011" + i }, bad)));
      check(
        "groupIndex " + JSON.stringify(bad) + " -> 201 avulso (ignorado)",
        r.status === 201 &&
          r.data.call.groupId === null &&
          r.data.call.groupIndex === 1 &&
          r.data.call.groupTotal === 1,
        "status=" + r.status + " " + JSON.stringify(r.data)
      );
    }
    const after2 = await req("GET", "/calls?status=all");
    check(
      "quatro chamados avulsos criados (count +4)",
      after2.data.count === countBefore + 7,
      "antes=" + countBefore + " depois=" + after2.data.count
    );

    // (e) corrida de aceite: dois accepts ao mesmo tempo
    console.log("== (e) corrida de aceite ==");
    const race = await req("POST", "/calls", baseCall({ callerPhone: "81999990020" }));
    const raceId = race.data.call.id;
    const results = await Promise.all([
      req("POST", "/calls/" + raceId + "/accept", { key: "test-key-1", name: "Moto 1" }),
      req("POST", "/calls/" + raceId + "/accept", { key: "test-key-2", name: "Moto 2" })
    ]);
    const statuses = results.map((r) => r.status).sort();
    const ok200 = results.find((r) => r.status === 200);
    const err409 = results.find((r) => r.status === 409);
    check(
      "dois accepts simultaneos: exatamente um 200 e um 409",
      statuses[0] === 200 && statuses[1] === 409,
      "statuses=" + JSON.stringify(statuses)
    );
    check(
      "o 409 traz error call_not_pending",
      !!err409 && err409.data && err409.data.error === "call_not_pending",
      JSON.stringify(err409 && err409.data)
    );
    check(
      "a resposta do aceite (200) traz o chamado avulso (sem grupo)",
      !!ok200 &&
        ok200.data.call.groupId === null &&
        ok200.data.call.groupIndex === 1 &&
        ok200.data.call.groupTotal === 1,
      JSON.stringify(ok200 && ok200.data)
    );
    // Libera o vencedor da corrida: conclui o chamado para (g) nao
    // depender de quem ganhou (com a regra de um chamado por moto,
    // quem ainda tem um chamado aceito nao aceitaria outro).
    const raceDone = await req("POST", "/calls/" + raceId + "/complete", { key: ok200.data.call.acceptedBy });
    check(
      "vencedor da corrida conclui o chamado (libera para aceitar outro)",
      raceDone.status === 200 && raceDone.data.call.status === "completed",
      JSON.stringify(raceDone.data)
    );

    // (f) chamado aceito some da lista de pendentes
    console.log("== (f) aceito some dos pendentes ==");
    const pending = await req("GET", "/calls");
    check(
      "chamado aceito nao esta em GET /calls (pendentes)",
      !(pending.data.calls || []).some((c) => c.id === raceId),
      JSON.stringify(pending.data)
    );
    const mine = await req("GET", "/calls?mine=" + (ok200.data.call.acceptedBy || ""));
    check(
      "chamado aceito aparece em GET /calls?mine=<aceitou>",
      (mine.data.calls || []).some((c) => c.id === raceId),
      JSON.stringify(mine.data)
    );

    // (g) regressao: fluxo criar/aceitar/fase/concluir e criar/aceitar/cancelar
    // Chamadores diferentes dos das secoes anteriores (cada um deixou
    // um chamado ativo) e diferentes entre si: c2 e criado enquanto
    // c1 ainda esta aceito — com o mesmo chamador daria 409.
    console.log("== (g) regressao: fluxo completo ==");
    const c1 = await req("POST", "/calls", baseCall({ callerPhone: "81999990030" }));
    const c1id = c1.data.call.id;
    const a1 = await req("POST", "/calls/" + c1id + "/accept", { key: "test-key-1", name: "Moto 1" });
    check("fluxo: accept devolve 200 accepted", a1.status === 200 && a1.data.call.status === "accepted", JSON.stringify(a1.data));
    const ph = await req("POST", "/calls/" + c1id + "/phase", { key: "test-key-1", phase: "coleta_confirmada" });
    check(
      "fluxo: phase devolve 200 com a fase e os campos do grupo",
      ph.status === 200 && ph.data.call.phase === "coleta_confirmada" && ph.data.call.groupTotal === 1,
      JSON.stringify(ph.data)
    );
    const done = await req("POST", "/calls/" + c1id + "/complete", { key: "test-key-1" });
    check("fluxo: complete devolve 200 completed", done.status === 200 && done.data.call.status === "completed", JSON.stringify(done.data));

    const c2 = await req("POST", "/calls", baseCall({ callerPhone: "81999990031" }));
    const c2id = c2.data.call.id;
    const a2 = await req("POST", "/calls/" + c2id + "/accept", { key: "test-key-1", name: "Moto 1" });
    check("fluxo: segundo accept devolve 200", a2.status === 200, JSON.stringify(a2.data));
    const cx = await req("POST", "/calls/" + c2id + "/cancel", { key: "test-key-1" });
    check(
      "fluxo: cancel do mototaxi devolve 200 com o chamado em espera e avulso",
      cx.status === 200 &&
        cx.data.call.status === "pending" &&
        cx.data.call.phase === "aguardando" &&
        cx.data.call.groupId === null &&
        cx.data.returnedToPending === true,
      JSON.stringify(cx.data)
    );

    // (h) um mototaxi so aceita UM chamado
    // Chamadores diferentes por chamado: h1 e h2 sao criados com o
    // outro ainda ativo — com o mesmo chamador, o segundo POST ja
    // daria 409 already_has_active_call (regra nova). h3 reusa o
    // chamador de h1 (h1 ja concluido) e h4 usa um terceiro chamador
    // (h2 continua pendente depois do cancelamento do mototaxi).
    console.log("== (h) um mototaxi so aceita UM chamado ==");
    const h1 = await req("POST", "/calls", baseCall({ callerPhone: "81999990040" }));
    const h1id = h1.data.call.id;
    const h2 = await req("POST", "/calls", baseCall({ callerPhone: "81999990041" }));
    const h2id = h2.data.call.id;
    const ha1 = await req("POST", "/calls/" + h1id + "/accept", { key: "test-key-h1", name: "Moto H1" });
    check("h1 aceita o chamado 1 -> 200", ha1.status === 200 && ha1.data.call.status === "accepted", JSON.stringify(ha1.data));
    const ha2 = await req("POST", "/calls/" + h2id + "/accept", { key: "test-key-h1", name: "Moto H1" });
    check(
      "h1 tenta aceitar o chamado 2 -> 409 driver_already_has_call",
      ha2.status === 409 && ha2.data && ha2.data.error === "driver_already_has_call",
      "status=" + ha2.status + " " + JSON.stringify(ha2.data)
    );
    const hb2 = await req("POST", "/calls/" + h2id + "/accept", { key: "test-key-h2", name: "Moto H2" });
    check("h2 aceita o chamado 2 -> 200", hb2.status === 200 && hb2.data.call.status === "accepted", JSON.stringify(hb2.data));
    const hd1 = await req("POST", "/calls/" + h1id + "/complete", { key: "test-key-h1" });
    check("h1 conclui o chamado 1 -> 200", hd1.status === 200 && hd1.data.call.status === "completed", JSON.stringify(hd1.data));
    const h3 = await req("POST", "/calls", baseCall({ callerPhone: "81999990040" }));
    const h3id = h3.data.call.id;
    const ha3 = await req("POST", "/calls/" + h3id + "/accept", { key: "test-key-h1", name: "Moto H1" });
    check("h1 livre apos concluir aceita outro chamado -> 200", ha3.status === 200, JSON.stringify(ha3.data));
    const hx2 = await req("POST", "/calls/" + h2id + "/cancel", { key: "test-key-h2" });
    check("h2 cancela o chamado 2 -> 200 em espera", hx2.status === 200 && hx2.data.call.status === "pending" && hx2.data.returnedToPending === true, JSON.stringify(hx2.data));
    const h4 = await req("POST", "/calls", baseCall({ callerPhone: "81999990042" }));
    const h4id = h4.data.call.id;
    const ha4 = await req("POST", "/calls/" + h4id + "/accept", { key: "test-key-h2", name: "Moto H2" });
    check("h2 livre apos cancelar aceita outro chamado -> 200", ha4.status === 200, JSON.stringify(ha4.data));

    // (i) chat so audio: audio gravado vai pelo servidor e volta no polling
    console.log("== (i) chat: audio gravado ==");
    const ac = await req("POST", "/calls", baseCall({ callerPhone: "81999990050" }));
    const acid = ac.data.call.id;
    const aa = await req("POST", "/calls/" + acid + "/accept", { key: "test-key-audio", name: "Moto Audio" });
    check("audio: accept do chamado -> 200", aa.status === 200, JSON.stringify(aa.data));
    const fakeAudio = "data:audio/webm;base64," + "AAAA".repeat(1000);
    const am = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: fakeAudio, durationSec: 12 });
    check("audio: enviar audio -> 201", am.status === 201, "status=" + am.status + " " + JSON.stringify(am.data));
    const gm = await req("GET", "/calls/" + acid + "/messages?for=driver&key=test-key-audio&since=0");
    const got = (gm.data.messages || []).find((m) => m.audio === fakeAudio);
    check(
      "audio: GET messages devolve o audio com durationSec",
      gm.status === 200 && !!got && got.durationSec === 12 && got.from === "driver",
      JSON.stringify(gm.data)
    );
    // v1.8.2: o MediaRecorder do Chrome/Android produz
    // data:audio/webm;codecs=opus;base64,... — o regex antigo
    // rejeitava com 400 invalid_audio e o audio "enviado" nunca
    // era salvo. O formato com parametros MIME tem que aceitar e
    // voltar no polling igual ao formato simples.
    const codecsAudio = "data:audio/webm;codecs=opus;base64," + "AAAA".repeat(1000);
    const amc = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: codecsAudio, durationSec: 8 });
    check("audio: enviar audio com ;codecs=opus -> 201", amc.status === 201, "status=" + amc.status + " " + JSON.stringify(amc.data));
    const gmc = await req("GET", "/calls/" + acid + "/messages?for=driver&key=test-key-audio&since=0");
    const gotc = (gmc.data.messages || []).find((m) => m.audio === codecsAudio);
    check(
      "audio: GET messages devolve o audio com codecs e durationSec",
      gmc.status === 200 && !!gotc && gotc.durationSec === 8 && gotc.from === "driver",
      JSON.stringify(gmc.data)
    );
    const bigAudio = "data:audio/webm;base64," + "A".repeat(200001);
    const ab = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: bigAudio, durationSec: 60 });
    check(
      "audio: audio grande demais -> 400 invalid_audio",
      ab.status === 400 && ab.data && ab.data.error === "invalid_audio",
      "status=" + ab.status + " " + JSON.stringify(ab.data)
    );
    const badAudio = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", audio: "data:text/plain;base64,AAAA", durationSec: 5 });
    check(
      "audio: mime que nao e audio -> 400 invalid_audio",
      badAudio.status === 400 && badAudio.data && badAudio.data.error === "invalid_audio",
      "status=" + badAudio.status + " " + JSON.stringify(badAudio.data)
    );
    const noContent = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio" });
    check(
      "audio: mensagem sem conteudo -> 400 missing_content",
      noContent.status === 400 && noContent.data && noContent.data.error === "missing_content",
      "status=" + noContent.status + " " + JSON.stringify(noContent.data)
    );
    const phMsg = await req("POST", "/calls/" + acid + "/messages", { from: "driver", key: "test-key-audio", photo: "data:image/jpeg;base64,/9j/AAAA" });
    check("audio: foto continua funcionando -> 201", phMsg.status === 201, "status=" + phMsg.status + " " + JSON.stringify(phMsg.data));

    // (j) cancelamento pelo mototaxi devolve o chamado para espera
    // (v1.8.1): o chamado nao some — volta para pendente, continua
    // apitando (reaparece em GET /calls) e o cliente continua vendo
    // como esperando; o moto fica livre e outro moto pode aceitar.
    console.log("== (j) mototaxi cancela -> chamado volta para espera ==");
    const j1 = await req("POST", "/calls", baseCall({ callerPhone: "81999990060" }));
    const j1id = j1.data.call.id;
    const ja1 = await req("POST", "/calls/" + j1id + "/accept", { key: "test-key-j1", name: "Moto J1" });
    check("j: moto J1 aceita -> 200", ja1.status === 200 && ja1.data.call.status === "accepted", JSON.stringify(ja1.data));
    const jc1 = await req("POST", "/calls/" + j1id + "/cancel", { key: "test-key-j1" });
    check(
      "j: moto J1 cancela -> 200 pending/aguardando, sem moto aceito, returnedToPending",
      jc1.status === 200 &&
        jc1.data.call.status === "pending" &&
        jc1.data.call.phase === "aguardando" &&
        jc1.data.call.acceptedBy === null &&
        jc1.data.call.acceptedName === null &&
        jc1.data.returnedToPending === true,
      JSON.stringify(jc1.data)
    );
    const jlist = await req("GET", "/calls");
    check(
      "j: chamado devolvido aparece de novo em GET /calls (pendentes)",
      (jlist.data.calls || []).some((c) => c.id === j1id),
      JSON.stringify(jlist.data)
    );
    const jcaller = await req("GET", "/calls?callerPhone=81999990060");
    const jseen = (jcaller.data.calls || []).find((c) => c.id === j1id);
    check(
      "j: cliente continua vendo o chamado como esperando",
      !!jseen && jseen.status === "pending",
      JSON.stringify(jcaller.data)
    );
    const j2 = await req("POST", "/calls", baseCall({ callerPhone: "81999990061" }));
    const j2id = j2.data.call.id;
    const ja2 = await req("POST", "/calls/" + j2id + "/accept", { key: "test-key-j1", name: "Moto J1" });
    check("j: J1 livre apos cancelar aceita outro chamado -> 200", ja2.status === 200 && ja2.data.call.status === "accepted", JSON.stringify(ja2.data));
    const ja3 = await req("POST", "/calls/" + j1id + "/accept", { key: "test-key-j2", name: "Moto J2" });
    check("j: outro moto aceita o chamado devolvido -> 200", ja3.status === 200 && ja3.data.call.status === "accepted", JSON.stringify(ja3.data));
    const jc2 = await req("POST", "/calls/" + j1id + "/cancel", { key: "test-key-j2" });
    check(
      "j: segundo cancelamento do moto tambem devolve para espera",
      jc2.status === 200 && jc2.data.call.status === "pending" && jc2.data.returnedToPending === true,
      JSON.stringify(jc2.data)
    );
    const jx = await req("POST", "/calls/" + j1id + "/cancel", { key: "test-key-j3" });
    check(
      "j: moto que nao aceitou nao cancela chamado pendente -> 403 not_call_party",
      jx.status === 403 && jx.data && jx.data.error === "not_call_party",
      "status=" + jx.status + " " + JSON.stringify(jx.data)
    );
    const jx2 = await req("POST", "/calls/" + j2id + "/cancel", { key: "test-key-j3" });
    check(
      "j: terceiro nao cancela chamado aceito por outro -> 403 not_call_party",
      jx2.status === 403 && jx2.data && jx2.data.error === "not_call_party",
      "status=" + jx2.status + " " + JSON.stringify(jx2.data)
    );
    const jdone = await req("POST", "/calls/" + j2id + "/complete", { key: "test-key-j1" });
    check("j: J1 conclui o chamado 2 -> 200", jdone.status === 200 && jdone.data.call.status === "completed", JSON.stringify(jdone.data));
    const jcx = await req("POST", "/calls/" + j2id + "/cancel", { key: "test-key-j1" });
    check(
      "j: cancelar chamado ja concluido -> 200 already, sem erro",
      jcx.status === 200 && jcx.data.already === true && jcx.data.call.status === "completed",
      JSON.stringify(jcx.data)
    );

    // touch no chamado avulso (a) — precisa de parte do chamado; o
    // chamador nao tem conta, entao o touch com chave desconhecida
    // deve dar 403 (regra de parte do chamado, sem mudar nada).
    const t = await req("POST", "/calls/" + plainId + "/touch", { key: "test-key-1" });
    check("touch com chave que nao e parte do chamado -> 403 not_call_party", t.status === 403 && t.data && t.data.error === "not_call_party", "status=" + t.status + " " + JSON.stringify(t.data));

    // (k) quem chamou com ID DE CONTA (v1.8.3): o app cria o chamado
    // com callerPhone=myKey(), que e o id da conta ("acc_..."), nao o
    // telefone. Antes, quem chamou levava 403 not_call_party no chat,
    // no cancelamento e no touch — o audio so ficava para quem gravou
    // e o cliente nao conseguia nem cancelar o proprio chamado.
    console.log("== (k) quem chamou com id de conta: chat, touch e cancelar ==");
    const k1 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_k1" }));
    const k1id = k1.data.call.id;
    const ka1 = await req("POST", "/calls/" + k1id + "/accept", { key: "test-key-k1", name: "Moto K1" });
    check("k: moto K1 aceita o chamado da conta -> 200", ka1.status === 200 && ka1.data.call.status === "accepted", JSON.stringify(ka1.data));
    const kAudio = "data:audio/webm;codecs=opus;base64," + "BBBB".repeat(1000);
    const km1 = await req("POST", "/calls/" + k1id + "/messages", { from: "caller", key: "acc_test_caller_k1", audio: kAudio, durationSec: 9 });
    check("k: quem chamou ENVIA audio com o id da conta -> 201", km1.status === 201, "status=" + km1.status + " " + JSON.stringify(km1.data));
    const kd1 = await req("POST", "/calls/" + k1id + "/messages", { from: "driver", key: "test-key-k1", audio: kAudio, durationSec: 9 });
    check("k: mototaxi envia audio -> 201", kd1.status === 201, "status=" + kd1.status + " " + JSON.stringify(kd1.data));
    const kg1 = await req("GET", "/calls/" + k1id + "/messages?for=caller&key=acc_test_caller_k1&since=0");
    const kGotDriver = (kg1.data.messages || []).find((m) => m.from === "driver");
    const kGotCaller = (kg1.data.messages || []).find((m) => m.from === "caller");
    check(
      "k: quem chamou RECEBE o audio do mototaxi e o proprio no polling",
      kg1.status === 200 && !!kGotDriver && !!kGotCaller,
      JSON.stringify(kg1.data)
    );
    const kg2 = await req("GET", "/calls/" + k1id + "/messages?for=driver&key=test-key-k1&since=0");
    const kGotCaller2 = (kg2.data.messages || []).find((m) => m.from === "caller");
    check(
      "k: mototaxi RECEBE o audio de quem chamou no polling",
      kg2.status === 200 && !!kGotCaller2,
      JSON.stringify(kg2.data)
    );
    const kt1 = await req("POST", "/calls/" + k1id + "/touch", { key: "acc_test_caller_k1" });
    check("k: quem chamou da touch com o id da conta -> 200", kt1.status === 200, "status=" + kt1.status + " " + JSON.stringify(kt1.data));
    const kx = await req("POST", "/calls/" + k1id + "/messages", { from: "caller", key: "test-key-terceiro", audio: kAudio, durationSec: 9 });
    check(
      "k: terceiro nao envia audio no chamado dos outros -> 403 not_call_party",
      kx.status === 403 && kx.data && kx.data.error === "not_call_party",
      "status=" + kx.status + " " + JSON.stringify(kx.data)
    );
    const kx2 = await req("GET", "/calls/" + k1id + "/messages?for=caller&key=test-key-terceiro&since=0");
    check(
      "k: terceiro nao le o chat dos outros -> 403 not_call_party",
      kx2.status === 403 && kx2.data && kx2.data.error === "not_call_party",
      "status=" + kx2.status + " " + JSON.stringify(kx2.data)
    );
    // k2 usa outro id de conta: k1 continua aceito e a mesma conta
    // nao pode ter dois chamados ativos (regra nova).
    const k2 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_k2" }));
    const k2id = k2.data.call.id;
    const kc2 = await req("POST", "/calls/" + k2id + "/cancel", { key: "acc_test_caller_k2" });
    check(
      "k: quem chamou CANCELA o proprio chamado pendente com o id da conta -> 200 cancelled",
      kc2.status === 200 && kc2.data.call.status === "cancelled",
      JSON.stringify(kc2.data)
    );
    const k3 = await req("POST", "/calls", baseCall({ callerPhone: "81999990070" }));
    const k3id = k3.data.call.id;
    const kx3 = await req("POST", "/calls/" + k3id + "/cancel", { key: "test-key-terceiro" });
    check(
      "k: chamado antigo com telefone: terceiro sem conta nao cancela -> 403 not_call_party",
      kx3.status === 403 && kx3.data && kx3.data.error === "not_call_party",
      "status=" + kx3.status + " " + JSON.stringify(kx3.data)
    );
    // (l) ajustes: carimbo fresco na subida e ida-e-volta do gratis
    console.log("== (l) ajustes: settingsAt fresco e gratis ida-e-volta ==");
    // Conta admin temporaria (a 1a conta vira admin): POST /settings
    // exige admin desde a v1.8.5 — sem token, responde 401.
    const adminReg = await req("POST", "/auth/register", { name: "Admin Teste", phone: "81999990001", password: "teste1234", role: "mototaxi" });
    check("l: registrar a 1a conta (admin) -> 201 com token", adminReg.status === 201 && adminReg.data && !!adminReg.data.token && adminReg.data.account && adminReg.data.account.isAdmin === true, JSON.stringify(adminReg.data));
    const adminToken = adminReg.data && adminReg.data.token;
    const st0 = await req("GET", "/settings");
    check(
      "l: GET /settings traz settingsAt > 0 (nunca 0) e freeFee booleano",
      st0.status === 200 && st0.data && typeof st0.data.settingsAt === "number" && st0.data.settingsAt > 0 && typeof st0.data.freeFee === "boolean",
      JSON.stringify(st0.data)
    );
    const stFreeOn = await reqAuth(adminToken, "POST", "/settings", { freeFee: true, settingsAt: Date.now() });
    check("l: POST /settings freeFee true (com token admin) -> 200", stFreeOn.status === 200 && stFreeOn.data && stFreeOn.data.ok === true, JSON.stringify(stFreeOn.data));
    const st1 = await req("GET", "/settings");
    check("l: GET /settings mostra freeFee true depois do POST", st1.status === 200 && st1.data && st1.data.freeFee === true, JSON.stringify(st1.data));
    check("l: settings.json foi gravado no disco", fs.existsSync(SETTINGS_TEST_FILE), SETTINGS_TEST_FILE);
    const stFreeOff = await reqAuth(adminToken, "POST", "/settings", { freeFee: false, settingsAt: Date.now() });
    check("l: POST /settings freeFee false (com token admin) -> 200", stFreeOff.status === 200 && stFreeOff.data && stFreeOff.data.ok === true, JSON.stringify(stFreeOff.data));
    const st2 = await req("GET", "/settings");
    check("l: GET /settings mostra freeFee false depois do POST", st2.status === 200 && st2.data && st2.data.freeFee === false, JSON.stringify(st2.data));

    // (m) ajustes persistem no reinicio: outro processo com o mesmo arquivo ve o gratis
    console.log("== (m) ajustes persistem no reinicio ==");
    await reqAuth(adminToken, "POST", "/settings", { freeFee: true, settingsAt: Date.now() });
    const child2 = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(PORT2), SETTINGS_FILE: SETTINGS_TEST_FILE, ACCOUNTS_FILE: ACCOUNTS_TEST_FILE, MP_ACCESS_TOKEN: "" }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const ready2 = await waitReadyBase(BASE2);
      check("m: segundo servidor sobe na porta " + PORT2, ready2 === true);
      const st3 = await reqBase(BASE2, "GET", "/settings");
      check(
        "m: servidor reiniciado le settings.json e devolve freeFee true",
        st3.status === 200 && st3.data && st3.data.freeFee === true,
        JSON.stringify(st3.data)
      );
    } finally {
      child2.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!child2.killed) child2.kill("SIGKILL");
    }

    // (n) chamado aceito NUNCA volta aos pendentes — para ninguem, nem depois da coleta
    console.log("== (n) aceito nunca volta aos pendentes ==");
    const n1 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_n1" }));
    const n1id = n1.data.call.id;
    const na1 = await req("POST", "/calls/" + n1id + "/accept", { key: "test-key-n1", name: "Moto N1" });
    check("n: aceite -> 200 accepted", na1.status === 200 && na1.data.call.status === "accepted", JSON.stringify(na1.data));
    const nPend = await req("GET", "/calls");
    check("n: aceito nao esta em GET /calls (pendentes)", !(nPend.data.calls || []).some((c) => c.id === n1id), JSON.stringify(nPend.data));
    const nPendOther = await req("GET", "/calls?excludeCaller=acc_test_outro_qualquer");
    check(
      "n: aceito nao esta em GET /calls?excludeCaller=<outro> — nenhum outro mototaxi o ve pendente",
      !(nPendOther.data.calls || []).some((c) => c.id === n1id),
      JSON.stringify(nPendOther.data)
    );
    const nAll = await req("GET", "/calls?status=all");
    const nFound = (nAll.data.calls || []).find((c) => c.id === n1id);
    check("n: aceito continua em GET /calls?status=all com status accepted", !!nFound && nFound.status === "accepted", JSON.stringify(nFound));
    const nPh = await req("POST", "/calls/" + n1id + "/phase", { key: "test-key-n1", phase: "coleta_confirmada" });
    check(
      "n: phase coleta_confirmada -> 200 e o status continua accepted (a coleta nao devolve o chamado para espera)",
      nPh.status === 200 && nPh.data.call.status === "accepted" && nPh.data.call.phase === "coleta_confirmada",
      JSON.stringify(nPh.data)
    );
    const nPend2 = await req("GET", "/calls");
    check("n: depois da coleta confirmada, o aceito segue fora dos pendentes", !(nPend2.data.calls || []).some((c) => c.id === n1id), JSON.stringify(nPend2.data));

    // (o) seguranca: /settings e /auth/fee exigem autenticacao; /auth/fee exige pagamento
    console.log("== (o) seguranca: ajustes e diaria exigem auth e pagamento ==");
    const oNoAuth = await req("POST", "/settings", { freeFee: true, settingsAt: Date.now() });
    check("o: POST /settings sem token -> 401 (qualquer um na internet nao liga o gratis)", oNoAuth.status === 401, JSON.stringify(oNoAuth.data));
    const userReg = await req("POST", "/auth/register", { name: "Usuario Teste", phone: "81999990002", password: "teste1234", role: "passageiro" });
    check("o: registrar a 2a conta (nao-admin) -> 201 com token", userReg.status === 201 && userReg.data && !!userReg.data.token && userReg.data.account && userReg.data.account.isAdmin === false, JSON.stringify(userReg.data));
    const userToken = userReg.data && userReg.data.token;
    const oNonAdmin = await reqAuth(userToken, "POST", "/settings", { freeFee: true, settingsAt: Date.now() });
    check("o: POST /settings com token de nao-admin -> 403", oNonAdmin.status === 403, JSON.stringify(oNonAdmin.data));
    const oFeeNoPay = await reqAuth(adminToken, "POST", "/auth/fee", {});
    check("o: POST /auth/fee sem payment_id -> 400 (diaria nao libera sem pagamento)", oFeeNoPay.status === 400 && oFeeNoPay.data && oFeeNoPay.data.error === "missing_payment_id", JSON.stringify(oFeeNoPay.data));
    const oFeeNoMp = await reqAuth(adminToken, "POST", "/auth/fee", { payment_id: "99999999999" });
    check("o: POST /auth/fee com payment_id mas sem token do Mercado Pago -> 503 (nao libera sem conferir)", oFeeNoMp.status === 503, JSON.stringify(oFeeNoMp.data));
    const oPixNoAuth = await req("POST", "/create-pix", { amount: 5, description: "x", external_ref: "diaria-teste-1", payer_email: "a@b.com" });
    check("o: POST /create-pix sem token -> 401", oPixNoAuth.status === 401, JSON.stringify(oPixNoAuth.data));
    const oPayNoAuth = await req("GET", "/payment/99999999999");
    check("o: GET /payment/:id sem token -> 401", oPayNoAuth.status === 401, JSON.stringify(oPayNoAuth.data));

    // (p) seguranca das fases e da conclusao (B10/B11/B12) + fase "chegou" (E3) + busy na presenca (B3)
    console.log("== (p) fase exige parte, complete exige chave, autor nao aceita o proprio chamado ==");
    // Quem chama usa o id da conta como callerPhone (igual ao app: callerPhone=myKey()).
    // Sem conta registrada, o servidor nao reconhece o autor como parte (403 not_call_party).
    const pCallerReg = await req("POST", "/auth/register", { name: "Chamador Teste", phone: "81999990003", password: "teste1234", role: "passageiro" });
    check("p: registrar conta de quem chama -> 201 com id", pCallerReg.status === 201 && pCallerReg.data && pCallerReg.data.account && !!pCallerReg.data.account.id, JSON.stringify(pCallerReg.data));
    const pCallerKey = pCallerReg.data.account.id;
    const p1 = await req("POST", "/calls", baseCall({ callerPhone: pCallerKey }));
    const p1id = p1.data.call.id;
    const pa1 = await req("POST", "/calls/" + p1id + "/accept", { key: "test-key-p1", name: "Moto P1" });
    check("p: aceite -> 200 accepted", pa1.status === 200 && pa1.data.call.status === "accepted", JSON.stringify(pa1.data));
    const pNoKey = await req("POST", "/calls/" + p1id + "/phase", { phase: "coleta_confirmada" });
    check("p: phase sem key -> 400 missing_key", pNoKey.status === 400 && pNoKey.data && pNoKey.data.error === "missing_key", JSON.stringify(pNoKey.data));
    const pStranger = await req("POST", "/calls/" + p1id + "/phase", { key: "test-key-estranho", phase: "coleta_confirmada" });
    check("p: phase de quem nao e parte -> 403 not_call_party", pStranger.status === 403 && pStranger.data && pStranger.data.error === "not_call_party", JSON.stringify(pStranger.data));
    const pBadPhase = await req("POST", "/calls/" + p1id + "/phase", { key: "test-key-p1", phase: "fase_que_nao_existe" });
    check("p: phase desconhecida -> 400 invalid_phase", pBadPhase.status === 400 && pBadPhase.data && pBadPhase.data.error === "invalid_phase", JSON.stringify(pBadPhase.data));
    const pChegouDriver = await req("POST", "/calls/" + p1id + "/phase", { key: "test-key-p1", phase: "chegou" });
    check("p: phase chegou do mototaxi -> 200 com a fase", pChegouDriver.status === 200 && pChegouDriver.data.call.phase === "chegou", JSON.stringify(pChegouDriver.data));
    const pChegouCaller = await req("POST", "/calls/" + p1id + "/phase", { key: pCallerKey, phase: "chegou" });
    check("p: phase chegou de quem chamou -> 200 (as duas pontas podem mudar a fase)", pChegouCaller.status === 200 && pChegouCaller.data.call.phase === "chegou", JSON.stringify(pChegouCaller.data));
    const pColetaCaller = await req("POST", "/calls/" + p1id + "/phase", { key: pCallerKey, phase: "coleta_confirmada" });
    check("p: phase coleta_confirmada de quem chamou -> 200", pColetaCaller.status === 200 && pColetaCaller.data.call.phase === "coleta_confirmada", JSON.stringify(pColetaCaller.data));
    const pNoKeyComplete = await req("POST", "/calls/" + p1id + "/complete", {});
    check("p: complete sem key -> 400 missing_key", pNoKeyComplete.status === 400 && pNoKeyComplete.data && pNoKeyComplete.data.error === "missing_key", JSON.stringify(pNoKeyComplete.data));
    const pEmptyKeyComplete = await req("POST", "/calls/" + p1id + "/complete", { key: "" });
    check("p: complete com key vazia -> 400 missing_key", pEmptyKeyComplete.status === 400 && pEmptyKeyComplete.data && pEmptyKeyComplete.data.error === "missing_key", JSON.stringify(pEmptyKeyComplete.data));
    const pDone = await req("POST", "/calls/" + p1id + "/complete", { key: "test-key-p1" });
    check("p: complete do mototaxi que aceitou -> 200 completed", pDone.status === 200 && pDone.data.call.status === "completed", JSON.stringify(pDone.data));
    // p2 so pode ser criado depois de p1 concluido: a mesma conta nao
    // pode ter dois chamados ativos (regra nova da v1.8.7).
    const p2 = await req("POST", "/calls", baseCall({ callerPhone: pCallerKey }));
    const p2id = p2.data.call.id;
    const pCancel = await req("POST", "/calls/" + p2id + "/cancel", { key: pCallerKey });
    check("p: cancel de quem chamou -> 200 cancelled", pCancel.status === 200 && pCancel.data.call.status === "cancelled", JSON.stringify(pCancel.data));
    const pPhaseCancelled = await req("POST", "/calls/" + p2id + "/phase", { key: pCallerKey, phase: "chegou" });
    check("p: phase em chamado cancelado -> 409 call_cancelled", pPhaseCancelled.status === 409 && pPhaseCancelled.data && pPhaseCancelled.data.error === "call_cancelled", JSON.stringify(pPhaseCancelled.data));
    // p3 usa um chamador novo: o padrao (81999990000) deixou um
    // chamado pendente la em (a) e daria 409.
    const p3 = await req("POST", "/calls", baseCall({ callerPhone: "81999990071" }));
    const p3id = p3.data.call.id;
    const pOwnAccept = await req("POST", "/calls/" + p3id + "/accept", { key: "81999990071", name: "Teste" });
    check("p: autor do chamado nao aceita o proprio chamado -> 403 cannot_accept_own_call", pOwnAccept.status === 403 && pOwnAccept.data && pOwnAccept.data.error === "cannot_accept_own_call", JSON.stringify(pOwnAccept.data));
    const pBusy1 = await req("POST", "/presence", { key: "test-key-busy1", name: "Moto Busy", lat: -7.5, lng: -35.3, online: true, busy: true });
    check("p: presence com busy:true -> 200", pBusy1.status === 200 && pBusy1.data && pBusy1.data.online === true, JSON.stringify(pBusy1.data));
    const pBusy2 = await req("POST", "/presence", { key: "test-key-busy2", name: "Moto Livre", lat: -7.5, lng: -35.3, online: true });
    check("p: presence sem busy -> 200", pBusy2.status === 200 && pBusy2.data && pBusy2.data.online === true, JSON.stringify(pBusy2.data));
    const pPres = await req("GET", "/presence");
    const pBusyFound = (pPres.data.drivers || []).find((d) => d.key === "test-key-busy1");
    const pFreeFound = (pPres.data.drivers || []).find((d) => d.key === "test-key-busy2");
    check("p: GET /presence devolve busy:true para quem esta em servico", !!pBusyFound && pBusyFound.busy === true, JSON.stringify(pBusyFound));
    check("p: GET /presence devolve busy:false para quem nao mandou busy", !!pFreeFound && pFreeFound.busy === false, JSON.stringify(pFreeFound));

    // (q) uma conta, um chamado ativo por vez (v1.8.7): a regra nova
    // do POST /calls — pendente ou aceito bloqueia um segundo
    // chamado da MESMA conta; concluido/cancelado libera; outra
    // conta nao e afetada.
    console.log("== (q) uma conta, um chamado ativo por vez ==");
    const q1 = await req("POST", "/calls", baseCall({ callerPhone: "81999990080" }));
    check("q: primeiro chamado da conta -> 201", q1.status === 201, JSON.stringify(q1.data));
    const q1id = q1.data.call.id;
    const q1b = await req("POST", "/calls", baseCall({ callerPhone: "81999990080" }));
    check(
      "q: segundo chamado com o primeiro pendente -> 409 already_has_active_call",
      q1b.status === 409 && q1b.data && q1b.data.error === "already_has_active_call",
      "status=" + q1b.status + " " + JSON.stringify(q1b.data)
    );
    check(
      "q: o 409 devolve o chamado ativo na resposta",
      q1b.data && q1b.data.call && q1b.data.call.id === q1id,
      JSON.stringify(q1b.data)
    );
    const qa1 = await req("POST", "/calls/" + q1id + "/accept", { key: "test-key-q1", name: "Moto Q1" });
    check("q: aceite do primeiro -> 200", qa1.status === 200 && qa1.data.call.status === "accepted", JSON.stringify(qa1.data));
    const q1c = await req("POST", "/calls", baseCall({ callerPhone: "81999990080" }));
    check(
      "q: segundo chamado com o primeiro aceito -> 409 already_has_active_call",
      q1c.status === 409 && q1c.data && q1c.data.error === "already_has_active_call",
      "status=" + q1c.status + " " + JSON.stringify(q1c.data)
    );
    const qd1 = await req("POST", "/calls/" + q1id + "/complete", { key: "test-key-q1" });
    check("q: concluir o primeiro -> 200 completed", qd1.status === 200 && qd1.data.call.status === "completed", JSON.stringify(qd1.data));
    const q2 = await req("POST", "/calls", baseCall({ callerPhone: "81999990080" }));
    check("q: novo chamado depois de concluir o primeiro -> 201", q2.status === 201, JSON.stringify(q2.data));
    // Mesmo telefone escrito de outro jeito ((81) 99999-...) e a
    // mesma conta: tambem bloqueia (comparacao pelos digitos).
    const q2b = await req("POST", "/calls", baseCall({ callerPhone: "(81) 99999-0080" }));
    check(
      "q: mesmo telefone com formatacao diferente -> 409 already_has_active_call",
      q2b.status === 409 && q2b.data && q2b.data.error === "already_has_active_call",
      "status=" + q2b.status + " " + JSON.stringify(q2b.data)
    );
    // Chamado ativo de OUTRA conta nao bloqueia (cada conta tem o seu).
    const qOther = await req("POST", "/calls", baseCall({ callerPhone: "81999990081" }));
    check("q: chamado ativo de outra conta nao bloqueia -> 201", qOther.status === 201, JSON.stringify(qOther.data));
    const qOtherB = await req("POST", "/calls", baseCall({ callerPhone: "81999990081" }));
    check(
      "q: a outra conta tambem nao cria um segundo -> 409 already_has_active_call",
      qOtherB.status === 409 && qOtherB.data && qOtherB.data.error === "already_has_active_call",
      "status=" + qOtherB.status + " " + JSON.stringify(qOtherB.data)
    );
    // Cancelar libera: conta com id de conta (acc_...) consegue
    // cancelar o proprio chamado pendente (o telefone sozinho nao
    // identifica a conta no cancelamento).
    const q3 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_q3" }));
    check("q: primeiro chamado da conta acc_ -> 201", q3.status === 201, JSON.stringify(q3.data));
    const q3id = q3.data.call.id;
    const q3b = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_q3" }));
    check(
      "q: segundo chamado da conta acc_ -> 409 already_has_active_call",
      q3b.status === 409 && q3b.data && q3b.data.error === "already_has_active_call",
      "status=" + q3b.status + " " + JSON.stringify(q3b.data)
    );
    const q3x = await req("POST", "/calls/" + q3id + "/cancel", { key: "acc_test_caller_q3" });
    check("q: cliente cancela o proprio chamado -> 200 cancelled", q3x.status === 200 && q3x.data.call.status === "cancelled", JSON.stringify(q3x.data));
    const q4 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_q3" }));
    check("q: novo chamado depois de cancelar o primeiro -> 201", q4.status === 201, JSON.stringify(q4.data));

    // (r) editar conta: PATCH /auth/users/:id (v1.8.8) — so admin,
    // so name/phone/feeDays, validacao antes de alterar, persiste.
    console.log("== (r) PATCH /auth/users/:id edita conta ==");
    const rReg = await req("POST", "/auth/register", { name: "Moto R", phone: "81999990090", password: "teste1234", role: "mototaxi" });
    check("r: registrar conta para editar -> 201", rReg.status === 201 && rReg.data && rReg.data.account && !!rReg.data.account.id, JSON.stringify(rReg.data));
    const rId = rReg.data.account.id;
    check(
      "r: conta nova nasce com feeDays null (usa o geral)",
      rReg.data.account.feeDays === null,
      JSON.stringify(rReg.data.account)
    );
    const rNoAuth = await req("PATCH", "/auth/users/" + rId, { name: "Outro" });
    check("r: PATCH sem token -> 401", rNoAuth.status === 401, JSON.stringify(rNoAuth.data));
    const rNonAdmin = await reqAuth(userToken, "PATCH", "/auth/users/" + rId, { name: "Outro" });
    check("r: PATCH com token de nao-admin -> 403", rNonAdmin.status === 403, JSON.stringify(rNonAdmin.data));
    const rMissing = await reqAuth(adminToken, "PATCH", "/auth/users/acc_que_nao_existe", { name: "Outro" });
    check("r: PATCH em conta inexistente -> 404", rMissing.status === 404, JSON.stringify(rMissing.data));
    // Dados invalidos: cada um da 400 e nao altera nada.
    const rBad = [
      [{ name: "" }, "name vazio"],
      [{ name: "   " }, "name so espacos"],
      [{ phone: "" }, "phone vazio"],
      [{ feeDays: 0 }, "feeDays 0"],
      [{ feeDays: -5 }, "feeDays negativo"],
      [{ feeDays: 1.5 }, "feeDays fracao"],
      [{ feeDays: "30" }, "feeDays texto"],
      [{ feeDays: true }, "feeDays booleano"]
    ];
    for (const [body, label] of rBad) {
      const bad = await reqAuth(adminToken, "PATCH", "/auth/users/" + rId, body);
      check("r: PATCH " + label + " -> 400", bad.status === 400, "status=" + bad.status + " " + JSON.stringify(bad.data));
    }
    const rAfterBad = await reqAuth(adminToken, "GET", "/auth/users");
    const rUnchanged = (rAfterBad.data.users || []).find((u) => u.id === rId);
    check(
      "r: depois dos PATCH invalidos a conta segue intacta (nome, telefone, feeDays null)",
      !!rUnchanged && rUnchanged.name === "Moto R" && rUnchanged.phone === "81999990090" && rUnchanged.feeDays === null,
      JSON.stringify(rUnchanged)
    );
    // PATCH valido: nome + telefone + feeDays de uma vez.
    const rOk = await reqAuth(adminToken, "PATCH", "/auth/users/" + rId, { name: "Moto Editado", phone: "81999990095", feeDays: 30 });
    check(
      "r: PATCH valido -> 200 com nome, telefone e feeDays atualizados",
      rOk.status === 200 && rOk.data && rOk.data.account && rOk.data.account.name === "Moto Editado" && rOk.data.account.phone === "81999990095" && rOk.data.account.feeDays === 30,
      JSON.stringify(rOk.data)
    );
    const rList = await reqAuth(adminToken, "GET", "/auth/users");
    const rFound = (rList.data.users || []).find((u) => u.id === rId);
    check(
      "r: GET /auth/users mostra a conta editada com feeDays 30",
      !!rFound && rFound.name === "Moto Editado" && rFound.phone === "81999990095" && rFound.feeDays === 30,
      JSON.stringify(rFound)
    );
    // PATCH so o nome: os outros campos nao mudam.
    const rNameOnly = await reqAuth(adminToken, "PATCH", "/auth/users/" + rId, { name: "Moto R2" });
    check(
      "r: PATCH so com name -> 200, so o nome muda (telefone e feeDays ficam)",
      rNameOnly.status === 200 && rNameOnly.data.account.name === "Moto R2" && rNameOnly.data.account.phone === "81999990095" && rNameOnly.data.account.feeDays === 30,
      JSON.stringify(rNameOnly.data)
    );
    // PATCH vazio: nada para mudar, devolve a conta como esta.
    const rEmpty = await reqAuth(adminToken, "PATCH", "/auth/users/" + rId, {});
    check(
      "r: PATCH vazio -> 200 com a conta inalterada",
      rEmpty.status === 200 && rEmpty.data.account.name === "Moto R2" && rEmpty.data.account.feeDays === 30,
      JSON.stringify(rEmpty.data)
    );
    // feeDays null volta a usar o geral.
    const rNull = await reqAuth(adminToken, "PATCH", "/auth/users/" + rId, { feeDays: null });
    check(
      "r: PATCH feeDays null -> 200 com feeDays null (volta ao geral)",
      rNull.status === 200 && rNull.data.account.feeDays === null && rNull.data.account.name === "Moto R2" && rNull.data.account.phone === "81999990095",
      JSON.stringify(rNull.data)
    );
    // O admin NAO tira o proprio admin nem a propria isencao por aqui:
    // os campos isAdmin/feeExempt sao ignorados; so o nome muda.
    const adminId = adminReg.data.account.id;
    const rSelf = await reqAuth(adminToken, "PATCH", "/auth/users/" + adminId, { name: "Admin Renomeada", isAdmin: false, feeExempt: false });
    check(
      "r: PATCH na propria conta do admin com isAdmin/feeExempt falsos -> 200, nome muda mas isAdmin e feeExempt continuam true",
      rSelf.status === 200 && rSelf.data.account.name === "Admin Renomeada" && rSelf.data.account.isAdmin === true && rSelf.data.account.feeExempt === true,
      JSON.stringify(rSelf.data)
    );
    // Persiste no reinicio: outro processo com o mesmo accounts.json
    // ve a conta editada (nome, telefone, feeDays null).
    const child2r = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(PORT2), SETTINGS_FILE: SETTINGS_TEST_FILE, ACCOUNTS_FILE: ACCOUNTS_TEST_FILE, MP_ACCESS_TOKEN: "" }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const ready2r = await waitReadyBase(BASE2);
      check("r: segundo servidor sobe na porta " + PORT2, ready2r === true);
      const rList2 = await reqAuthBase(BASE2, adminToken, "GET", "/auth/users");
      const rFound2 = (rList2.data.users || []).find((u) => u.id === rId);
      check(
        "r: servidor reiniciado le accounts.json e ve a conta editada (feeDays null)",
        rList2.status === 200 && !!rFound2 && rFound2.name === "Moto R2" && rFound2.phone === "81999990095" && rFound2.feeDays === null,
        JSON.stringify(rFound2)
      );
    } finally {
      child2r.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!child2r.killed) child2r.kill("SIGKILL");
    }

    // (s) diaria por conta: POST /auth/fee usa o feeDays da conta
    // (v1.8.8) — com um mock local do Mercado Pago (MP_API_BASE) e
    // uma terceira instancia do servidor, para nao tocar no
    // servidor principal nem no Mercado Pago de verdade.
    console.log("== (s) POST /auth/fee usa feeDays da conta ==");
    try {
      fs.unlinkSync(SETTINGS_FEE_TEST_FILE);
    } catch (e) {
      // nao existia: nada a limpar
    }
    try {
      fs.unlinkSync(ACCOUNTS_FEE_TEST_FILE);
    } catch (e) {
      // nao existia: nada a limpar
    }
    // Mock do Mercado Pago: qualquer GET /v1/payments/<id> devolve
    // um pagamento APROVADO de R$ 5 com referencia de diaria — o
    // suficiente para o /auth/fee conferir e liberar.
    const mockMp = http.createServer((mockReq, mockRes) => {
      const m = /^\/v1\/payments\/([^/?]+)$/.exec(mockReq.url || "");
      if (mockReq.method === "GET" && m) {
        const pid = decodeURIComponent(m[1]);
        mockRes.writeHead(200, { "Content-Type": "application/json" });
        mockRes.end(JSON.stringify({
          id: pid,
          status: "approved",
          status_detail: "accredited",
          transaction_amount: 5,
          external_reference: "diaria-teste-" + pid
        }));
        return;
      }
      mockRes.writeHead(404, { "Content-Type": "application/json" });
      mockRes.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise((resolve) => mockMp.listen(MOCK_MP_PORT, "127.0.0.1", resolve));
    const child3 = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT3),
        SETTINGS_FILE: SETTINGS_FEE_TEST_FILE,
        ACCOUNTS_FILE: ACCOUNTS_FEE_TEST_FILE,
        MP_ACCESS_TOKEN: "test-token",
        MP_API_BASE: "http://127.0.0.1:" + MOCK_MP_PORT + "/v1/payments"
      }, feeDbUrl ? { DATABASE_URL: feeDbUrl } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const ready3 = await waitReadyBase(BASE3);
      check("s: terceiro servidor sobe na porta " + PORT3 + " (com mock do Mercado Pago)", ready3 === true);
      if (ready3) {
        const sAdminReg = await reqBase(BASE3, "POST", "/auth/register", { name: "Admin Fee", phone: "81999990096", password: "teste1234", role: "mototaxi" });
        check("s: registrar admin no servidor 3 -> 201", sAdminReg.status === 201 && sAdminReg.data && !!sAdminReg.data.token, JSON.stringify(sAdminReg.data));
        const sAdminToken = sAdminReg.data && sAdminReg.data.token;
        const sM1Reg = await reqBase(BASE3, "POST", "/auth/register", { name: "Moto Fee 1", phone: "81999990097", password: "teste1234", role: "mototaxi" });
        check("s: registrar mototaxi M1 -> 201 com feeDays null", sM1Reg.status === 201 && sM1Reg.data && sM1Reg.data.account && sM1Reg.data.account.feeDays === null, JSON.stringify(sM1Reg.data));
        const sM1Id = sM1Reg.data.account.id;
        const sM1Token = sM1Reg.data.token;
        // Conta com feeDays=30: um pagamento vale 30 dias (720h).
        const sPatch30 = await reqAuthBase(BASE3, sAdminToken, "PATCH", "/auth/users/" + sM1Id, { feeDays: 30 });
        check("s: PATCH feeDays 30 na conta M1 -> 200", sPatch30.status === 200 && sPatch30.data.account.feeDays === 30, JSON.stringify(sPatch30.data));
        const sBefore1 = Date.now();
        const sFee1 = await reqAuthBase(BASE3, sM1Token, "POST", "/auth/fee", { payment_id: "fee-test-1" });
        const sAfter1 = Date.now();
        const sPaid1 = sFee1.data && sFee1.data.account && sFee1.data.account.paidUntil;
        check(
          "s: POST /auth/fee com feeDays 30 -> 200 e paidUntil ~ agora + 30 dias",
          sFee1.status === 200 && typeof sPaid1 === "number" && sPaid1 >= sBefore1 + 30 * 24 * 3600 * 1000 - 5000 && sPaid1 <= sAfter1 + 30 * 24 * 3600 * 1000 + 5000,
          "status=" + sFee1.status + " paidUntil=" + sPaid1 + " " + JSON.stringify(sFee1.data)
        );
        // Mudar o feeDays NAO altera um paidUntil ja pago.
        const sPatch7 = await reqAuthBase(BASE3, sAdminToken, "PATCH", "/auth/users/" + sM1Id, { feeDays: 7 });
        check("s: PATCH feeDays 7 na conta M1 -> 200", sPatch7.status === 200 && sPatch7.data.account.feeDays === 7, JSON.stringify(sPatch7.data));
        const sMe = await reqAuthBase(BASE3, sM1Token, "GET", "/auth/me");
        check(
          "s: mudar o feeDays nao altera o paidUntil ja pago",
          sMe.status === 200 && sMe.data.account.paidUntil === sPaid1,
          JSON.stringify(sMe.data)
        );
        // feeDays null volta ao geral (1 dia): a renovacao acumula a
        // partir do fim da vigencia atual (+ 1 dia em cima dos 30).
        const sPatchNull = await reqAuthBase(BASE3, sAdminToken, "PATCH", "/auth/users/" + sM1Id, { feeDays: null });
        check("s: PATCH feeDays null na conta M1 -> 200", sPatchNull.status === 200 && sPatchNull.data.account.feeDays === null, JSON.stringify(sPatchNull.data));
        const sFee2 = await reqAuthBase(BASE3, sM1Token, "POST", "/auth/fee", { payment_id: "fee-test-2" });
        const sPaid2 = sFee2.data && sFee2.data.account && sFee2.data.account.paidUntil;
        check(
          "s: POST /auth/fee com feeDays null usa o geral (1 dia): paidUntil ~ anterior + 1 dia",
          sFee2.status === 200 && typeof sPaid2 === "number" && Math.abs(sPaid2 - (sPaid1 + 24 * 3600 * 1000)) < 120000,
          "status=" + sFee2.status + " paidUntil=" + sPaid2 + " anterior=" + sPaid1 + " " + JSON.stringify(sFee2.data)
        );
        // Conta sem feeDays nunca definido tambem usa o geral (1 dia).
        const sM2Reg = await reqBase(BASE3, "POST", "/auth/register", { name: "Moto Fee 2", phone: "81999990098", password: "teste1234", role: "mototaxi" });
        check("s: registrar mototaxi M2 (sem feeDays) -> 201", sM2Reg.status === 201 && sM2Reg.data && !!sM2Reg.data.token, JSON.stringify(sM2Reg.data));
        const sM2Token = sM2Reg.data.token;
        const sBefore3 = Date.now();
        const sFee3 = await reqAuthBase(BASE3, sM2Token, "POST", "/auth/fee", { payment_id: "fee-test-3" });
        const sAfter3 = Date.now();
        const sPaid3 = sFee3.data && sFee3.data.account && sFee3.data.account.paidUntil;
        check(
          "s: POST /auth/fee de conta sem feeDays usa o geral -> paidUntil ~ agora + 1 dia",
          sFee3.status === 200 && typeof sPaid3 === "number" && sPaid3 >= sBefore3 + 24 * 3600 * 1000 - 5000 && sPaid3 <= sAfter3 + 24 * 3600 * 1000 + 5000,
          "status=" + sFee3.status + " paidUntil=" + sPaid3 + " " + JSON.stringify(sFee3.data)
        );
      }
    } finally {
      child3.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!child3.killed) child3.kill("SIGKILL");
      await new Promise((resolve) => mockMp.close(resolve));
      try {
        fs.unlinkSync(SETTINGS_FEE_TEST_FILE);
      } catch (e) {
        // ja apagado ou nunca criado
      }
      try {
        fs.unlinkSync(ACCOUNTS_FEE_TEST_FILE);
      } catch (e) {
        // ja apagado ou nunca criado
      }
      try {
        fs.unlinkSync(ACCOUNTS_FEE_TEST_FILE + ".tmp");
      } catch (e) {
        // ja apagado ou nunca criado
      }
    }

    // (t) ENTREGA ja coletada: o mototaxi NAO pode cancelar (v1.8.9,
    // regra dela 09/11) — ele ja esta com o produto e tem que entregar
    // ate o fim. A caminho da coleta o cancelamento continua valendo
    // (volta para espera) e a corrida (passageiro) nao muda, nem o
    // cliente cancelar uma entrega coletada.
    console.log("== (t) entrega coletada: mototaxi nao cancela, o resto nao muda ==");
    const t1 = await req("POST", "/calls", baseCall({ callerPhone: "81999990072", type: "entrega", amount: 7 }));
    const t1id = t1.data.call.id;
    check("t: entrega criada -> 201 tipo entrega valor 7", t1.status === 201 && t1.data.call.type === "entrega" && t1.data.call.amount === 7, JSON.stringify(t1.data));
    const ta1 = await req("POST", "/calls/" + t1id + "/accept", { key: "test-key-t1", name: "Moto T1" });
    check("t: moto T1 aceita a entrega -> 200", ta1.status === 200 && ta1.data.call.status === "accepted", JSON.stringify(ta1.data));
    // A caminho da coleta: cancelar ainda vale (volta para espera).
    const tc0 = await req("POST", "/calls/" + t1id + "/cancel", { key: "test-key-t1" });
    check(
      "t: moto cancela entrega A CAMINHO da coleta -> 200 volta para espera",
      tc0.status === 200 && tc0.data.call.status === "pending" && tc0.data.returnedToPending === true,
      JSON.stringify(tc0.data)
    );
    const ta2 = await req("POST", "/calls/" + t1id + "/accept", { key: "test-key-t1", name: "Moto T1" });
    check("t: moto aceita de novo a mesma entrega -> 200", ta2.status === 200 && ta2.data.call.status === "accepted", JSON.stringify(ta2.data));
    // A loja confirma a coleta (o mototaxi esta com o produto).
    const tp1 = await req("POST", "/calls/" + t1id + "/phase", { phase: "coleta_confirmada", key: "test-key-t1" });
    check("t: fase coleta_confirmada pelo mototaxi -> 200", tp1.status === 200 && tp1.data.call.phase === "coleta_confirmada", JSON.stringify(tp1.data));
    // Agora o mototaxi NAO pode mais cancelar: 409 e o chamado continua aceito.
    const tc1 = await req("POST", "/calls/" + t1id + "/cancel", { key: "test-key-t1" });
    check(
      "t: moto cancela entrega JA COLETADA -> 409 delivery_already_collected",
      tc1.status === 409 && tc1.data && tc1.data.error === "delivery_already_collected",
      "status=" + tc1.status + " " + JSON.stringify(tc1.data)
    );
    const tget = await req("GET", "/calls?callerPhone=81999990072");
    const tseen = (tget.data.calls || []).find((c) => c.id === t1id);
    check(
      "t: entrega coletada continua aceita depois do 409",
      !!tseen && tseen.status === "accepted" && tseen.phase === "coleta_confirmada",
      JSON.stringify(tget.data)
    );
    // E ele ainda consegue concluir (a regra so tira o cancelar).
    const td1 = await req("POST", "/calls/" + t1id + "/complete", { key: "test-key-t1" });
    check("t: moto conclui a entrega coletada -> 200", td1.status === 200 && td1.data.call.status === "completed", JSON.stringify(td1.data));
    // Corrida (passageiro) NAO muda: mesmo coletada, o mototaxi cancela e volta para espera.
    const t2 = await req("POST", "/calls", baseCall({ callerPhone: "81999990073", type: "corrida" }));
    const t2id = t2.data.call.id;
    check("t: corrida criada -> 201 tipo corrida", t2.status === 201 && t2.data.call.type === "corrida", JSON.stringify(t2.data));
    const ta3 = await req("POST", "/calls/" + t2id + "/accept", { key: "test-key-t2", name: "Moto T2" });
    check("t: moto T2 aceita a corrida -> 200", ta3.status === 200 && ta3.data.call.status === "accepted", JSON.stringify(ta3.data));
    const tp2 = await req("POST", "/calls/" + t2id + "/phase", { phase: "coleta_confirmada", key: "test-key-t2" });
    check("t: fase coleta_confirmada na corrida -> 200", tp2.status === 200 && tp2.data.call.phase === "coleta_confirmada", JSON.stringify(tp2.data));
    const tc2 = await req("POST", "/calls/" + t2id + "/cancel", { key: "test-key-t2" });
    check(
      "t: moto cancela corrida JA COLETADA -> 200 volta para espera (passageiro nao muda)",
      tc2.status === 200 && tc2.data.call.status === "pending" && tc2.data.returnedToPending === true,
      JSON.stringify(tc2.data)
    );
    // Cliente cancelar entrega coletada NAO muda (cancela de vez, como antes).
    const t3 = await req("POST", "/calls", baseCall({ callerPhone: "acc_test_caller_t3", type: "entrega", amount: 7 }));
    const t3id = t3.data.call.id;
    check("t: entrega 3 criada -> 201 tipo entrega", t3.status === 201 && t3.data.call.type === "entrega", JSON.stringify(t3.data));
    const ta4 = await req("POST", "/calls/" + t3id + "/accept", { key: "test-key-t3", name: "Moto T3" });
    check("t: moto T3 aceita a entrega -> 200", ta4.status === 200 && ta4.data.call.status === "accepted", JSON.stringify(ta4.data));
    const tp3 = await req("POST", "/calls/" + t3id + "/phase", { phase: "coleta_confirmada", key: "test-key-t3" });
    check("t: fase coleta_confirmada na entrega 3 -> 200", tp3.status === 200 && tp3.data.call.phase === "coleta_confirmada", JSON.stringify(tp3.data));
    const tc3 = await req("POST", "/calls/" + t3id + "/cancel", { key: "acc_test_caller_t3" });
    check(
      "t: CLIENTE cancela entrega coletada -> 200 cancelled (cliente nao muda)",
      tc3.status === 200 && tc3.data.call.status === "cancelled",
      JSON.stringify(tc3.data)
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill("SIGKILL");
    try {
      fs.unlinkSync(SETTINGS_TEST_FILE);
    } catch (e) {
      // ja apagado ou nunca criado
    }
    try {
      fs.unlinkSync(ACCOUNTS_TEST_FILE);
    } catch (e) {
      // ja apagado ou nunca criado
    }
    try {
      fs.unlinkSync(ACCOUNTS_TEST_FILE + ".tmp");
    } catch (e) {
      // ja apagado ou nunca criado
    }
  }

  console.log("\n" + passed + " passaram, " + failed + " falharam.");
  if (failures.length) {
    console.log("Falhas:");
    for (const f of failures) console.log(" - " + f);
  }
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error("Erro no teste:", err);
  process.exitCode = 1;
});
