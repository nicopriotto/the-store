// Motor de la presentación. El contenido de cada escena está en scenes.js.
// Las diapositivas y el espacio del clúster viven en un lienzo fijo de 1920 × 1080
// que se escala entero a la ventana. El espacio del clúster se arma con
// `kubectl get pods`: los nodos son burbujas que flotan y los pods, círculos que
// rebotan adentro. Las terminales ejecutan comandos reales en el servidor local.
'use strict';

/* ===========================================
   UTILIDADES
   =========================================== */
const TOKEN = document.querySelector('meta[name="token"]').content;
const KIBANA = `http://localhost:${document.querySelector('meta[name="kibana-port"]').content}`;
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (a, b) => a + Math.random() * (b - a);

function api(path, opts = {}) {
  return fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN, ...(opts.headers || {}) } });
}

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// Momentos que se reutilizan en escenas posteriores (rangos de Kibana, pod borrado)
// Se guardan en la sesión del navegador: recargar la página en medio de la demo no los pierde
const marks = (() => { try { return JSON.parse(sessionStorage.getItem('marks')) || {}; } catch { return {}; } })();
const saveMarks = () => { try { sessionStorage.setItem('marks', JSON.stringify(marks)); } catch {} };
addEventListener('pagehide', saveMarks);
const iso = (d) => new Date(d).toISOString();
const around = (m, before = 60, after = 60) => m && [iso(new Date(m.from).getTime() - before * 1000), iso(new Date(m.to || Date.now()).getTime() + after * 1000)];

/* ===========================================
   LIENZO FIJO 1920 × 1080
   =========================================== */
let stageScale = 1;
function fitStage() {
  const s = $('#stage');
  stageScale = Math.min(innerWidth / 1920, innerHeight / 1080);
  s.style.transform = `translate(${(innerWidth - 1920 * stageScale) / 2}px, ${(innerHeight - 1080 * stageScale) / 2}px) scale(${stageScale})`;
}
fitStage();
addEventListener('resize', fitStage);

// Coordenadas de pantalla → coordenadas dentro de un elemento del lienzo
function toLocal(el, clientX, clientY) {
  const r = el.getBoundingClientRect();
  return { x: (clientX - r.left) / stageScale, y: (clientY - r.top) / stageScale };
}

/* ===========================================
   TERMINALES
   =========================================== */
const terms = [];
const MAX_TERMS = 6;
let activeTerm = null;
let commandCount = 0;
let countCommands = false;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function showDock(show = true) { $('#dock').hidden = !show; }

function renderTabs() {
  const tabs = $('#dock-tabs');
  tabs.innerHTML = '';
  for (const t of terms) {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t === activeTerm));
    b.title = t.title;
    if (t.abort) b.classList.add('running');
    b.innerHTML = `<span class="lbl">${esc(t.title)}</span><span class="x" title="Cerrar">×</span>`;
    b.addEventListener('click', (e) => (e.target.classList.contains('x') ? closeTerm(t) : selectTerm(t)));
    tabs.appendChild(b);
  }
  tabs.insertAdjacentHTML('beforeend', '<span class="spacer"></span>');
  const hide = document.createElement('button');
  hide.textContent = 'Ocultar ▾';
  hide.addEventListener('click', () => showDock(false));
  tabs.appendChild(hide);
}

function selectTerm(t) {
  activeTerm = t;
  t.used = Date.now();
  for (const x of terms) x.el.hidden = x !== t;
  renderTabs();
  showDock(true);
  t.input.focus();
}

function closeTerm(t) {
  t.abort?.abort();
  t.el.remove();
  terms.splice(terms.indexOf(t), 1);
  if (activeTerm === t) activeTerm = terms[terms.length - 1] || null;
  if (activeTerm) selectTerm(activeTerm); else { renderTabs(); showDock(false); }
}

// Abre (o reutiliza por título) una terminal con el comando listo: Enter lo ejecuta
function openTerm({ title, cmd = '', run = false, onExit } = {}) {
  let t = terms.find((x) => x.title === title);
  if (!t) {
    // Como mucho MAX_TERMS pestañas: se cierra la usada hace más tiempo que no esté corriendo
    const idle = terms.filter((x) => !x.abort).sort((a, b) => a.used - b.used);
    if (terms.length >= MAX_TERMS && idle.length) closeTerm(idle[0]);
    const el = document.createElement('div');
    el.className = 'term';
    el.innerHTML = '<pre class="out"></pre><div class="prompt"><span>$</span><input spellcheck="false" autocomplete="off" aria-label="Comando"></div>';
    $('#dock-body').appendChild(el);
    t = { title, el, out: el.querySelector('.out'), input: el.querySelector('input'), prompt: el.querySelector('.prompt'), history: [], hi: 0 };
    t.input.addEventListener('keydown', (e) => termKey(t, e));
    el.addEventListener('click', (e) => { if (e.target === el || e.target.tagName === 'PRE') t.input.focus(); });
    terms.push(t);
  }
  t.onExit = onExit;
  t.input.value = cmd;
  selectTerm(t);
  t.input.setSelectionRange(cmd.length, cmd.length);
  if (run) return execIn(t, cmd);
  return t;
}

