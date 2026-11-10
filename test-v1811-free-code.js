// Teste end-to-end do codigo de liberacao para trabalhar de graca
// (backend v1.8.11). Sobe o server.js de verdade num diretorio de
// teste isolado (accounts/settings/free-codes/pix-charges em /tmp),
// com um mock local do Mercado Pago para o pagamento da diaria.
// Nao toca nos arquivos de producao nem no servidor ao vivo.
//
// Casos: (a) gratuito ligado + nao liberado -> presence/accept 402
// free_authorization_required; (b) gerar + verificar certo -> liberado
// e trabalha; (c) codigo de OUTRA conta -> 400; (d) codigo antigo
// invalidado por um novo + codigo usado de novo -> 400 + codigo
// expirado -> 400 (servidor com TTL curto); (e) gratuito desligado ->
// generate/verify 409 free_mode_off, presence/accept 402 fee_required;
// (f) gratuito religado -> liberado anterior trabalha sem digitar de
// novo; (g) revogar (PATCH freeAuthorized:false) -> nao trabalha mais
// de graca; (h) com diaria paga, trabalha sem codigo mesmo com o
// gratuito desligado. Extras: GET /auth/users traz freeAuthorized;
// PATCH freeAuthorized:true libera direto; versao 1.8.11.
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIR = "/tmp/mtt-v1811-test";
const PORT = 3456;
const MOCK_MP_PORT = 3457;
const BASE = "http://127.0.0.1:" + PORT;
const LAT = -7.5148, LNG = -35.3189; // centro de Timbauba

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log("PASS: " + name); }
  else { failed++; failures.push(name); console.log("FAIL: " + name + (detail ? " — " + detail : "")); }
}

async function req(method, p, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, j };
}
const reqAuth = (t, m, p, b) => req(m, p, b, t);

function waitReady(base, tries = 50) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(base + "/");
        if (r.ok) return true;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
}

