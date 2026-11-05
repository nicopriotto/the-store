// Contenido de la presentación: una escena por entrada. "slide" es una diapositiva
// común; "cluster" muestra el espacio del clúster con acciones a la izquierda.
// Las diapositivas son de baja densidad: quien presenta cuenta el resto.
'use strict';

// Diapositiva estándar: marca roja, rótulo, título arriba y cuerpo abajo
function S({ eyebrow, title, lead = '', body = '', foot = '' }) {
  return `
    <span class="mark reveal"></span>
    <span class="eyebrow s-eyebrow reveal">${eyebrow}</span>
    <div class="s-head">
      <h2 class="reveal d1">${title}</h2>
      ${lead ? `<p class="s-lead reveal d2">${lead}</p>` : ''}
    </div>
    ${body ? `<div class="s-body reveal d3 ${foot ? 'has-foot' : ''}">${body}</div>` : ''}
    ${foot ? `<p class="s-foot reveal d4">${foot}</p>` : ''}`;
}
const col = (k, h, p, red = false) => `<div class="col ${red ? 'red' : ''}"><span class="k">${k}</span>${h ? `<h3>${h}</h3>` : ''}${p ? `<p>${p}</p>` : ''}</div>`;
const cols = (n, ...c) => `<div class="cols" style="--n:${n}">${c.join('')}</div>`;

const trafficOn = () => setTraffic(true);
const lastPodOf = (app) => [...pods.values()].find((p) => p.app === app && !p.gone)?.name;
// Logs de un pod puntual, como haría un operador: un comando por pod
const podLogs = (label, app, ns = 'the-store') =>
  term(label, `${app} · logs`, () => `kubectl -n ${ns} logs ${lastPodOf(app) || `deploy/${app}`} --tail=15`, { show: `kubectl -n ${ns} logs <pod de ${app}>` });

