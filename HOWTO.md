# HOWTO · Gestión centralizada de logs con EFK

Trabajo Práctico Especial de Redes de Información (ITBA, 2C 2026), Tema 4, Grupo 1:
Lategana, Juan Ignacio (64476) · Priotto, Nicolás (64663) · Romero, Agustín Tomas (64268).

Este repo es The Store, la aplicación de la cátedra, con un stack EFK (Elasticsearch, Fluentd y
Kibana) que centraliza, normaliza y muestra los logs de sus cinco microservicios y del ingress. El
código de los servicios no se modificó: solo cambian `local.sh`, cuatro variables en
`dist/kubernetes.yaml` y el directorio nuevo `logging/`.

## Requisitos

- Docker con al menos 8 GB de memoria y unos 20 GB libres en su disco virtual.
- [Kind](https://kind.sigs.k8s.io/) 0.33 o posterior, `kubectl`, `curl` y `openssl`.
- Puertos 80 y 443 libres en la máquina.

## Instalación

Un solo comando crea el clúster (un control-plane y dos workers), compila y despliega la aplicación
e instala el stack de logs:

```bash
./local.sh rebuild-cluster --skip-tests --with-logging
```

Con la caché de Docker caliente tarda unos 9 minutos; la primera vez, bastante más, casi todo en
compilar las imágenes. Sobre un clúster
que ya existe, el stack se instala o reinstala con `./local.sh install-logging` (un par de minutos).

| URL | Qué es |
| --- | --- |
| `http://localhost` | La tienda |
| `http://kibana.localhost` | Kibana: usuario `elastic`, contraseña con `./local.sh logging-password` |

Chrome, Firefox y Safari resuelven `*.localhost` solos. Si un navegador no lo hace, agregar
`127.0.0.1 kibana.localhost` a `/etc/hosts`.

## Qué se instala

| Objeto | Archivo | Para qué |
| --- | --- | --- |
| Namespace `logging` | `logging/00-namespace.yaml` | Aísla el stack de la aplicación |
| NetworkPolicies | `logging/network/policies.yaml` | Solo Fluentd, Kibana y el Job llegan a Elasticsearch; solo el ingress llega a Kibana |
| Secret `es-credentials` | Lo crea `local.sh` | Contraseñas aleatorias de `elastic`, `kibana_system` y `fluentd`, y la clave de cifrado de Kibana; nunca se escribe en disco |
| Elasticsearch 8.19.7 | `logging/elasticsearch/` | StatefulSet de un nodo con un PVC de 5 GiB |
| Job `es-setup` | `logging/setup/es-setup-job.yaml` | Usuarios, rol de Fluentd, retención de 7 días (ILM) e index template |
| Fluentd | `logging/fluentd/` | DaemonSet: un pod por nodo que lee, parsea, normaliza y envía los logs |
| Formato JSON del ingress | `logging/ingress-nginx/log-format-patch.yaml` | El access log del ingress-nginx sale estructurado |
| Kibana 8.19.7 | `logging/kibana/kibana.yaml` | Deployment, Service e Ingress en `kibana.localhost` |
| Dashboard y búsquedas | `logging/kibana/saved-objects.ndjson` | Se importan solos al instalar |

### Cómo se normalizan los logs

| Origen | Formato original | Qué hace Fluentd |
| --- | --- | --- |
| ui, carts, orders (Java) | JSON ECS, activado con `LOGGING_STRUCTURED_FORMAT_CONSOLE=ecs` | Parsea el JSON; el nivel sale de `log.level` |
| catalog (Go, gin) | `[GIN] fecha \| status \| latencia \| ip \| MÉTODO "ruta"` | Regex: `status_code`, `method`, `path` |
| checkout (NestJS) | `[Nest] pid - fecha NIVEL [contexto] mensaje`, sin colores por `NO_COLOR=1` | Regex: `level`, `context` y, en los requests, `method`, `path`, `status_code` |
| ingress-nginx | JSON configurado en su ConfigMap | Parsea el JSON |

Todos los documentos terminan con dos campos comunes, `app` y `level` (si el servicio no informa
nivel, un `status_code` de 500 o más cuenta como `ERROR`), y con el bloque `kubernetes`
(namespace, pod, contenedor y nodo) que agrega el filtro `kubernetes_metadata`. Las líneas de más
de 16 KB, que containerd parte en trozos, se rearman antes de parsear. Los índices son diarios,
`k8s-logs-AAAA.MM.DD`, y se borran a los 7 días.

## Casos de uso

Para tener tráfico, dejar corriendo `./local.sh load-test` en otra terminal (10 minutos).

### 1. Búsqueda centralizada

En Kibana → Discover, data view «The Store · logs». Probar consultas KQL como
`app : "catalog" and level : "ERROR"` y cambiar el rango temporal.

### 2. Transformación y normalización, y 3. diagnóstico de una falla entre servicios

Forzar un error 500 en catalog con sus endpoints de prueba:

```bash
kubectl -n the-store port-forward svc/catalog 8081:80 &
curl -X POST localhost:8081/chaos/status/500
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/catalog
```

En la terminal, la misma falla en tres formatos distintos:

```bash
kubectl -n the-store logs deploy/catalog --tail=3 | grep ' 500 '
kubectl -n the-store logs deploy/ui --tail=20 | grep '"level":"ERROR"' | tail -1 | cut -c1-200
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=5 | grep '"status_code":500'
```

En Discover, `level : "ERROR"` devuelve los tres en el mismo segundo, con los mismos campos: el 500
de catalog, el ERROR de ui con su `error.stack_trace` y el 500 del ingress. Al terminar:

```bash
curl -X DELETE localhost:8081/chaos/status
kill %1
```

### 4. Persistencia frente a pods efímeros

```bash
kubectl -n the-store delete pod -l app.kubernetes.io/name=catalog
kubectl -n the-store get pods -w
```

El pod nuevo tiene otro nombre; en Discover siguen los logs del anterior filtrando por su
`kubernetes.pod_name`.

### 5. Tolerancia a la caída del backend

```bash
kubectl -n logging scale sts/elasticsearch --replicas=0
for i in $(seq 1 20); do curl -s -o /dev/null http://localhost/catalog; done
kubectl -n logging logs ds/fluentd | grep -i retry | tail -3
kubectl -n logging scale sts/elasticsearch --replicas=1
```

Mientras Elasticsearch está caído, Fluentd guarda los eventos en su buffer en disco y reintenta
con espera exponencial. Al volver, los logs del período aparecen en Kibana con su hora original.
Kibana también deja de responder mientras Elasticsearch está apagado.

### 6. Visualización operativa

Kibana → Dashboards → «The Store · Logs»: volumen por servicio, errores por servicio, códigos HTTP
y los últimos errores.

### 7. Retención automática

Kibana → Dev Tools:

```
GET k8s-logs-*/_ilm/explain
```

Cada índice aparece administrado por la política `k8s-logs-retention`, que lo borra a los 7 días.

### Extra: políticas de red

```bash
kubectl -n the-store run np-test --rm -it --restart=Never --image=busybox:1.36 -- \
  wget -qO- -T 5 http://elasticsearch.logging:9200
```

Termina en `download timed out`: un pod de la aplicación no llega a Elasticsearch.

## Desinstalación

```bash
./local.sh uninstall-logging   # borra el stack de logs, con sus datos
./local.sh delete-cluster      # borra el clúster entero
```

## Problemas comunes

| Síntoma | Arreglo |
| --- | --- |
| `elasticsearch-0` queda en `Pending` | Falta memoria: subir la de Docker o bajar el heap en `logging/elasticsearch/statefulset.yaml` |
| Elasticsearch cae con `No space left on device` | Disco de Docker lleno: `docker builder prune -f` |
| La tienda no responde en `http://localhost` | El ingress quedó fuera del control-plane: `kubectl -n ingress-nginx get pods -o wide` tiene que mostrarlo en `the-store-control-plane` |
| Kibana muestra «Kibana server is not ready yet» | Revisar que el Job haya terminado: `kubectl -n logging logs job/es-setup` |
| Un cambio en `fluent.conf` no tiene efecto | `kubectl -n logging rollout restart ds/fluentd` |
| El access log del ingress volvió a texto | Se reinstaló el ingress: `./local.sh install-logging` |
| `kibana.localhost` no abre | Agregar `127.0.0.1 kibana.localhost` a `/etc/hosts` |

Comandos útiles: `kubectl -n logging get pods -o wide`, `kubectl -n logging describe pod <pod>`,
`kubectl -n logging get events --sort-by=.lastTimestamp` y `kubectl -n logging logs <pod>`.

## Uso de IA

Usamos Claude (Anthropic) como asistente para comparar alternativas, escribir manifiestos y depurar
problemas. Revisamos cada decisión y la probamos sobre clústeres Kind antes de incorporarla. Algunas
suposiciones iniciales resultaron incorrectas, por lo que todo lo que figura en las entregas está
verificado.