function startServer(extraEnv, script) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    ACCOUNTS_FILE: path.join(DIR, "accounts.json"),
    SETTINGS_FILE: path.join(DIR, "settings.json"),
    FREE_CODES_FILE: path.join(DIR, "free-codes.json"),
    PIX_CHARGES_FILE: path.join(DIR, "pix-charges.json"),
    MP_ACCESS_TOKEN: "test-token",
    MP_API_BASE: "http://127.0.0.1:" + MOCK_MP_PORT + "/v1/payments"
  }, extraEnv || {});
  const child = spawn("node", [script || path.join(__dirname, "server.js")], { env, stdio: "ignore" });
  return child;
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  // Mock do Mercado Pago: qualquer pagamento consultado esta aprovado,
  // referencia de diaria, valor R$ 1 (o valor da diaria no teste).
  const mockMp = http.createServer((mockReq, mockRes) => {
    const m = /^\/v1\/payments\/([^/?]+)$/.exec(mockReq.url || "");
    if (mockReq.method === "GET" && m) {
      mockRes.writeHead(200, { "Content-Type": "application/json" });
      mockRes.end(JSON.stringify({ status: "approved", external_reference: "diaria-test-1", transaction_amount: 1 }));
      return;
    }
    mockRes.writeHead(404, { "Content-Type": "application/json" });
    mockRes.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => mockMp.listen(MOCK_MP_PORT, "127.0.0.1", resolve));

  const srv = startServer();
  const ready = await waitReady(BASE);
  check("servidor sobe", ready);
  if (!ready) { srv.kill(); mockMp.close(); process.exit(1); }

  const root = await req("GET", "/");
  check("versao 1.8.11", root.j && root.j.version === "1.8.11", JSON.stringify(root.j));

  // Contas: admin (primeira = dona, isenta), 3 mototaxis e 1 cliente.
  async function register(name, phone, role) {
    const r = await req("POST", "/auth/register", { name, phone, password: "senha123", role });
    return r;
  }
  const admin = await register("Dona Admin", "81999990001", "mototaxi");
  check("registra admin (primeira conta)", admin.status === 201 && !!admin.j.token, JSON.stringify(admin.j));
  const adminToken = admin.j.token;
  const d1 = await register("Motorista Um", "81999990002", "mototaxi");
  const d2 = await register("Motorista Dois", "81999990003", "mototaxi");
  const d3 = await register("Motorista Tres", "81999990004", "mototaxi");
  const cli = await register("Cliente Teste", "81999990005", "passageiro");
  check("registra motoristas e cliente", d1.status === 201 && d2.status === 201 && d3.status === 201 && cli.status === 201);
  const d1Token = d1.j.token, d2Token = d2.j.token, d3Token = d3.j.token;
  const d1Id = d1.j.account.id, d2Id = d2.j.account.id, d3Id = d3.j.account.id;

  // Configuracao do teste: diaria R$ 1, gratuito LIGADO.
  const set1 = await reqAuth(adminToken, "POST", "/settings", { fee: 1, ride: 6, delivery: 5, feeDays: 1, freeFee: true });
  check("liga o modo gratuito (freeFee true)", set1.ok, JSON.stringify(set1.j));
  const me1 = await reqAuth(d1Token, "GET", "/auth/me");
  check("conta nova nasce sem liberacao (freeAuthorized false)", me1.j && me1.j.account && me1.j.account.freeAuthorized === false, JSON.stringify(me1.j));

  async function makeCall() {
    const r = await req("POST", "/calls", { callerName: "Cliente Teste", callerPhone: cli.j.account.id, type: "corrida", pickup: "Rua A, 1", destination: "Rua B, 2", amount: 6 });
    return r;
  }
  const presence = (id) => req("POST", "/presence", { key: id, online: true, lat: LAT, lng: LNG, name: "Moto" });
  const accept = (callId, id) => req("POST", "/calls/" + callId + "/accept", { key: id, name: "Moto" });

  // (a) Gratuito ligado + nao liberado: presence e accept recusados com erro distinto.
  const pa = await presence(d1Id);
  check("(a) presence sem liberacao -> 402 free_authorization_required", pa.status === 402 && pa.j && pa.j.error === "free_authorization_required", JSON.stringify(pa.j));
  const callA = await makeCall();
  check("(a) cria chamado para o teste", callA.status === 200 || callA.status === 201, JSON.stringify(callA.j));
  const accA = await accept(callA.j.call.id, d1Id);
  check("(a) accept sem liberacao -> 402 free_authorization_required", accA.status === 402 && accA.j && accA.j.error === "free_authorization_required", JSON.stringify(accA.j));

  // (b) Gerar + verificar certo -> liberado e trabalha.
  const genB = await reqAuth(adminToken, "POST", "/auth/free-code/generate", { accountId: d1Id });
  check("(b) admin gera codigo para D1 -> 200 com codigo de 6 digitos", genB.status === 200 && genB.j && /^\d{6}$/.test(genB.j.code || ""), JSON.stringify(genB.j));
  const codeB = genB.j.code;
  const verB = await reqAuth(d1Token, "POST", "/auth/free-code/verify", { code: codeB });
  check("(b) D1 verifica o proprio codigo -> 200 e freeAuthorized true", verB.status === 200 && verB.j && verB.j.account && verB.j.account.freeAuthorized === true, JSON.stringify(verB.j));
  const pb = await presence(d1Id);
  check("(b) presence liberado -> 200", pb.status === 200, JSON.stringify(pb.j));
  const accB = await accept(callA.j.call.id, d1Id);
  check("(b) accept liberado -> 200", accB.status === 200, JSON.stringify(accB.j));
  // Libera o motorista: cancela como moto (volta para espera) e como cliente (cancela de vez).
  await req("POST", "/calls/" + callA.j.call.id + "/cancel", { key: d1Id });
  await req("POST", "/calls/" + callA.j.call.id + "/cancel", { key: cli.j.account.id });
  const usersB = await reqAuth(adminToken, "GET", "/auth/users");
  const d1Row = (usersB.j && usersB.j.users || []).find((u) => u.id === d1Id);
  check("(b) GET /auth/users traz freeAuthorized true para D1", !!d1Row && d1Row.freeAuthorized === true, JSON.stringify(d1Row));

  // (c) Codigo de OUTRA conta nao serve.
  const genC = await reqAuth(adminToken, "POST", "/auth/free-code/generate", { accountId: d2Id });
  const verC = await reqAuth(d1Token, "POST", "/auth/free-code/verify", { code: genC.j.code });
  check("(c) D1 verifica codigo de D2 -> 400 invalid_code", verC.status === 400 && verC.j && verC.j.error === "invalid_code", JSON.stringify(verC.j));

  // (d) Gerar novo invalida o anterior; codigo usado de novo nao vale.
  const genD1 = await reqAuth(adminToken, "POST", "/auth/free-code/generate", { accountId: d1Id });
  const genD2 = await reqAuth(adminToken, "POST", "/auth/free-code/generate", { accountId: d1Id });
  const verDold = await reqAuth(d1Token, "POST", "/auth/free-code/verify", { code: genD1.j.code });
  check("(d) codigo antigo invalidado pelo novo -> 400", verDold.status === 400 && verDold.j && verDold.j.error === "invalid_code", JSON.stringify(verDold.j));
  const verDnew = await reqAuth(d1Token, "POST", "/auth/free-code/verify", { code: genD2.j.code });
  check("(d) codigo novo vale -> 200", verDnew.status === 200, JSON.stringify(verDnew.j));
  const verDagain = await reqAuth(d1Token, "POST", "/auth/free-code/verify", { code: genD2.j.code });
  check("(d) mesmo codigo usado de novo -> 400", verDagain.status === 400 && verDagain.j && verDagain.j.error === "invalid_code", JSON.stringify(verDagain.j));

  // (d2) Codigo expirado: servidor com TTL de 2 s. A copia fica NO
  // diretorio do backend (senao o require("express") nao resolve).
  const shortScript = path.join(__dirname, "server-short-ttl.js");
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  fs.writeFileSync(shortScript, src.replace("FREE_CODE_TTL_MS = 30 * 60 * 1000", "FREE_CODE_TTL_MS = 2000"));
  // O segundo servidor usa a mesma porta: parar o primeiro ANTES de subir o segundo.
  srv.kill();
  await new Promise((r) => setTimeout(r, 800));
  const srv2 = startServer({ PORT: String(PORT), ACCOUNTS_FILE: path.join(DIR, "accounts2.json"), SETTINGS_FILE: path.join(DIR, "settings2.json"), FREE_CODES_FILE: path.join(DIR, "free-codes2.json"), PIX_CHARGES_FILE: path.join(DIR, "pix-charges2.json") }, shortScript);
  const ready2 = await waitReady(BASE);
  check("(d) segundo servidor (TTL curto) sobe", ready2);
  const admin2 = await register("Dona Admin", "81999990001", "mototaxi");
  const dx = await register("Motorista X", "81999990009", "mototaxi");
  await reqAuth(admin2.j.token, "POST", "/settings", { fee: 1, ride: 6, delivery: 5, feeDays: 1, freeFee: true });
  const genX = await reqAuth(admin2.j.token, "POST", "/auth/free-code/generate", { accountId: dx.j.account.id });
  await new Promise((r) => setTimeout(r, 2500));
  const verX = await reqAuth(dx.j.token, "POST", "/auth/free-code/verify", { code: genX.j.code });
  check("(d) codigo expirado (2 s) -> 400 invalid_code", verX.status === 400 && verX.j && verX.j.error === "invalid_code", JSON.stringify(verX.j));
  srv2.kill();
  try { fs.unlinkSync(shortScript); } catch (e) {}
  await new Promise((r) => setTimeout(r, 500));

  // Volta o servidor principal (mesmos dados de antes).
  const srv3 = startServer();
  const ready3 = await waitReady(BASE);
  check("servidor principal volta", ready3);
  // Re-login (os tokens antigos seguem validos — estao no accounts.json).
  const loginD1 = await req("POST", "/auth/login", { phone: "81999990002", password: "senha123" });
  const loginD2 = await req("POST", "/auth/login", { phone: "81999990003", password: "senha123" });
  const loginAdmin = await req("POST", "/auth/login", { phone: "81999990001", password: "senha123" });
  const tD1 = loginD1.j.token, tD2 = loginD2.j.token, tAdmin = loginAdmin.j.token;
  check("re-login apos reinicio", !!tD1 && !!tD2 && !!tAdmin);

  // (e) Gratuito DESLIGADO: generate/verify recusam; presence/accept viram fee_required.
  const setOff = await reqAuth(tAdmin, "POST", "/settings", { fee: 1, ride: 6, delivery: 5, feeDays: 1, freeFee: false });
  check("(e) desliga o modo gratuito", setOff.ok, JSON.stringify(setOff.j));
  const genE = await reqAuth(tAdmin, "POST", "/auth/free-code/generate", { accountId: d1Id });
  check("(e) generate com gratuito desligado -> 409 free_mode_off", genE.status === 409 && genE.j && genE.j.error === "free_mode_off", JSON.stringify(genE.j));
  const verE = await reqAuth(tD1, "POST", "/auth/free-code/verify", { code: "123456" });
  check("(e) verify com gratuito desligado -> 409 free_mode_off", verE.status === 409 && verE.j && verE.j.error === "free_mode_off", JSON.stringify(verE.j));
  const pe = await presence(d1Id);
  check("(e) presence de liberado sem diaria e com gratuito desligado -> 402 fee_required", pe.status === 402 && pe.j && pe.j.error === "fee_required", JSON.stringify(pe.j));
  const callE = await makeCall();
  const accE = await accept(callE.j.call.id, d1Id);
  check("(e) accept idem -> 402 fee_required", accE.status === 402 && accE.j && accE.j.error === "fee_required", JSON.stringify(accE.j));
  await req("POST", "/calls/" + callE.j.call.id + "/cancel", { key: cli.j.account.id });

  // (f) Gratuito religado: liberado anterior trabalha SEM digitar de novo.
  const setOn = await reqAuth(tAdmin, "POST", "/settings", { fee: 1, ride: 6, delivery: 5, feeDays: 1, freeFee: true });
  check("(f) religa o modo gratuito", setOn.ok, JSON.stringify(setOn.j));
  const pf = await presence(d1Id);
  check("(f) presence de liberado anterior -> 200 sem novo codigo", pf.status === 200, JSON.stringify(pf.j));

  // (g) Revogar: PATCH freeAuthorized:false -> nao trabalha mais de graca.
  const rev = await reqAuth(tAdmin, "PATCH", "/auth/users/" + d1Id, { freeAuthorized: false });
  check("(g) admin revoga (PATCH freeAuthorized:false) -> 200", rev.status === 200 && rev.j && rev.j.account && rev.j.account.freeAuthorized === false, JSON.stringify(rev.j));
  const pg = await presence(d1Id);
  check("(g) presence apos revogar -> 402 free_authorization_required", pg.status === 402 && pg.j && pg.j.error === "free_authorization_required", JSON.stringify(pg.j));

  // Extra: PATCH freeAuthorized:true libera direto, sem codigo.
  const lib = await reqAuth(tAdmin, "PATCH", "/auth/users/" + d3Id, { freeAuthorized: true });
  check("extra: PATCH freeAuthorized:true libera D3 direto -> 200", lib.status === 200 && lib.j && lib.j.account && lib.j.account.freeAuthorized === true, JSON.stringify(lib.j));
  const p3 = await presence(d3Id);
  check("extra: presence de D3 liberado direto -> 200", p3.status === 200, JSON.stringify(p3.j));

  // (h) Com diaria paga, trabalha sem codigo mesmo com o gratuito desligado.
  const setOff2 = await reqAuth(tAdmin, "POST", "/settings", { fee: 1, ride: 6, delivery: 5, feeDays: 1, freeFee: false });
  check("(h) desliga o gratuito de novo", setOff2.ok);
  const feeH = await reqAuth(tD2, "POST", "/auth/fee", { payment_id: "fee-test-1" });
  check("(h) D2 paga a diaria (mock MP aprovado) -> 200", feeH.status === 200 && feeH.j && feeH.j.account && (feeH.j.account.paidUntil || 0) > Date.now(), JSON.stringify(feeH.j));
  const ph = await presence(d2Id);
  check("(h) presence de D2 pago, gratuito desligado, sem codigo -> 200", ph.status === 200, JSON.stringify(ph.j));
  const callH = await makeCall();
  const accH = await accept(callH.j.call.id, d2Id);
  check("(h) accept de D2 pago -> 200", accH.status === 200, JSON.stringify(accH.j));
  // Admin (isenta) continua trabalhando sem codigo e sem diaria, com o gratuito desligado.
  const meAdmin = await reqAuth(tAdmin, "GET", "/auth/me");
  const pAdmin = await presence(meAdmin.j.account.id);
  check("(h) admin isenta trabalha sem codigo e sem diaria -> 200", pAdmin.status === 200, JSON.stringify(pAdmin.j));

  srv3.kill();
  mockMp.close();
  console.log("\n==== RESULTADO: " + passed + " PASS, " + failed + " FAIL ====");
  if (failures.length) console.log("Falhas: " + failures.join(" | "));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("ERRO NO TESTE:", err);
  process.exit(2);
});