function termKey(t, e) {
  if (e.key === 'c' && e.ctrlKey) { if (t.abort) { t.abort.abort(); e.preventDefault(); } return; }
  if (t.abort) { e.preventDefault(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const cmd = t.input.value.trim();
    if (cmd) execIn(t, cmd);
  } else if (e.key === 'ArrowUp' && t.history.length) {
    e.preventDefault(); t.hi = Math.max(0, t.hi - 1); t.input.value = t.history[t.hi];
  } else if (e.key === 'ArrowDown' && t.history.length) {
    e.preventDefault(); t.hi = Math.min(t.history.length, t.hi + 1); t.input.value = t.history[t.hi] || '';
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault(); t.out.textContent = '';
  }
}

function append(t, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  t.out.appendChild(span);
  t.el.scrollTop = t.el.scrollHeight;
}

async function execIn(t, cmd) {
  t.history.push(cmd);
  t.hi = t.history.length;
  t.input.value = '';
  t.prompt.classList.add('running');
  append(t, `$ ${cmd}\n`, 'cmdline');
  // Romper o restablecer un servicio (/chaos/) no es investigar: no suma al contador
  if (countCommands && !cmd.includes('/chaos/')) { commandCount++; $('#counter-n').textContent = commandCount; }
  t.abort = new AbortController();
  renderTabs();
  const started = Date.now();
  let code = null;
  let output = '';
  try {
    const r = await api('/api/exec', { method: 'POST', body: JSON.stringify({ cmd }), signal: t.abort.signal });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk = dec.decode(value, { stream: true }).replace(ANSI, '');
      const m = chunk.match(/\u0000EXIT:(\d+)$/);
      if (m) { code = Number(m[1]); chunk = chunk.slice(0, m.index); }
      output += chunk;
      append(t, chunk);
    }
  } catch (err) {
    if (err.name === 'AbortError') { append(t, '^C\n', 'sys'); code = 130; } else append(t, `error: ${err.message}\n`, 'bad');
  }
  t.abort = null;
  renderTabs();
  t.prompt.classList.remove('running');
  if (code && code !== 130) append(t, `[código de salida ${code}]\n`, 'bad');
  append(t, '\n');
  t.input.focus();
  const result = { code, output, started, ended: Date.now() };
  t.onExit?.(result);
  poll();
  return result;
}

/* ===========================================
   ESPACIO DEL CLÚSTER · modelo
   =========================================== */
const LANG = {
  ui: 'Java', carts: 'Java', orders: 'Java', catalog: 'Go', checkout: 'NestJS', 'ingress-nginx': 'nginx',
  fluentd: 'Ruby', elasticsearch: 'Java', kibana: 'Node.js', 'es-setup': 'Job',
};
const SYS_SHOW = { 'kube-apiserver': 'api-server', etcd: 'etcd', 'kube-scheduler': 'scheduler', 'kube-controller-manager': 'controller', 'kube-dns': 'coredns' };
const SHORT = { 'ingress-nginx': 'ingress', elasticsearch: 'elastic' };
const SVC_APPS = ['ui', 'catalog', 'carts', 'checkout', 'orders', 'elasticsearch', 'kibana'];
const WORLD = { w: 1360, h: 1080 };

const nodes = new Map();    // nombre → nodo
const pods = new Map();     // nombre → pod
const svcs = new Map();     // app → Service
const errorApps = new Map();
const looked = new Set();
let trails = [];            // recorridos que quedan dibujados tras una compra
let clusterData = { nodes: [], pods: [] };

const layer = (id) => document.getElementById(id);

function podKind(p) {
  if (p.ns === 'kube-system') return 'sys';
  if (p.ns === 'logging') return 'efk';
  if (p.ns === 'ingress-nginx') return 'ing';
  return 'store';
}
const podRadius = (k) => ({ sys: 28, efk: 44, ing: 44, store: 48 }[k]);

function nodeHome(node, i) {
  // Lugares fijos dentro de una zona segura: lejos de los botones de arriba y de los controles de abajo
  if (node.role === 'control-plane') return { x: 255, y: 590 }; // debajo del recibo de la compra
  return i % 2 === 0 ? { x: 900, y: 335 } : { x: 1120, y: 750 };
}

function nodeRadius(n) {
  const count = [...pods.values()].filter((p) => p.node === n.name && !p.gone).length;
  // El control-plane no es el protagonista: se mantiene más chico que los workers
  if (n.role === 'control-plane') return Math.max(150, Math.min(185, 95 + 34 * Math.sqrt(count)));
  return Math.max(180, Math.min(220, 105 + 46 * Math.sqrt(count)));
}

