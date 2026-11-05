// Servidor local de la presentación. Sirve la página, ejecuta los comandos de
// las terminales embebidas, consulta el estado del clúster y hace de proxy de
// Kibana para poder mostrarlo dentro de la página sin iniciar sesión.
// Escucha solo en 127.0.0.1 y exige un token por sesión en cada llamada a /api.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Dentro del repositorio la presentación vive en ppt/, así que el repo es la carpeta de arriba
const REPO = path.resolve(process.env.REPO || (existsSync(path.join(HERE, '..', 'local.sh')) ? path.join(HERE, '..') : path.join(HERE, '..', 'the-store-main')));
const PORT = Number(process.env.PORT || 4173);
const KIBANA_PORT = Number(process.env.KIBANA_PORT || 4174);
const STORE = 'http://localhost'; // el Ingress de ui solo responde al host localhost
// El token se guarda en un archivo para que reiniciar el servidor no deje inválida la página abierta
const TOKEN_FILE = path.join(HERE, '.token');
const TOKEN = (() => {
  try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {
    const t = randomBytes(16).toString('hex');
    writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
    return t;
  }
})();
const ORIGIN = `http://localhost:${PORT}`;

// ---------- utilidades ----------

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function authorized(req) {
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN && origin !== `http://127.0.0.1:${PORT}`) return false;
  return req.headers['x-token'] === TOKEN;
}

// ---------- estado del clúster ----------

const WATCHED = new Set(['the-store', 'logging', 'ingress-nginx', 'kube-system']);

function appOf(pod) {
  const l = pod.metadata.labels || {};
  const app = l['app.kubernetes.io/name'] || l.app || l.component || l['k8s-app'] || l['job-name'] || pod.metadata.name;
  if (app === 'ingress-nginx' && l['app.kubernetes.io/component'] === 'controller') return 'ingress-nginx';
  return app;
}

