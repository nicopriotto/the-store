#!/usr/bin/env bash
# Deja el clúster listo para empezar la presentación desde cero:
#   - The Store corriendo, sin errores forzados y sin EFK instalado
#   - sin pos_file ni buffer de Fluentd en los nodos (Fluentd vuelve a leer todo)
#   - las imágenes de EFK ya cargadas en los nodos, para que "Implementar EFK" tarde poco
#   - pods de la tienda y del ingress recién creados, con logs vacíos
# Uso: ./preparar.sh   (desde cualquier carpeta)
set -euo pipefail

# Dentro del repositorio la presentación vive en ppt/, así que el repo es la carpeta de arriba
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/../local.sh" ]; then DEFAULT_REPO="$HERE/.."; else DEFAULT_REPO="$HERE/../the-store-main"; fi
REPO="${REPO:-$(cd "$DEFAULT_REPO" && pwd)}"
CLUSTER=the-store
IMAGES=(
  docker.elastic.co/elasticsearch/elasticsearch:8.19.7
  docker.elastic.co/kibana/kibana:8.19.7
  fluent/fluentd-kubernetes-daemonset:v1.19-debian-elasticsearch8-1
)

echo "== Quitando EFK"
"$REPO/local.sh" uninstall-logging

echo "== Limpiando el estado de Fluentd en los nodos"
for node in $(kind get nodes --name "$CLUSTER"); do
  docker exec "$node" rm -rf /var/log/fluentd-containers.log.pos /var/log/fluentd-buffers
done

echo "== Cargando las imágenes de EFK en los nodos"
for img in "${IMAGES[@]}"; do
  docker image inspect "$img" > /dev/null 2>&1 || docker pull "$img"
  kind load docker-image "$img" --name "$CLUSTER"
done

echo "== Sacando los errores forzados"
for svc in catalog carts checkout orders; do
  kubectl -n the-store port-forward "svc/$svc" 18080:80 > /dev/null 2>&1 &
  pf=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null localhost:18080/ && break; sleep 0.5; done
  curl -s -X DELETE localhost:18080/chaos/status > /dev/null || true
  kill "$pf"; wait "$pf" 2> /dev/null || true
done

# Pods nuevos = archivos de log vacíos: lo que Fluentd lea desde el principio es solo lo de la demo
echo "== Reiniciando los pods de la tienda y del ingress"
kubectl -n the-store rollout restart deployment
kubectl -n ingress-nginx delete pod -l app.kubernetes.io/component=controller
kubectl -n the-store rollout status deployment --timeout=300s
kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=300s

echo "== Estado"
kubectl -n the-store get pods
# El ingress nuevo queda Ready unos segundos antes de cargar sus backends: se espera el 200
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost/)" = 200 ] && break; sleep 2; done
curl -s -o /dev/null -w 'Tienda: HTTP %{http_code}\n' http://localhost/
echo "Listo. Ahora: node server.mjs (en esta carpeta)"