function reconcile(data) {
  clusterData = data;
  // Nodos
  const sorted = [...data.nodes].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'control-plane' ? -1 : 1));
  let wi = 0;
  for (const n of sorted) {
    let node = nodes.get(n.name);
    if (!node) {
      const home = nodeHome(n, n.role === 'control-plane' ? 0 : wi);
      node = { ...n, home, x: home.x, y: home.y, phase: rand(0, 6.28), r: 200, el: null };
      nodes.set(n.name, node);
      drawNode(node);
    }
    if (n.role !== 'control-plane') wi++;
    Object.assign(node, { ip: n.ip, podCIDR: n.podCIDR, ready: n.ready });
  }
  // Pods
  const live = new Set();
  for (const p of data.pods) {
    const kind = podKind(p);
    if (kind === 'sys' && !SYS_SHOW[p.app]) continue;
    if (!p.node || !nodes.has(p.node) || p.phase === 'Completed') continue; // los Jobs terminados no se muestran
    live.add(p.name);
    let pod = pods.get(p.name);
    if (!pod) {
      const r = podRadius(kind);
      const k = [...pods.values()].filter((q) => q.node === p.node && !q.gone).length;
      const a = k * 2.4, d = 30 + 52 * Math.sqrt(k);
      pod = { ...p, kind, r, lx: Math.cos(a) * d, ly: 18 + Math.sin(a) * d, vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), born: performance.now(), el: null };
      pods.set(p.name, pod);
      drawPod(pod);
    }
    Object.assign(pod, { phase: p.phase, ready: p.ready, ip: p.ip, restarts: p.restarts, gone: false });
    stylePod(pod);
  }
  for (const pod of pods.values()) {
    if (!live.has(pod.name) && !pod.gone) { pod.gone = true; pod.goneAt = performance.now(); stylePod(pod); }
  }
  // Services: uno por aplicación que tenga pods
  for (const app of SVC_APPS) {
    const has = [...pods.values()].some((p) => p.app === app && !p.gone);
    let s = svcs.get(app);
    if (has && !s) {
      const i = svcs.size;
      s = { app, x: 660 + rand(-10, 10), y: 230 + i * 100, hx: 660, hy: 230 + i * 100, phase: rand(0, 6.28) };
      svcs.set(app, s);
      drawSvc(s);
    } else if (!has && s) {
      s.el.remove(); s.links.forEach((l) => l.remove()); svcs.delete(app);
    }
  }
  // Reubica los Services en una columna entre el control-plane y los workers
  [...svcs.values()].forEach((s, i, all) => { s.hy = 540 + (i - (all.length - 1) / 2) * 96; s.hx = 585; });
  // Solo se reacomoda un nodo cuando cambian sus pods: hacerlo en cada consulta los hace saltar
  for (const n of nodes.values()) {
    n.r = nodeRadius(n);
    const key = [...pods.values()].filter((p) => p.node === n.name && !p.gone).map((p) => p.name).sort().join(',');
    if (key !== n.podKey) { n.podKey = key; settle(n); }
  }
}

// Separa de entrada los pods que se superponen, sin esperar a la animación
// Borde superior permitido: el CIDR termina en -r + 90; se deja aire debajo
const headFloor = (n, p) => -n.r + 104 + p.r;

function settle(n) {
  const list = [...pods.values()].filter((p) => p.node === n.name && !p.gone);
  for (let it = 0; it < 80; it++) {
    for (const p of list) for (const q of list) {
      if (p === q) continue;
      const dx = p.lx - q.lx, dy = p.ly - q.ly;
      const d = Math.hypot(dx, dy) || 0.01;
      const min = p.r + q.r + 14;
      if (d < min) { p.lx += (dx / d) * (min - d) * 0.5; p.ly += (dy / d) * (min - d) * 0.5; }
    }
    const lim = n.r - 70;
    for (const p of list) {
      const dx = p.lx, dy = p.ly - 42, d = Math.hypot(dx, dy);
      const max = lim - p.r;
      if (d > max) { p.lx = (dx / d) * max; p.ly = 42 + (dy / d) * max; }
      p.ly = Math.max(p.ly, headFloor(n, p));
    }
  }
}

/* ===========================================
   ESPACIO DEL CLÚSTER · dibujo
   =========================================== */
function drawNode(n) {
  const g = svgEl('g', { class: 'n-node' }, layer('l-nodes'));
  n.shell = svgEl('circle', { class: `n-shell ${n.role === 'control-plane' ? 'cp' : ''}`, r: 200 }, g);
  n.label = svgEl('text', { class: 'n-name', 'text-anchor': 'middle' }, g);
  n.label.textContent = n.name.replace('the-store-', '');
  n.meta = svgEl('text', { class: 'n-meta', 'text-anchor': 'middle' }, g);
  n.cidr = svgEl('text', { class: 'n-meta', 'text-anchor': 'middle' }, g);
  n.kub = svgEl('rect', { class: 'n-kubelet', width: 14, height: 14 }, g);
  n.kubL = svgEl('text', { class: 'n-kubelet-l' }, g);
  n.kubL.textContent = 'KUBELET';
  n.el = g;
  g.addEventListener('click', (e) => { if (e.target === n.shell) focusOn(n.x, n.y, 1.5); });
}

function drawPod(p) {
  const g = svgEl('g', { class: `pod ${p.kind}` }, layer('l-pods'));
  p.ring = svgEl('circle', { class: 'p-ring', r: p.r + 8 }, g);
  p.circle = svgEl('circle', { class: 'p-circle', r: p.r }, g);
  p.label = svgEl('text', { class: 'p-label', y: p.kind === 'sys' ? 4 : 2 }, g);
  p.label.textContent = p.kind === 'sys' ? SYS_SHOW[p.app] : SHORT[p.app] || p.app;
  // Si el nombre no entra en el círculo, se comprime al ancho disponible
  const room = p.r * 1.7;
  if (p.label.textContent.length * (p.kind === 'sys' ? 7 : 9.5) > room) p.label.setAttribute('textLength', room), p.label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  if (p.kind !== 'sys') {
    p.sub = svgEl('text', { class: 'p-sub', y: 20 }, g);
    p.sub.textContent = p.name.split('-').pop();
  }
  p.badge = svgEl('text', { class: 'p-badge', y: -p.r - 12 }, g);
  p.el = g;
  // Nace en el centro de su nodo, nunca en el origen del mapa
  const n = nodes.get(p.node);
  if (n) g.setAttribute('transform', `translate(${n.x + p.lx},${n.y + p.ly}) scale(0.3)`);
  g.addEventListener('click', (e) => { e.stopPropagation(); openPodMenu(p, e); });
}