boot([
  /* ---------------- Carátula ---------------- */
  {
    kind: 'slide', cls: 'cover',
    html: `
      <span class="mark reveal"></span>
      <span class="eyebrow reveal">Redes de Información · ITBA · TPE Tema 4</span>
      <h1 class="reveal d1">Gestión centralizada de <em>logs</em></h1>
      <p class="sub reveal d2">Elasticsearch, Fluentd y Kibana sobre The Store, en un clúster de Kubernetes.</p>
      <div class="podlist reveal d3"><div><i></i>ui</div><div><i></i>catalog</div><div><i></i>carts</div><div class="err"><i></i>checkout · 500</div><div><i></i>orders</div></div>
      <div class="people reveal d4"><div>Juan Ignacio Lategana<span>64476</span></div><div>Nicolás Priotto<span>64663</span></div><div>Agustín Tomas Romero<span>64268</span></div></div>
      <div class="date reveal d4">GRUPO 1 · NOV 2026</div>`,
    notes: ['Presentarse los tres.', 'Una frase: vamos a mostrar por qué una tienda en Kubernetes necesita sus logs en un solo lugar.'],
  },

  /* ---------------- El problema, en vivo ---------------- */
  {
    kind: 'cluster',
    eyebrow: 'The Store, en vivo', title: 'Así se ve la tienda por dentro',
    text: 'Cinco microservicios en tres lenguajes, sobre un clúster de tres nodos. Cada círculo es un pod real, leído ahora del clúster. Los rombos son los Services que los conectan.',
    actions: [doit('Simular una compra', simulatePurchase, true)],
    notes: [
      'Señalar el control-plane (api-server, etcd, scheduler) y los dos workers. Arrastrar y hacer zoom para mostrar que es navegable.',
      'Simular la compra: son pedidos HTTP reales contra la tienda, los mismos pasos que el load-generator de la cátedra.',
      'El pulso entra por el ingress, pasa por ui y llega a catalog, carts y checkout a través de sus Services.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Un incidente', title: 'Una compra que falla',
    text: 'Hacemos que checkout responda 500. El cliente ya navegó el catálogo y armó su carrito, y la compra se cae al iniciar el checkout.',
    actions: [
      term('Hacer fallar a checkout', 'checkout · chaos', 'curl -s -X POST localhost:8082/chaos/status/500'),
      doit('Simular una compra', simulatePurchase, true),
    ],
    onEnter: () => clearMarks(),
    notes: [
      'checkout está expuesto en el puerto 8082 por un port-forward que mantiene el servidor de la presentación.',
      'Correr el curl (Enter en la terminal) y después simular la compra.',
      'Los pods en rojo son los que registraron errores en el último minuto, leídos de sus logs reales.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Sin una solución', title: '¿Qué pasó con esa compra?',
    text: 'Hoy hay que abrir los logs pod por pod. Cada uno escribe en su propio formato, y si el pod se borra, sus logs se pierden. También se puede hacer clic en cualquier pod.',
    actions: [
      term('Listar los pods', 'kubectl · pods', 'kubectl get pods -n the-store -o wide'),
      podLogs('Logs de ui · JSON de Java', 'ui'),
      podLogs('Logs de checkout · texto de NestJS', 'checkout'),
      podLogs('Logs del ingress · otro JSON', 'ingress-nginx', 'ingress-nginx'),
      term('Restablecer checkout', 'checkout · chaos', 'curl -s -X DELETE localhost:8082/chaos/status'),
    ],
    counter: true,
    notes: [
      'Seguir los pasos de la izquierda: cada uno abre la terminal con el comando listo; Enter lo ejecuta. El contador cuenta los comandos.',
      'Remarcar: ui es JSON, checkout es texto de NestJS, el ingress es otro JSON. Hay que juntar las piezas a mano.',
      'Al final restablecer checkout.',
    ],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'El problema',
      title: 'Los logs existen, pero <em>no sirven</em> para investigar',
      body: cols(3,
        col('Efímeros', 'Se pierden con el pod', 'Cada contenedor escribe en el disco de su nodo. Si el pod se borra, sus logs desaparecen.', true),
        col('Dispersos', 'Uno por uno', '<code>kubectl logs</code> muestra un pod por vez, sin filtros. Una compra cruza cinco servicios.', true),
        col('Heterogéneos', 'Cada uno en su idioma', 'Java, Go y TypeScript escriben en formatos distintos, sin un campo común de nivel.', true)),
      foot: 'Con cinco servicios es incómodo. Con cincuenta, imposible.',
    }),
    notes: ['Volver sobre lo que se vio: cada comando fue a un pod distinto y cada salida tenía otro formato.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'El problema · un ejemplo de cada formato',
      title: 'Cuatro formatos, <em>ningún campo en común</em>',
      body: `<div class="raw">
        <div><span class="src">catalog<span>Go · texto de Gin</span></span><span class="ln">[GIN] 2026/11/04 - 20:14:22 | <b>500</b> | 5.77ms | 10.244.2.7 | GET "/catalog/products"</span></div>
        <div><span class="src">ui, carts, orders<span>Java · JSON ECS</span></span><span class="ln">{"@timestamp":"2026-11-04T20:19:05Z","log":{"level":"<b>ERROR</b>","logger":"…"},…}</span></div>
        <div><span class="src">checkout<span>NestJS · texto de Nest</span></span><span class="ln">[Nest] 1 - 11/04/2026, 8:19:05 PM LOG [HTTP] POST /checkout/…/update <b>500</b> 1.6ms</span></div>
        <div><span class="src">ingress-nginx<span>JSON propio</span></span><span class="ln">{"time":"2026-11-04T20:14:22+00:00","method":"GET","path":"/catalog","status_code":<b>500</b>,…}</span></div>
      </div>`,
    }),
    notes: ['Un ejemplo de cada formato que escribe la tienda. El error aparece distinto en cada uno: un 500 entre barras, un ERROR anidado en JSON, un 500 suelto en texto.', 'No hay un campo común de servicio ni de nivel: para cruzarlos hay que leerlos a mano.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'La solución',
      title: 'Sacar los logs de los nodos y llevarlos a <em>un solo lugar</em>',
      lead: 'Cinco tareas, sin modificar el código de ningún servicio.',
      body: `<div class="pipe">
        <div><span class="n">01</span><b>Recolectar</b><span>leer los logs de cada nodo apenas se escriben</span><span class="who">Fluentd</span></div>
        <div><span class="n">02</span><b>Transformar</b><span>llevarlos a un formato común</span><span class="who">Fluentd</span></div>
        <div><span class="n">03</span><b>Almacenar</b><span>guardarlos fuera de los pods</span><span class="who">Elasticsearch</span></div>
        <div><span class="n">04</span><b>Consultar</b><span>buscar, filtrar y graficar</span><span class="who">Kibana</span></div>
        <div><span class="n">05</span><b>Retener</b><span>borrar lo viejo solo</span><span class="who">Elasticsearch</span></div>
      </div>`,
    }),
    notes: [
      'En una empresa, el equipo de plataforma no controla el código de cada equipo: la solución se adapta a lo que ya existe.',
      'Herramientas de código abierto, sin costo de licencia.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Despliegue', title: 'Implementar EFK',
    text: 'Un solo comando instala el stack en un namespace propio, logging. La aplicación no se toca. Mientras se despliega, vemos qué es cada pieza.',
    actions: [
      { ...term('Implementar EFK', 'efk · instalación', './local.sh install-logging', { run: true, onExit: (r) => { marks.efkInstalled = r.ended; } }), primary: true },
    ],
    notes: [
      'Ejecutar y avanzar a las diapositivas sin esperar: la instalación tarda un par de minutos.',
      'Van a aparecer pods negros: un Fluentd por nodo, Elasticsearch y Kibana.',
    ],
  },

  /* ---------------- La tecnología ---------------- */
  {
    kind: 'slide',
    html: S({
      eyebrow: 'La tecnología',
      title: 'Tres herramientas, <em>un recorrido</em>',
      body: `<div class="diagram"><svg viewBox="0 0 1600 330" role="img" aria-label="Los pods escriben al disco del nodo, Fluentd lo lee y lo envía a Elasticsearch, Kibana consulta a Elasticsearch">
          <rect class="zone" x="0" y="0" width="690" height="330"></rect>
          <text class="m" x="24" y="38">CADA NODO DEL CLÚSTER</text>
          <circle class="b" cx="110" cy="130" r="56"></circle><text class="c" x="110" y="138">pods</text>
          <rect class="b" x="30" y="232" width="250" height="64"></rect><text x="48" y="262">/var/log/containers</text><text class="m" x="48" y="284">disco del nodo</text>
          <circle class="efk" cx="540" cy="165" r="100"></circle><text class="t c" x="540" y="162">Fluentd</text><text class="mw c" x="540" y="194">1 por nodo</text>
          <circle class="efk" cx="1000" cy="165" r="140"></circle><text class="t c" x="1000" y="162">Elasticsearch</text><text class="mw c" x="1000" y="194">disco 5 GiB</text>
          <circle class="efk" cx="1460" cy="165" r="100"></circle><text class="t c" x="1460" y="162">Kibana</text><text class="mw c" x="1460" y="194">navegador</text>
          <path d="M110,186 L110,232"></path><text class="m" x="124" y="214">stdout</text>
          <path d="M280,264 C360,264 390,215 445,195"></path><text class="m" x="300" y="306">lee y parsea</text>
          <path d="M640,165 L860,165"></path><text class="m" x="712" y="150">Bulk API</text>
          <path class="q" d="M1360,165 L1140,165"></path><text class="m" x="1196" y="150">consultas</text>
        </svg></div>`,
    }),
    notes: ['Presentar el recorrido completo antes de entrar en cada pieza. F recolecta, E almacena, K muestra.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Fluentd',
      title: 'Un recolector <em>en cada nodo</em>',
      lead: 'Kubernetes guarda los logs de cada pod en el disco de su nodo. Un DaemonSet corre un Fluentd en cada nodo, y si el clúster suma un nodo, Kubernetes le crea el suyo.',
      body: `<div class="chain"><span>tail</span><i>→</i><span>concat</span><i>→</i><span>kubernetes_metadata</span><i>→</i><span class="r">parser</span><i>→</i><span class="r">record_transformer</span><i>→</i><span>elasticsearch</span></div>`,
      foot: 'Cada log pasa por una cadena de plugins que se configuran en un archivo, sin programar.',
    }),
    notes: ['tail lee los archivos a medida que crecen. concat une las líneas que containerd partió. kubernetes_metadata consulta a Kubernetes y agrega pod, nodo y namespace.', 'parser lee cada formato (JSON o expresión regular) y record_transformer agrega app y level. Son los dos en rojo, los que normalizan.', 'elasticsearch envía por lotes, con buffer en disco y reintentos.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Fluentd · normalización',
      title: 'Un solo <em>esquema</em>',
      lead: 'Cada formato tiene su parser. Todos los logs terminan con los mismos campos, <code>app</code> (el servicio) y <code>level</code>, más el pod, el nodo y el namespace de origen.',
      body: `<table>
        <thead><tr><th>Servicio</th><th>Escribe</th><th>Fluentd lo lee con</th><th>De dónde sale el level</th></tr></thead>
        <tbody>
          <tr><td><b>ui, carts, orders</b></td><td>JSON de Java</td><td>parser JSON</td><td>del campo <code>log.level</code></td></tr>
          <tr><td><b>catalog</b></td><td>texto de Gin</td><td>expresión regular</td><td><code>ERROR</code> si el estado HTTP es 5xx</td></tr>
          <tr><td><b>checkout</b></td><td>texto de NestJS</td><td>expresión regular</td><td>del nivel que escribe Nest</td></tr>
          <tr><td><b>ingress-nginx</b></td><td>JSON propio</td><td>parser JSON</td><td><code>ERROR</code> si el estado HTTP es 5xx</td></tr>
        </tbody></table>`,
    }),
    notes: ['Este es el caso que pidió la cátedra; después lo vemos en vivo.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Fluentd · confiabilidad',
      title: 'Si Elasticsearch se cae, <em>no se pierde nada</em>',
      body: cols(3,
        col('pos_file', 'Recuerda dónde quedó', 'Fluentd anota hasta qué byte leyó cada archivo. Si se reinicia, sigue desde ahí.'),
        col('buffer en disco', 'Guarda lo pendiente', 'Lo que no pudo enviar queda en el disco del nodo, hasta 512 MB.'),
        col('reintentos', 'Espera creciente', 'Reintenta sin límite de intentos, con esperas que crecen hasta 30 segundos.')),
      foot: 'Algún evento puede llegar dos veces, pero ninguno se pierde (garantía at-least-once).',
    }),
    notes: ['Esto se demuestra más adelante apagando Elasticsearch.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Elasticsearch',
      title: 'Un almacén <em>pensado para buscar</em>',
      body: cols(3,
        col('Índice invertido', 'Busca por palabra', 'Para cada palabra guarda en qué documentos aparece, sin recorrer los logs uno por uno.'),
        col('Un índice por día', '<code>k8s-logs-AAAA.MM.DD</code>', 'Cada log es un documento JSON dentro del índice de su día.'),
        col('Retención', 'ILM a 7 días', 'ILM (Index Lifecycle Management) es la gestión del ciclo de vida de los índices. Una política borra cada índice cuando cumple siete días.', true)),
    }),
    notes: ['Usamos un solo shard sin réplicas. Si preguntan por alta disponibilidad, en producción serían al menos tres nodos con réplicas.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Elasticsearch · operación',
      title: 'Persistente y <em>cerrado</em>',
      body: cols(3,
        col('Persistencia', 'StatefulSet', 'Un volumen de 5 GiB que sobrevive al pod.'),
        col('Autenticación', 'Usuario propio', 'Fluentd solo puede escribir en <code>k8s-logs-*</code>.'),
        col('NetworkPolicies', 'Puerta cerrada', 'Solo Fluentd, Kibana y el Job de configuración llegan a Elasticsearch.', true)),
    }),
    notes: ['La NetworkPolicy se prueba al final si sobra tiempo.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Kibana',
      title: 'La ventana para <em>operaciones</em>',
      lead: 'Kibana no guarda logs. Consulta a Elasticsearch y muestra los resultados en el navegador.',
      body: cols(3,
        col('Discover', 'Buscar', 'Consultas KQL sobre cualquier campo y rango.<br><code>app : "catalog" and level : "ERROR"</code>'),
        col('Dashboards', 'Ver de un vistazo', 'Volumen, errores por servicio y códigos HTTP. Se carga solo al instalar.'),
        col('Gestión', 'Administrar', 'Retención, índices y una consola directa a Elasticsearch.')),
    }),
    notes: ['Después de esta diapositiva, volver al clúster: la instalación ya debería haber terminado.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Alternativas consideradas',
      title: 'Por qué <em>EFK</em>',
      body: `<table>
        <thead><tr><th>Opción</th><th>En lugar de</th><th>A favor</th><th>En contra</th></tr></thead>
        <tbody>
          <tr><td><b>Logstash</b> (ELK)</td><td>Fluentd</td><td>el procesador más potente</td><td>como agente por nodo es una JVM de cerca de 1 GB</td></tr>
          <tr><td><b>Filebeat</b> (Beats)</td><td>Fluentd</td><td>agente liviano en Go</td><td>solo recolecta y deja el procesamiento a otra pieza</td></tr>
          <tr><td><b>OpenSearch</b></td><td>Elasticsearch y Kibana</td><td>fork de Elasticsearch con licencia libre (Apache 2.0)</td><td>ya no gana por licencia, porque desde 2024 Elasticsearch también es libre (AGPLv3)</td></tr>
        </tbody></table>`,
    }),
    notes: ['Son las tres alternativas de la pre-entrega.'],
  },

  /* ---------------- Demo ---------------- */
  {
    kind: 'cluster',
    eyebrow: 'EFK desplegado', title: 'Los logs ya tienen a dónde ir',
    text: 'Aparecieron los pods de logging, un Fluentd en cada nodo, Elasticsearch y Kibana. Los puntos que viajan son logs, que van de cada pod a su Fluentd y de ahí a Elasticsearch.',
    actions: [
      term('Ver el stack de logs', 'kubectl · logging', 'kubectl -n logging get pods -o wide'),
      doit('Prender tráfico de fondo', trafficOn),
    ],
    notes: [
      'Señalar que hay un Fluentd por nodo, también en el control-plane, donde vive el ingress.',
      'Si la instalación no terminó, mostrar la terminal “efk · instalación” y esperar el mensaje de Kibana.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 1 · Búsqueda centralizada', title: 'Todos los logs, en una búsqueda',
    text: 'Los cinco servicios y el ingress, en un solo lugar. Se filtra por servicio, por nivel, por texto y por rango de tiempo.',
    actions: [
      kb('Todos los servicios', () => discoverUrl(''), 'Discover · todo'),
      kb('Solo checkout', () => discoverUrl('app : "checkout"'), 'Discover · app : "checkout"'),
      kb('Errores de cualquier servicio', () => discoverUrl('level : "ERROR"', 'now-1h'), 'Discover · level : "ERROR"'),
      kb('Buscar el texto “checkout”', () => discoverUrl('message : *checkout*', 'now-1h'), 'Discover · texto'),
    ],
    notes: [
      'Cambiar el rango temporal desde Kibana para mostrar el filtro por fecha.',
      'En el panel izquierdo de Discover, mostrar el campo app con sus valores.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 2 · Normalización', title: 'La misma falla, tres formatos',
    text: 'Forzamos un 500 en catalog. La misma falla queda en tres lugares y en tres formatos. Una sola búsqueda por level los devuelve juntos.',
    actions: [
      term('Hacer fallar a catalog', 'catalog · chaos', 'curl -s -X POST localhost:8081/chaos/status/500', {
        onExit: (r) => { marks.catalog = { from: r.started }; },
      }),
      term('Pedir el catálogo', 'tienda', "curl -s -o /dev/null -w '%{http_code}\\n' localhost/catalog", {
        onExit: (r) => { if (marks.catalog) marks.catalog.to = r.ended; markErrors(30); },
      }),
      term('La falla, en crudo', 'logs crudos',
        "kubectl -n the-store logs deploy/catalog --tail=3 | grep ' 500 '; " +
        "kubectl -n the-store logs deploy/ui --tail=20 | grep '\"level\":\"ERROR\"' | tail -1 | cut -c1-200; " +
        "kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=5 | grep '\"status_code\":\"\\?500'", { show: 'kubectl logs de catalog, ui e ingress' }),
      kb('Una búsqueda en Kibana', () => discoverUrl('level : "ERROR"', ...(around(marks.catalog, 30, 30) || ['now-5m', 'now'])), 'Discover · level : "ERROR"'),
    ],
    notes: [
      'En la terminal se ven tres líneas: texto de Gin, JSON ECS de Java y el JSON del ingress.',
      'En Kibana, level : "ERROR" devuelve los tres en el mismo segundo. Abrir uno de cada uno y señalar app, level y kubernetes.',
      'Es el momento central: es el caso que pidió la cátedra.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 3 · Diagnóstico', title: 'De dónde vino el error',
    text: 'El cliente ve el error en ui, pero el origen está en catalog. Una búsqueda muestra los dos en la misma ventana de tiempo. También aparece la compra que falló al principio, antes de instalar EFK.',
    actions: [
      kb('ui y catalog en la ventana del error', () => discoverUrl('app : ("ui" or "catalog") and (level : "ERROR" or status_code >= 500)', ...(around(marks.catalog, 30, 30) || ['now-10m', 'now'])), 'Discover · ui y catalog'),
      kb('La compra fallida del principio', () => discoverUrl('level : "ERROR" or status_code >= 500', ...(around(marks.failedPurchase, 30, 30) || ['now-1h', 'now'])), 'Discover · compra fallida'),
      term('Restablecer catalog', 'catalog · chaos', 'curl -s -X DELETE localhost:8081/chaos/status'),
    ],
    notes: [
      'En el ERROR de ui, abrir error.stack_trace: menciona la llamada a catalog.',
      'La compra fallida ocurrió antes de EFK: Fluentd lee los archivos desde el principio, así que quedó registrada.',
      'Comparar con el contador de comandos de antes.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 4 · Persistencia', title: 'El pod se va, sus logs quedan',
    text: 'Borramos el pod de catalog. Kubernetes crea otro con otro nombre y el archivo del anterior desaparece del nodo. En Kibana, sus logs siguen ahí.',
    actions: [
      // El nombre se toma al hacer clic: al entrar a la escena los pods pueden no haber cargado
      term('Eliminar el pod de catalog', 'catalog · delete', () => { marks.catalogBefore = lastPodOf('catalog'); return 'kubectl -n the-store delete pod -l app.kubernetes.io/name=catalog'; }, {
        show: 'kubectl -n the-store delete pod -l app.kubernetes.io/name=catalog',
        onExit: () => { marks.deletedPod = { name: marks.catalogBefore, at: Date.now() }; },
      }),
      term('Intentar leer sus logs', 'catalog · logs', () => `kubectl -n the-store logs ${marks.deletedPod?.name || '<pod-anterior>'}`),
      kb('Buscar el pod borrado en Kibana', () => discoverUrl(`kubernetes.pod_name : "${marks.deletedPod?.name || ''}"`, 'now-1h'), 'Discover · pod borrado'),
    ],
    notes: [
      'El pod viejo se desvanece y aparece uno nuevo en el mapa.',
      'Borrar un pod que lleve más de un minuto vivo: Fluentd busca archivos nuevos cada 60 s, así que uno recién creado puede no haber llegado a Elasticsearch.',
      'kubectl logs del pod anterior responde que no existe. Kibana sigue mostrando sus logs, incluido el 500 del caso anterior.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 5 · Tolerancia a fallas', title: 'Apagamos Elasticsearch',
    text: 'Con el almacén caído generamos tráfico. Fluentd guarda los eventos en disco y reintenta. Cuando Elasticsearch vuelve, aparecen con su hora original.',
    actions: [
      term('Apagar Elasticsearch', 'elasticsearch', 'kubectl -n logging scale sts/elasticsearch --replicas=0', {
        onExit: (r) => { marks.outage = { from: r.started }; },
      }),
      term('Generar 20 pedidos', 'tienda', 'for i in $(seq 1 20); do curl -s -o /dev/null localhost/catalog; done; echo listo'),
      term('Ver los reintentos', 'fluentd', "kubectl -n logging logs -l app=fluentd --tail=200 --prefix | grep 'failed to flush' | tail -3 | cut -c1-230"),
      term('Encender Elasticsearch', 'elasticsearch', 'kubectl -n logging scale sts/elasticsearch --replicas=1 && kubectl -n logging rollout status sts/elasticsearch', {
        onExit: (r) => { if (marks.outage) marks.outage.to = r.started; },
      }),
      kb('Los pedidos del apagón', () => discoverUrl('app : "ingress-nginx" and path : "/catalog"', ...(around(marks.outage, 10, 10) || ['now-15m', 'now'])), 'Discover · durante la caída'),
    ],
    notes: [
      'En el mapa, el pod de Elasticsearch desaparece y los logs dejan de llegar.',
      'Kibana tampoco responde mientras Elasticsearch está apagado: es esperable.',
      'El rango de la búsqueda se arma solo con la hora de apagado y de encendido.',
    ],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 6 · Visualización', title: 'La tienda, de un vistazo',
    text: 'El tablero muestra el volumen de logs por servicio, los errores por servicio y los códigos HTTP. Se ven los picos de los incidentes que provocamos.',
    actions: [kb('Abrir el tablero', KB.dashboard, 'Dashboard · The Store · Logs')],
    notes: ['Recorrer los paneles y señalar el pico de errores de catalog y el hueco del apagón.'],
  },
  {
    kind: 'cluster',
    eyebrow: 'Caso de uso 7 · Retención', title: 'Los logs viejos se borran solos',
    text: 'Cada índice diario queda bajo la política k8s-logs-retention, que lo borra a los siete días. El disco no crece sin límite.',
    actions: [
      kb('Ver la política de retención', KB.ilm, 'Retención (ILM)'),
      kb('Ver los índices diarios', KB.indices, 'Índices'),
      kb('Consultarlo en Dev Tools', KB.devtools, 'Dev Tools · GET k8s-logs-*/_ilm/explain'),
    ],
    notes: ['En Dev Tools escribir GET k8s-logs-*/_ilm/explain: cada índice muestra la política y su edad.'],
  },
  {
    kind: 'cluster',
    eyebrow: 'Extra · Seguridad', title: 'La tienda no llega a Elasticsearch',
    text: 'Las NetworkPolicies de logging solo dejan entrar a Fluentd, Kibana y el Job de configuración. Un pod de la tienda no puede conectarse.',
    actions: [
      term('Probar desde un pod de la tienda', 'networkpolicy', 'kubectl -n the-store run np-test --rm -i --restart=Never --image=busybox:1.36 -- wget -qO- -T 5 http://elasticsearch.logging:9200'),
    ],
    notes: ['Opcional, solo si sobra tiempo. Termina en “download timed out”.'],
  },

  /* ---------------- Cierre ---------------- */
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Alcance',
      title: 'Qué dejamos afuera, <em>a propósito</em>',
      body: cols(4,
        col('Alta disponibilidad', '', 'Usamos un solo nodo de Elasticsearch. En un entorno productivo harían falta al menos tres, con réplicas, para no perder datos si uno se cae.'),
        col('TLS', '', 'Los logs viajan sin cifrar, pero solo dentro del clúster y con usuario y contraseña. En producción irían cifrados.'),
        col('Alertas', '', 'Avisar por mail o Slack ante un error requiere la licencia paga de Elastic.'),
        col('Trace ID', '', 'Seguir una compra entre servicios necesita un ID común, como el de OpenTelemetry. No viene activado en este despliegue y sumaba otro componente, así que correlacionamos por tiempo.')),
    }),
    notes: ['Son los mismos límites de la pre-entrega.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Uso de IA',
      title: 'Una herramienta, <em>las decisiones</em> fueron nuestras',
      body: cols(3,
        col('Dónde', '', 'Para comparar alternativas, escribir borradores de manifiestos, buscar la causa de algunos errores y como apoyo para esta presentación.'),
        col('Qué aportó', '', 'Velocidad para escribir y probar configuraciones.'),
        col('Qué problemas trajo', '', 'Algunas suposiciones eran incorrectas, sobre versiones, imágenes y redes. Probamos cada una en el clúster antes de usarla.', true)),
    }),
    notes: ['Ser concretos: la IA propuso, nosotros probamos en el clúster y decidimos.', 'Esta presentación también se hizo con IA: el mapa del clúster, las terminales y Kibana embebido. Cada comando que corre acá es real y lo verificamos antes de presentar.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Uso de IA · lo que encontramos probando',
      title: 'Síntoma, causa, <em>arreglo</em>',
      body: `<table>
        <thead><tr><th>Síntoma</th><th>Causa</th><th>Arreglo</th></tr></thead>
        <tbody>
          <tr><td>A veces la tienda no respondía</td><td>Nuestro clúster publica los puertos 80 y 443 solo en el control-plane, y el ingress a veces arrancaba en un worker</td><td>Fijamos el ingress al control-plane</td></tr>
          <tr><td>Los errores de ui llegaban partidos y no se podían leer</td><td>Con el stack trace pasan de 16 KB, y containerd parte las líneas largas en pedazos</td><td>El filtro <code>concat</code> de Fluentd une los pedazos antes de leerlos</td></tr>
          <tr><td>Kibana devolvía errores 500 en su propia interfaz</td><td>Le faltaba la clave con la que cifra lo que guarda</td><td>Generamos la clave al instalar y la guardamos en un Secret</td></tr>
        </tbody></table>`,
    }),
    notes: ['Contar una de las tres historias, explicada por nosotros.'],
  },
  {
    kind: 'slide',
    html: S({
      eyebrow: 'Conclusión',
      title: 'Un solo lugar para <em>investigar</em>',
      body: cols(3,
        col('Antes', '', 'Un comando por pod, cuatro formatos y logs que se pierden.'),
        col('Ahora', '', 'Una búsqueda, un esquema común, siete días de historia y un tablero.', true),
        col('Costo', '', 'Herramientas libres, sin tocar el código de la aplicación.')),
    }),
    notes: ['Cerrar con antes y ahora.'],
  },
  /* ---------------- Cierre: misma composición que la carátula, con la tienda sana ---------------- */
  {
    kind: 'slide', cls: 'cover closing',
    html: `
      <span class="mark reveal"></span>
      <span class="eyebrow reveal">Redes de Información · ITBA · TPE Tema 4</span>
      <h1 class="reveal d1">Muchas <em>gracias</em></h1>
      <p class="sub reveal d2">Los logs de toda la tienda, en un solo lugar.</p>
      <div class="podlist reveal d3"><div><i></i>ui</div><div><i></i>catalog</div><div><i></i>carts</div><div><i></i>checkout</div><div><i></i>orders</div></div>
      <div class="people reveal d4"><div>Juan Ignacio Lategana<span>64476</span></div><div>Nicolás Priotto<span>64663</span></div><div>Agustín Tomas Romero<span>64268</span></div></div>`,
    notes: ['Abrir las preguntas.'],
  },
]);