async function clusterState() {
  const [pods, nodes] = await Promise.all([
    run('kubectl', ['get', 'pods', '-A', '-o', 'json']),
    run('kubectl', ['get', 'nodes', '-o', 'json']),
  ]);
  if (!pods.ok || !nodes.ok) return { ok: false, error: (pods.stderr || nodes.stderr).trim() };
  const nodeList = JSON.parse(nodes.stdout).items.map((n) => ({
    name: n.metadata.name,
    role: n.metadata.labels['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker',
    ip: (n.status.addresses || []).find((a) => a.type === 'InternalIP')?.address,
    podCIDR: n.spec.podCIDR,
    ready: (n.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'),
  }));
  let others = 0;
  const podList = [];
  for (const p of JSON.parse(pods.stdout).items) {
    const ns = p.metadata.namespace;
    if (!WATCHED.has(ns)) { others++; continue; }
    if (ns === 'ingress-nginx' && appOf(p) !== 'ingress-nginx') continue; // jobs de admisión
    const cs = p.status.containerStatuses || [];
    const waiting = cs.map((c) => c.state?.waiting?.reason).find(Boolean);
    const terminated = cs.map((c) => c.state?.terminated?.reason).find(Boolean);
    podList.push({
      ns,
      name: p.metadata.name,
      app: appOf(p),
      node: p.spec.nodeName || null,
      ip: p.status.podIP || null,
      phase: p.metadata.deletionTimestamp ? 'Terminating' : (waiting || (p.status.phase === 'Succeeded' ? 'Completed' : terminated) || p.status.phase),
      ready: cs.length > 0 && cs.every((c) => c.ready),
      restarts: cs.reduce((a, c) => a + (c.restartCount || 0), 0),
      created: p.metadata.creationTimestamp,
    });
  }
  followPods(podList);
  return { ok: true, nodes: nodeList, pods: podList, others };
}

// Un port-forward queda atado al pod que eligió al arrancar: si ese pod se reemplaza,
// la primera conexión falla. Cuando cambian los pods listos del servicio, se relanza antes.
const forwardPods = new Map();
function followPods(podList) {
  for (const { svc, ns = 'the-store' } of FORWARDS) {
    const ready = podList.filter((p) => p.ns === ns && p.app === svc && p.ready && p.phase === 'Running').map((p) => p.name).sort().join(',');
    if (!ready) continue;
    const before = forwardPods.get(svc);
    forwardPods.set(svc, ready);
    if (before !== undefined && before !== ready) forwardChildren.get(svc)?.kill();
  }
}

// ---------- errores recientes por servicio (para pintar en rojo) ----------

const ERROR_RULES = {
  ui: { target: 'deploy/ui', re: /"log\.level":"ERROR"|"level":"ERROR"/ },
  catalog: { target: 'deploy/catalog', re: /\|\s*5\d\d\s*\|/ },
  carts: { target: 'deploy/carts', re: /"log\.level":"ERROR"|"level":"ERROR"/ },
  checkout: { target: 'deploy/checkout', re: /\bERROR\b| 5\d\d [\d.]+ms/ },
  orders: { target: 'deploy/orders', re: /"log\.level":"ERROR"|"level":"ERROR"/ },
};

async function recentErrors(sinceSeconds) {
  const since = `${Math.max(5, Math.min(3600, Number(sinceSeconds) || 60))}s`;
  const jobs = Object.entries(ERROR_RULES).map(async ([app, r]) => {
    const out = await run('kubectl', ['-n', 'the-store', 'logs', r.target, `--since=${since}`, '--all-containers']);
    const lines = out.stdout.split('\n').filter((l) => r.re.test(l));
    return [app, lines.length];
  });
  const ing = run('kubectl', ['-n', 'ingress-nginx', 'logs', 'deploy/ingress-nginx-controller', `--since=${since}`]).then((out) => {
    const lines = out.stdout.split('\n').filter((l) => /"status_code":\s*"?5\d\d/.test(l) || /" 5\d\d \d+ "/.test(l));
    return ['ingress-nginx', lines.length];
  });
  return Object.fromEntries(await Promise.all([...jobs, ing]));
}

// ---------- compra completa contra la tienda ----------

const PRODUCTS = [
  'cc789f85-1476-452a-8100-9e74502198e0', '87e89b11-d319-446d-b9be-50adcca5224a',
  '4f18544b-70a5-4352-8e19-0d070f46745d', '79bce3f3-935f-4912-8c62-0d2f3e059405',
  'd27cf49f-b689-4a75-a249-d373e0330bb5', '1ca35e86-4b4c-4124-b6b5-076ba4134d0d',
];

// Mismos pasos que el escenario del load-generator de la cátedra
function purchaseSteps() {
  const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
  return [
    { id: 'home', label: 'Entra a la tienda', method: 'GET', url: '/home' },
    { id: 'product', label: 'Abre un producto', method: 'GET', url: `/catalog/${product}` },
    { id: 'add', label: 'Lo agrega al carrito', method: 'POST', url: '/cart', form: { productId: product } },
    { id: 'cart', label: 'Revisa el carrito', method: 'GET', url: '/cart' },
    { id: 'checkout', label: 'Inicia el checkout', method: 'GET', url: '/checkout' },
    { id: 'shipping', label: 'Carga la dirección', method: 'POST', url: '/checkout', form: { firstName: 'John', lastName: 'Doe', email: 'john_doe@example.com', streetAddress: '100 Main Street', city: 'Anytown', state: 'CA', zipCode: '11111' } },
    { id: 'delivery', label: 'Elige el envío', method: 'POST', url: '/checkout/delivery', form: { token: 'priority-mail' } },
    { id: 'payment', label: 'Paga', method: 'POST', url: '/checkout/payment', form: { cardHolder: 'John Doe', cardNumber: '1234567890123456', expiryDate: '01/35', cvc: '123' } },
  ];
}

async function storeRequest(step, jar) {
  const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  let body;
  if (step.form) {
    body = new URLSearchParams(step.form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const t0 = Date.now();
  let url = STORE + step.url;
  let method = step.method;
  // Se siguen las redirecciones a mano para conservar las cookies
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    for (const c of r.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = new URL(r.headers.get('location'), url).toString();
      method = 'GET'; body = undefined; delete headers['Content-Type'];
      await r.arrayBuffer();
      continue;
    }
    await r.arrayBuffer();
    return { status: r.status, ms: Date.now() - t0 };
  }
  return { status: 0, ms: Date.now() - t0 };
}

async function purchase(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const jar = new Map();
  const started = new Date().toISOString();
  res.write(JSON.stringify({ type: 'start', at: started }) + '\n');
  for (const step of purchaseSteps()) {
    res.write(JSON.stringify({ type: 'step', id: step.id, label: step.label, method: step.method, url: step.url }) + '\n');
    let r;
    try { r = await storeRequest(step, jar); } catch (e) { r = { status: 0, ms: 0, error: String(e.message || e) }; }
    res.write(JSON.stringify({ type: 'result', id: step.id, ...r }) + '\n');
    if (r.status === 0 || r.status >= 400) break;
  }
  res.end(JSON.stringify({ type: 'end', at: new Date().toISOString() }) + '\n');
}

// ---------- tráfico de fondo ----------

let trafficTimer = null;
function setTraffic(on) {
  if (on && !trafficTimer) {
    const pages = ['/home', '/catalog', ...PRODUCTS.map((p) => `/catalog/${p}`), '/cart'];
    trafficTimer = setInterval(() => {
      const p = pages[Math.floor(Math.random() * pages.length)];
      fetch(STORE + p, { signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer()).catch(() => {});
    }, 700);
  } else if (!on && trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = null;
  }
  return Boolean(trafficTimer);
}

// ---------- terminales ----------

function exec(req, res, cmd) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const child = spawn('bash', ['-lc', cmd], {
    cwd: REPO,
    detached: true,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat' },
  });
  const write = (d) => { if (!res.writableEnded) res.write(d); };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.on('close', (code, signal) => {
    if (!res.writableEnded) res.end(`\u0000EXIT:${signal ? 130 : code}`);
  });
  // Si la página corta la conexión (Ctrl+C), se mata todo el grupo de procesos
  res.on('close', () => {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGINT'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
    }
  });
}

// ---------- port-forwards permanentes: catalog, checkout y Kibana ----------
// Kibana se alcanza directo y no por el Ingress: así su propio tráfico no aparece
// como logs de ingress-nginx en las búsquedas de la demo. Hasta que EFK exista, reintenta.

const FORWARDS = [
  { svc: 'catalog', port: 8081 },
  { svc: 'checkout', port: 8082 },
  { svc: 'kibana', port: 5601, ns: 'logging', remote: 5601 },
];
const forwardState = {};
const forwardChildren = new Map();

function keepForward({ svc, port, ns = 'the-store', remote = 80 }) {
  const start = () => {
    const child = spawn('kubectl', ['-n', ns, 'port-forward', `svc/${svc}`, `${port}:${remote}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    forwardChildren.set(svc, child);
    forwardState[svc] = 'iniciando';
    child.stdout.on('data', (d) => { if (/Forwarding from/.test(d)) forwardState[svc] = 'activo'; });
    // Si el pod de destino ya no existe, kubectl sigue vivo pero falla cada conexión: se reinicia
    child.stderr.on('data', (d) => { if (/error|lost connection/i.test(d)) child.kill(); });
    child.on('exit', () => {
      forwardState[svc] = 'caído';
      setTimeout(start, 2000); // si se borra el pod, el port-forward muere: se relanza
    });
  };
  start();
}

// ---------- proxy de Kibana ----------

// Dentro del iframe, las flechas y Esc no llegan a la presentación (otro origen):
// este script se las reenvía, salvo cuando se está escribiendo en un campo de Kibana.
const DECK_KEYS_JS = `
addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest?.('.monaco-editor, [role="combobox"]'));
  if (e.key === 'Escape' || (!typing && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key))) {
    parent.postMessage({ deckKey: e.key }, '*');
  }
}, true);`;

let kibanaAuth = null;
async function kibanaCredentials(force = false) {
  if (kibanaAuth && !force) return kibanaAuth;
  const r = await run('kubectl', ['-n', 'logging', 'get', 'secret', 'es-credentials', '-o', 'jsonpath={.data.elastic}']);
  if (!r.ok || !r.stdout) return null;
  const pw = Buffer.from(r.stdout, 'base64').toString('utf8');
  kibanaAuth = 'Basic ' + Buffer.from(`elastic:${pw}`).toString('base64');
  return kibanaAuth;
}

const kibanaProxy = http.createServer(async (req, res) => {
  const auth = await kibanaCredentials();
  if (!auth) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p style="font:16px system-ui;padding:24px">Kibana todavía no está instalado.</p>');
    return;
  }
  // Script propio que Kibana carga desde su mismo origen (lo permite su CSP)
  if (req.url === '/__deck-keys.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(DECK_KEYS_JS);
    return;
  }
  const headers = { ...req.headers, host: 'localhost:5601', authorization: auth };
  delete headers.origin; delete headers.referer; delete headers.cookie;
  delete headers['accept-encoding']; // para poder insertar el script en el HTML
  const upstream = http.request({ host: '127.0.0.1', port: 5601, method: req.method, path: req.url, headers }, (up) => {
    const h = { ...up.headers };
    delete h['x-frame-options'];
    // Kibana exige que el navegador aplique su CSP: se conserva y solo se quita frame-ancestors
    if (h['content-security-policy']) {
      h['content-security-policy'] = h['content-security-policy'].split(';').map((d) => d.trim())
        .filter((d) => d && !d.startsWith('frame-ancestors')).join('; ');
    }
    delete h['set-cookie'];
    if (up.statusCode === 401) kibanaAuth = null; // la contraseña cambia si se reinstala
    if (!String(h['content-type'] || '').includes('text/html')) {
      res.writeHead(up.statusCode, h);
      up.pipe(res);
      return;
    }
    // En las páginas HTML se agrega el script que devuelve el teclado a la presentación
    const chunks = [];
    up.on('data', (c) => chunks.push(c));
    up.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8').replace('</head>', '<script src="/__deck-keys.js"></script></head>');
      delete h['content-length'];
      res.writeHead(up.statusCode, h);
      res.end(html);
    });
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});

// ---------- servidor principal ----------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/scenes.js': ['scenes.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/viewport-base.css': ['viewport-base.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (STATIC[url.pathname] && req.method === 'GET') {
      const [file, type] = STATIC[url.pathname];
      let body = await readFile(path.join(HERE, file), 'utf8');
      if (file === 'index.html') body = body.replace('__TOKEN__', TOKEN).replace('__KIBANA_PORT__', String(KIBANA_PORT));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (!authorized(req)) return json(res, 403, { error: 'token inválido' });

    if (url.pathname === '/api/state') return json(res, 200, { ...(await clusterState()), forwards: forwardState, traffic: Boolean(trafficTimer) });
    if (url.pathname === '/api/errors') return json(res, 200, await recentErrors(url.searchParams.get('since')));
    if (url.pathname === '/api/purchase' && req.method === 'POST') return purchase(res);
    if (url.pathname === '/api/traffic' && req.method === 'POST') return json(res, 200, { on: setTraffic((await readBody(req)).on) });
    if (url.pathname === '/api/exec' && req.method === 'POST') {
      const { cmd } = await readBody(req);
      if (typeof cmd !== 'string' || !cmd.trim()) return json(res, 400, { error: 'comando vacío' });
      return exec(req, res, cmd);
    }
    json(res, 404, { error: 'no existe' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  kibanaProxy.listen(KIBANA_PORT, '127.0.0.1');
  FORWARDS.forEach(keepForward);
  console.log(`Presentación: ${ORIGIN}`);
  console.log(`Kibana (proxy): http://localhost:${KIBANA_PORT}`);
  console.log(`Repo: ${REPO}`);
});

// Al cerrar el servidor no quedan port-forwards huérfanos
const shutdown = () => {
  for (const c of forwardChildren.values()) { c.removeAllListeners('exit'); c.kill(); }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