function stylePod(p) {
  const cls = ['pod', p.kind];
  const running = p.phase === 'Running' && p.ready;
  if (p.gone || p.phase === 'Terminating' || p.phase === 'Completed') cls.push('gone');
  else if (!running) cls.push('pending');
  const n = errorApps.get(p.app);
  const err = n && !p.gone && p.phase !== 'Terminating' && p.kind !== 'sys';
  if (err) cls.push('err');
  // Un pod que entra en error pasa al frente, para que su etiqueta no quede tapada
  if (err && !p.wasErr) p.el.parentNode?.appendChild(p.el);
  p.wasErr = err;
  if (looked.has(p.name)) cls.push('looked');
  p.el.setAttribute('class', cls.join(' '));
  p.badge.textContent = n && !p.gone && p.kind !== 'sys' ? `${n} ${n === 1 ? 'error' : 'errores'}` : '';
}
const restyleAll = () => pods.forEach(stylePod);

function drawSvc(s) {
  const g = svgEl('g', { class: 'svc' }, layer('l-svcs'));
  svgEl('rect', { class: 's-shape', x: -15, y: -15, width: 30, height: 30, transform: 'rotate(45)' }, g);
  const t = svgEl('text', { class: 's-label', y: 36 }, g);
  t.textContent = `svc/${s.app}`;
  s.el = g;
  s.links = [];
}

/* ===========================================
   ESPACIO DEL CLÚSTER · física
   Los nodos flotan alrededor de su lugar; los pods rebotan contra el borde
   de su nodo y se separan entre sí; los Services oscilan entre los nodos.
   =========================================== */
function step(now) {
  // Un error en un cuadro no puede detener la animación de todo el mapa
  try { frame(now); } catch (e) { console.error(e); }
  requestAnimationFrame(step);
}

function frame(now) {
  const t = now / 1000;
  for (const n of nodes.values()) {
    const amp = reduceMotion ? 0 : 10;
    n.x = n.home.x + Math.sin(t * 0.5 + n.phase) * amp;
    n.y = n.home.y + Math.cos(t * 0.37 + n.phase * 1.3) * amp;
    n.shell.setAttribute('r', n.r);
    n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    // Dos líneas cortas: el círculo es angosto arriba y una sola línea se salía del borde
    n.label.setAttribute('y', -n.r + 46);
    n.meta.setAttribute('y', -n.r + 68);
    n.meta.textContent = n.ip || '';
    n.cidr.setAttribute('y', -n.r + 86);
    n.cidr.textContent = n.podCIDR ? `pods ${n.podCIDR}` : '';
    const a = Math.PI * 0.78;
    n.kub.setAttribute('x', Math.cos(a) * n.r - 7);
    n.kub.setAttribute('y', Math.sin(a) * n.r - 7);
    n.kubL.setAttribute('x', Math.cos(a) * n.r - 92);
    n.kubL.setAttribute('y', Math.sin(a) * n.r + 26);
  }

  const list = [...pods.values()];
  for (const p of list) {
    const n = nodes.get(p.node);
    if (!n) continue;
    if (!reduceMotion) {
      // Repulsión suave entre pods del mismo nodo
      for (const q of list) {
        if (q === p || q.node !== p.node) continue;
        const dx = p.lx - q.lx, dy = p.ly - q.ly;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = p.r + q.r + 14;
        if (d < min) {
          const f = (min - d) * 0.012;
          p.vx += (dx / d) * f; p.vy += (dy / d) * f;
          p.lx += (dx / d) * (min - d) * 0.08; p.ly += (dy / d) * (min - d) * 0.08;
        }
      }
      p.vx += rand(-0.02, 0.02);
      p.vy += rand(-0.02, 0.02);
      const sp = Math.hypot(p.vx, p.vy);
      const max = 0.55;
      if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }
      p.lx += p.vx;
      p.ly += p.vy;
    }
    // Rebote contra el borde del nodo (deja lugar arriba para el nombre)
    const lim = n.r - p.r - 10;
    const cy = 42;
    const dx = p.lx, dy = p.ly - cy;
    const d = Math.hypot(dx, dy);
    if (d > lim - 30) {
      const nx = dx / d, ny = dy / d;
      const dot = p.vx * nx + p.vy * ny;
      if (dot > 0) { p.vx -= 2 * dot * nx; p.vy -= 2 * dot * ny; }
      p.lx = nx * (lim - 30); p.ly = cy + ny * (lim - 30);
    }
    // Nunca por encima del nombre, la IP y el CIDR del nodo
    const floor = headFloor(n, p);
    if (p.ly < floor) { p.ly = floor; if (p.vy < 0) p.vy = -p.vy; }
    p.x = n.x + p.lx;
    p.y = n.y + p.ly;
    const age = (now - p.born) / 500;
    const s = age < 1 ? 0.3 + 0.7 * (1 - Math.pow(1 - age, 3)) : 1;
    p.el.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) scale(${s.toFixed(3)})`);
    if (p.gone && now - p.goneAt > 2500) { p.el.remove(); pods.delete(p.name); }
  }

  for (const s of svcs.values()) {
    const amp = reduceMotion ? 0 : 8;
    s.x += (s.hx + Math.sin(t * 0.6 + s.phase) * amp - s.x) * 0.05;
    s.y += (s.hy + Math.cos(t * 0.45 + s.phase) * amp - s.y) * 0.05;
    s.el.setAttribute('transform', `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`);
    // Líneas punteadas del Service a sus pods (selector)
    const targets = list.filter((p) => p.app === s.app && !p.gone);
    while (s.links.length < targets.length) s.links.push(svgEl('path', { class: 's-link' }, layer('l-links')));
    while (s.links.length > targets.length) s.links.pop().remove();
    targets.forEach((p, i) => s.links[i].setAttribute('d', edgePath(s, 22, p, p.r + 6)));
  }

  drawLogLinks();
  drawTrails();
  movePulses(now);
  camApply();
}

/* ===========================================
   ESPACIO DEL CLÚSTER · pedidos y logs en movimiento
   =========================================== */
const CLIENT = { x: 120, y: 925 };
let clientEl = null;
function drawClient() {
  const g = svgEl('g', {}, layer('l-svcs'));
  svgEl('rect', { class: 'client-box', x: -54, y: -34, width: 108, height: 68 }, g);
  const t = svgEl('text', { class: 'client-l', y: 7 }, g);
  t.textContent = 'cliente';
  g.setAttribute('transform', `translate(${CLIENT.x},${CLIENT.y})`);
  clientEl = g;
}

// Referencias: 'client', 'svc:app', '#nombre-de-pod' o el nombre de una app
function anchor(ref) {
  if (ref === 'client') return CLIENT;
  if (ref.startsWith('#')) return pods.get(ref.slice(1)) || null;
  if (ref.startsWith('svc:')) return svcs.get(ref.slice(4)) || null;
  const list = [...pods.values()].filter((p) => p.app === ref && !p.gone);
  return list.find((p) => p.phase === 'Running') || list[0] || null;
}

// Cada salto es una lista de referencias: pod → Service → pod
const pulses = [];
function sendPulse(chain, { err = false, cls = '', speed = 0.0024 } = {}) {
  return new Promise((resolve) => {
    if (reduceMotion || document.hidden) return resolve();
    const dot = svgEl('circle', { class: `pulse ${err ? 'err' : ''} ${cls}`, r: cls === 'log' ? 5 : 9 }, layer('l-pulses'));
    const pu = { chain, dot, t0: performance.now(), speed, resolve };
    pulses.push(pu);
    // Si la pestaña deja de dibujar, la compra no queda esperando a la animación
    setTimeout(() => { const i = pulses.indexOf(pu); if (i >= 0) { dot.remove(); pulses.splice(i, 1); resolve(); } }, (chain.length * 0.6) / speed + 800);
  });
}

function movePulses(now) {
  for (let i = pulses.length - 1; i >= 0; i--) {
    const pu = pulses[i];
    const pts = pu.chain.map(anchor);
    if (pts.some((p) => !p)) { pu.dot.remove(); pulses.splice(i, 1); pu.resolve(); continue; }
    const segs = pts.length - 1;
    // now (marca del cuadro) puede ser apenas anterior a t0: el avance nunca es negativo
    const k = Math.max(0, Math.min(1, (now - pu.t0) * pu.speed * (1 / Math.max(1, segs * 0.6))));
    const pos = k * segs;
    const si = Math.min(segs - 1, Math.floor(pos));
    const f = pos - si;
    const a = pts[si], b = pts[si + 1];
    pu.dot.setAttribute('cx', a.x + (b.x - a.x) * f);
    pu.dot.setAttribute('cy', a.y + (b.y - a.y) * f);
    if (k >= 1) { pu.dot.remove(); pulses.splice(i, 1); pu.resolve(); }
  }
}

// Recta entre dos figuras que arranca y termina en sus bordes, no en sus centros
function edgePath(a, ra, b, rb) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  return `M${(a.x + ux * ra).toFixed(1)},${(a.y + uy * ra).toFixed(1)} L${(b.x - ux * rb).toFixed(1)},${(b.y - uy * rb).toFixed(1)}`;
}

function drawTrails() {
  const g = layer('l-links');
  for (const tr of trails) {
    const pts = tr.chain.map(anchor);
    if (pts.some((p) => !p)) { tr.el?.setAttribute('d', ''); continue; }
    if (!tr.el) tr.el = svgEl('path', { class: `trail ${tr.err ? 'err' : ''}` }, g);
    tr.el.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  }
}

function clearTrails() {
  trails.forEach((t) => t.el?.remove());
  trails = [];
}

// Con EFK instalado: líneas de cada Fluentd a Elasticsearch y gotas de logs
let logLinks = [];
function drawLogLinks() {
  const flu = [...pods.values()].filter((p) => p.app === 'fluentd' && !p.gone);
  const es = anchor('svc:elasticsearch');
  while (logLinks.length < flu.length) logLinks.push(svgEl('path', { class: 'l-logs' }, layer('l-links')));
  while (logLinks.length > flu.length) logLinks.pop().remove();
  flu.forEach((f, i) => logLinks[i].setAttribute('d', es ? edgePath(f, f.r + 6, es, 22) : ''));
}

setInterval(() => {
  if (!$('#cluster').classList.contains('active') || document.hidden) return;
  const flu = [...pods.values()].filter((p) => p.app === 'fluentd' && !p.gone && p.phase === 'Running');
  if (!flu.length || !svcs.has('elasticsearch')) return;
  const sources = [...pods.values()].filter((p) => (p.kind === 'store' || p.kind === 'ing') && !p.gone);
  const src = sources[Math.floor(Math.random() * sources.length)];
  const f = flu.find((x) => x.node === src?.node);
  if (!src || !f) return;
  // pod → Fluentd de su nodo → Service → Elasticsearch
  const chain = [`#${src.name}`, `#${f.name}`, 'svc:elasticsearch', 'elasticsearch'];
  sendPulse(chain, { cls: 'log', speed: 0.0011 });
}, 450);

/* ===========================================
   ESPACIO DEL CLÚSTER · cámara (arrastrar, zoom, centrar)
   =========================================== */
const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 };
function camApply() {
  cam.x += (cam.tx - cam.x) * 0.15;
  cam.y += (cam.ty - cam.y) * 0.15;
  cam.k += (cam.tk - cam.k) * 0.15;
  layer('cam').setAttribute('transform', `translate(${cam.x.toFixed(2)},${cam.y.toFixed(2)}) scale(${cam.k.toFixed(4)})`);
}
function focusOn(x, y, k) {
  cam.tk = k;
  cam.tx = WORLD.w / 2 - x * k;
  cam.ty = WORLD.h / 2 - y * k;
}
const camHome = () => { cam.tx = 0; cam.ty = 0; cam.tk = 1; };
// El mapa no se puede arrastrar fuera de su área: siempre queda algún nodo a la vista
function clampCam() {
  const k = cam.tk, m = 300;
  cam.tx = Math.min(m, Math.max(WORLD.w * (1 - k) - m, cam.tx));
  cam.ty = Math.min(m, Math.max(WORLD.h * (1 - k) - m, cam.ty));
}

(function setupCamera() {
  const world = $('#world');
  let drag = null;
  world.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pod')) return;
    drag = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty, moved: false };
    world.setPointerCapture(e.pointerId);
    world.classList.add('dragging');
  });
  world.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / stageScale, dy = (e.clientY - drag.y) / stageScale;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    cam.tx = cam.x = drag.tx + dx;
    cam.ty = cam.y = drag.ty + dy;
    clampCam();
  });
  world.addEventListener('pointerup', () => { drag = null; world.classList.remove('dragging'); });
  world.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toLocal(world, e.clientX, e.clientY);
    const k = Math.max(0.8, Math.min(2.4, cam.tk * Math.exp(-e.deltaY * 0.0015)));
    // Zoom alrededor del cursor
    const wx = (p.x - cam.tx) / cam.tk, wy = (p.y - cam.ty) / cam.tk;
    cam.tk = k;
    cam.tx = p.x - wx * k;
    cam.ty = p.y - wy * k;
    clampCam();
  }, { passive: false });
  world.addEventListener('dblclick', camHome);
  // Botones de zoom: acercan o alejan alrededor del centro de lo que se ve
  const zoomBy = (f) => {
    const k = Math.max(0.8, Math.min(2.4, cam.tk * f));
    const wx = (WORLD.w / 2 - cam.tx) / cam.tk, wy = (WORLD.h / 2 - cam.ty) / cam.tk;
    cam.tk = k;
    cam.tx = WORLD.w / 2 - wx * k;
    cam.ty = WORLD.h / 2 - wy * k;
    clampCam();
  };
  $('#zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  $('#zoom-home').addEventListener('click', camHome);
})();

/* ===========================================
   ESPACIO DEL CLÚSTER · menú de cada pod
   =========================================== */
function openPodMenu(p, e) {
  const pop = $('#popover');
  const items = [
    ['Ver logs', `kubectl -n ${p.ns} logs ${p.name} --tail=20`],
    ['Describir pod', `kubectl -n ${p.ns} describe pod ${p.name} | tail -20`],
  ];
  if (p.ns === 'the-store') items.push(['Eliminar pod', `kubectl -n ${p.ns} delete pod ${p.name}`, 'danger']);
  pop.innerHTML = `<span class="ph">${esc(p.ns)}/${esc(p.name)}<br>${esc(LANG[p.app] || '')} · ${esc(p.ip || '')} · ${esc(p.node)}</span>` +
    items.map(([l, , c], i) => `<button data-i="${i}" class="${c || ''}">${l}</button>`).join('');
  const pt = toLocal($('#space'), e.clientX, e.clientY);
  pop.style.left = `${Math.min(pt.x + 12, 1360 - 320)}px`;
  pop.style.top = `${Math.min(pt.y + 12, 1080 - 200)}px`;
  pop.hidden = false;
  pop.onclick = (ev) => {
    const i = ev.target.dataset.i;
    if (i === undefined) return;
    pop.hidden = true;
    const [label, cmd] = items[i];
    if (label === 'Ver logs') { looked.add(p.name); stylePod(p); }
    openTerm({
      title: `${p.app} · ${label.toLowerCase()}`,
      cmd,
      onExit: label === 'Eliminar pod' ? () => { marks.deletedPod = { name: p.name, at: Date.now() }; } : undefined,
    });
  };
}
document.addEventListener('pointerdown', (e) => {
  const pop = $('#popover');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.pod')) pop.hidden = true;
});

/* ===========================================
   ESTADO DEL CLÚSTER
   =========================================== */
let sceneWatch = null;
async function poll() {
  try {
    const r = await api('/api/state');
    const s = await r.json();
    if (!s.ok) return showSpaceMsg(`No se pudo leer el clúster.\n${s.error}`);
    showSpaceMsg(null);
    reconcile(s);
    sceneWatch?.(s);
  } catch (e) {
    showSpaceMsg(`El servidor local no responde (${e.message}).`);
  }
}
function showSpaceMsg(text) {
  const m = $('#space-msg');
  m.hidden = !text;
  if (text) m.textContent = text;
}

/* ===========================================
   COMPRA REAL CONTRA LA TIENDA
   =========================================== */
// Qué servicios toca cada paso (según el código de ui y checkout), pasando por los Services
const IN = ['client', 'ingress-nginx', 'svc:ui', 'ui'];
const call = (from, to) => [from, `svc:${to}`, to];
const HOPS = {
  home: [IN, call('ui', 'catalog')],
  product: [IN, call('ui', 'catalog')],
  add: [IN, call('ui', 'catalog'), call('ui', 'carts')],
  cart: [IN, call('ui', 'carts'), call('ui', 'catalog')],
  checkout: [IN, call('ui', 'carts'), call('ui', 'checkout')],
  shipping: [IN, call('ui', 'checkout')],
  delivery: [IN, call('ui', 'checkout')],
  payment: [IN, call('ui', 'checkout'), call('checkout', 'orders'), call('ui', 'carts')],
};

let buying = false;
async function simulatePurchase() {
  if (buying) return;
  buying = true;
  showDock(false);
  clearTrails();
  const list = $('#receipt-list');
  list.innerHTML = '';
  $('#receipt').hidden = false;
  $('#client-state').textContent = 'comprando…';
  const rows = {};
  let started = Date.now();
  let failed = null;
  try {
    const r = await api('/api/purchase', { method: 'POST' });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let anim = Promise.resolve();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (ev.type === 'start') started = new Date(ev.at).getTime();
        if (ev.type === 'step') {
          const li = document.createElement('li');
          li.className = 'wait';
          li.innerHTML = `<span>${esc(ev.label)}</span><span class="st">…</span>`;
          list.appendChild(li);
          rows[ev.id] = li;
          const hops = HOPS[ev.id] || [];
          anim = anim.then(async () => { for (const h of hops) await sendPulse(h); });
        }
        if (ev.type === 'result') {
          await anim;
          const bad = !ev.status || ev.status >= 400;
          rows[ev.id].className = bad ? 'err' : 'ok';
          rows[ev.id].querySelector('.st').textContent = ev.status ? `${ev.status} · ${ev.ms} ms` : 'sin respuesta';
          for (const h of HOPS[ev.id] || []) trails.push({ chain: h, err: bad });
          if (bad) failed = ev;
        }
      }
    }
  } catch (e) {
    $('#client-state').textContent = `error: ${e.message}`;
  }
  buying = false;
  $('#client-state').textContent = failed ? 'la compra falló' : 'compra confirmada';
  if (failed) marks.failedPurchase = { from: started, to: Date.now() };
  await markErrors(Math.ceil((Date.now() - started) / 1000) + 5);
  return failed;
}

async function markErrors(since = 60) {
  const r = await api(`/api/errors?since=${since}`);
  const counts = await r.json();
  for (const [app, n] of Object.entries(counts)) if (n > 0) errorApps.set(app, n);
  restyleAll();
}

function clearMarks() {
  errorApps.clear();
  looked.clear();
  clearTrails();
  $('#receipt').hidden = true;
  restyleAll();
}

/* ===========================================
   KIBANA (por el proxy local, sin iniciar sesión)
   =========================================== */
const rison = (s) => `'${String(s).replace(/!/g, '!!').replace(/'/g, "!'")}'`;
function discoverUrl(query, from = 'now-15m', to = 'now') {
  const g = `(refreshInterval:(pause:!t,value:60000),time:(from:${rison(from)},to:${rison(to)}))`;
  const a = `(columns:!(app,level,kubernetes.pod_name,message),dataSource:(dataViewId:k8s-logs,type:dataView),query:(language:kuery,query:${rison(query)}),sort:!(!('@timestamp',desc)))`;
  return `/app/discover#/?_g=${encodeURIComponent(g)}&_a=${encodeURIComponent(a)}`;
}
const KB = {
  discover: () => discoverUrl(''),
  dashboard: () => '/app/dashboards#/view/the-store-logs?_g=(time:(from:now-30m,to:now),refreshInterval:(pause:!f,value:10000))',
  ilm: () => '/app/management/data/index_lifecycle_management/policies',
  indices: () => '/app/management/data/index_management/indices',
  devtools: () => '/app/dev_tools#/console',
};
const KB_LINKS = [['Discover', 'discover'], ['Dashboard', 'dashboard'], ['Retención', 'ilm'], ['Índices', 'indices'], ['Dev Tools', 'devtools']];

function openKibana(path, label = '') {
  $('#kb-frame').src = KIBANA + path;
  $('#kb-where').textContent = label;
  $('#kibana').hidden = false;
}
const closeKibana = () => { $('#kibana').hidden = true; };

$('#kb-links').innerHTML = KB_LINKS.map(([l, k]) => `<button class="chip" data-k="${k}">${l}</button>`).join('');
$('#kb-links').addEventListener('click', (e) => { const k = e.target.dataset.k; if (k) openKibana(KB[k](), e.target.textContent); });
$('#kb-close').addEventListener('click', closeKibana);
// Zoom de Kibana, de 80 % a 200 %
let kbZoom = 1;
const setKbZoom = (z) => {
  kbZoom = Math.round(Math.min(2, Math.max(0.8, z)) * 10) / 10;
  $('.kb-view').style.setProperty('--kz', kbZoom);
  $('#kb-zoom-v').textContent = `${Math.round(kbZoom * 100)}%`;
};
$('#kb-zoom-in').addEventListener('click', () => setKbZoom(kbZoom + 0.1));
$('#kb-zoom-out').addEventListener('click', () => setKbZoom(kbZoom - 0.1));
$('#btn-kibana').addEventListener('click', () => ($('#kibana').hidden ? openKibana(KB.discover(), 'Discover') : closeKibana()));
// Tráfico de fondo: pedidos periódicos a la tienda para que el tablero tenga datos
const setTraffic = (on) => api('/api/traffic', { method: 'POST', body: JSON.stringify({ on }) });

/* ===========================================
   ESCENAS Y NAVEGACIÓN
   =========================================== */
// Atajos que usa scenes.js para declarar las acciones de cada escena
const term = (label, title, cmd, extra = {}) => ({ label, cmd, show: extra.show, run: () => openTerm({ title, cmd: typeof cmd === 'function' ? cmd() : cmd, ...extra }) });
const doit = (label, fn, primary = false) => ({ label, run: fn, primary });
const kb = (label, pathFn, where) => ({ label, kibana: true, run: () => openKibana(pathFn(), where) });

let SCENES = [];
let idx = 0;

function showScene(i) {
  idx = Math.max(0, Math.min(SCENES.length - 1, i));
  const s = SCENES[idx];
  $('#popover').hidden = true;
  $('#pos').textContent = `${String(idx + 1).padStart(2, '0')} / ${SCENES.length}`;
  $('#notes-body').innerHTML = `<ul>${(s.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  sceneWatch = null;
  saveMarks();
  try { history.replaceState(null, '', `#${idx + 1}`); } catch {}

  const slide = $('#slide'), cluster = $('#cluster');
  if (s.kind === 'slide') {
    cluster.classList.remove('active', 'visible');
    slide.className = `slide ${s.cls || ''}`;
    slide.innerHTML = s.html;
    slide.classList.add('active');
    placeBody(slide);
    requestAnimationFrame(() => requestAnimationFrame(() => slide.classList.add('visible')));
    return;
  }

  slide.classList.remove('active', 'visible');
  cluster.classList.add('active', 'visible');
  closeKibana();
  $('#cl-eyebrow').textContent = s.eyebrow;
  $('#cl-h').textContent = s.title;
  $('#cl-text').textContent = s.text;
  countCommands = Boolean(s.counter);
  $('#counter').hidden = !s.counter;
  if (s.counter) { commandCount = 0; $('#counter-n').textContent = '0'; }
  // Kibana solo aparece en las escenas de la demo que lo usan
  $('#btn-kibana').hidden = !(s.actions || []).some((a) => a.kibana);
  const box = $('#cl-actions');
  box.innerHTML = '';
  const items = [];
  // Se resalta el primer paso que falta hacer; al hacerlo, el resaltado pasa al siguiente
  const highlight = () => {
    const next = items.find((li) => !li.classList.contains('done'));
    items.forEach((li) => li.classList.toggle('primary', li === next));
    fitBrief();
  };
  for (const a of s.actions || []) {
    const li = document.createElement('li');
    const cmd = a.show || (typeof a.cmd === 'string' ? a.cmd : '');
    li.innerHTML = `<button><b>${esc(a.label)}</b>${cmd ? `<code>${esc(cmd)}</code>` : ''}</button>`;
    li.firstChild.addEventListener('click', () => { li.classList.add('done'); highlight(); a.run(); });
    box.appendChild(li);
    items.push(li);
  }
  highlight();
  if (s.focus) focusOn(...s.focus); else camHome();
  s.onEnter?.();
  poll();
}

// El cuerpo va debajo del título a distancia fija; así el aire queda abajo y lejos de los controles
function placeBody(slide) {
  const head = slide.querySelector('.s-head'), body = slide.querySelector('.s-body'), foot = slide.querySelector('.s-foot');
  if (!head || !body) return;
  const H = slide.offsetHeight, headEnd = head.offsetTop + head.offsetHeight;
  const footH = foot ? foot.offsetHeight + 48 : 0;
  const top = Math.max(headEnd + 56, Math.min(headEnd + 104, H - 200 - footH - body.offsetHeight));
  Object.assign(body.style, { top: `${top}px`, bottom: 'auto' });
  if (foot) Object.assign(foot.style, { top: `${top + body.offsetHeight + 48}px`, bottom: 'auto' });
}

// Si el contenido invade el margen inferior (80 px de padding), la columna se compacta en escalones
const FIT_LEVELS = ['fit-1', 'fit-2', 'fit-3'];
function fitBrief() {
  const brief = $('.brief');
  brief.classList.remove(...FIT_LEVELS);
  const last = () => [...brief.children].filter((el) => !el.hidden).pop();
  const room = () => brief.clientHeight - 80 - (last().offsetTop + last().offsetHeight);
  for (const lvl of FIT_LEVELS) {
    if (room() >= 0) return;
    brief.classList.add(lvl);
  }
}

function boot(scenes) {
  SCENES = scenes;
  drawClient();
  requestAnimationFrame(step);
  showScene((Number(location.hash.slice(1)) || 1) - 1);
  // Con las fuentes cargadas cambian las alturas: se vuelve a medir
  document.fonts.ready.then(() => { placeBody($('#slide')); fitBrief(); });
}

$('#prev').addEventListener('click', () => showScene(idx - 1));
$('#next').addEventListener('click', () => showScene(idx + 1));

document.addEventListener('keydown', (e) => {
  // Esc dentro de la terminal la cierra y devuelve el control a la presentación
  if (e.target.closest('input, textarea, [contenteditable]')) {
    if (e.key === 'Escape') { e.target.blur(); if (e.target.closest('#dock')) showDock(false); }
    return;
  }
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); showScene(idx + 1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); showScene(idx - 1); }
  else if (e.key === 'n' || e.key === 'N') $('#notes').hidden = !$('#notes').hidden;
  else if (e.key === 'Escape') {
    const open = !$('#popover').hidden || !$('#kibana').hidden || !$('#dock').hidden;
    $('#popover').hidden = true; closeKibana(); showDock(false);
    if (!open) clearMarks();
  }
  else if (e.key === '`') showDock($('#dock').hidden && terms.length > 0);
});

// Teclas que reenvía Kibana desde el iframe (ver DECK_KEYS_JS en server.mjs)
addEventListener('message', (e) => {
  if (e.origin !== KIBANA || !e.data?.deckKey) return;
  const k = e.data.deckKey;
  if (k === 'Escape') { closeKibana(); $('#kb-frame').blur(); }
  else if (k === 'ArrowRight' || k === 'PageDown') showScene(idx + 1);
  else if (k === 'ArrowLeft' || k === 'PageUp') showScene(idx - 1);
});

// El mapa se actualiza cada dos segundos mientras está a la vista
setInterval(() => { if ($('#cluster').classList.contains('active')) poll(); }, 2000);
