#!/bin/bash
set -e

# Global configuration
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
SERVICES="catalog cart checkout orders ui"
LOGGING_DIR="$DIR/logging"

print_status() {
    local BLUE='\033[0;34m'
    echo -e "${BLUE}$1\033[0m"
}

print_success() {
    local GREEN='\033[0;32m'
    echo -e "${GREEN}$1\033[0m"
}

print_warning() {
    local YELLOW='\033[1;33m'
    echo -e "${YELLOW}$1\033[0m"
}

print_error() {
    local RED='\033[0;31m'
    echo -e "${RED}$1\033[0m"
}

check_prerequisites() {
    print_status "Checking prerequisites..."

    if ! docker info &> /dev/null; then
        print_error "Docker is not running. Please start Docker first."
        exit 1
    fi
    print_success "Docker is running"

    if ! command -v kind &> /dev/null; then
        print_error "Kind is not installed. Please install Kind first:"
        exit 1
    fi
    print_success "Kind is installed"

    if ! command -v kubectl &> /dev/null; then
        print_error "Kubectl is not installed. Please install kubectl first."
        exit 1
    fi
    print_success "Kubectl is installed"
}

create_cluster_and_deploy() {
    create_cluster
    install_ingress
    build_images
    load_images
    deploy_services
    if [ "$WITH_LOGGING" = true ]; then install_logging; fi

    [ "$SKIP_TESTS" = true ] && print_warning "Tests skipped" || run_e2e_tests
    [ "$SKIP_STATUS" = true ] && print_warning "Status skipped" || show_status
}

create_cluster() {
    print_status "Setting up Kind cluster..."

    if kind get clusters | grep -q "^$CLUSTER_NAME$"; then
        print_warning "Cluster '$CLUSTER_NAME' already exists"
        read -p "Do you want to delete and recreate it? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            print_status "Deleting existing cluster..."
            kind delete cluster --name $CLUSTER_NAME
            print_success "Cluster deleted"
        else
            print_status "Using existing cluster"
        fi
    fi

    if ! kind get clusters | grep -q "^$CLUSTER_NAME$"; then
        print_status "Creating new Kind cluster '$CLUSTER_NAME'..."

        cat <<EOF | kind create cluster --name $CLUSTER_NAME --config -
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  podSubnet: "10.244.0.0/16"
  serviceSubnet: "10.96.0.0/16"
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
  extraPortMappings:
  - containerPort: 80
    hostPort: 80
    protocol: TCP
  - containerPort: 443
    hostPort: 443
    protocol: TCP
- role: worker
- role: worker
EOF

        print_success "Cluster created successfully"
    else
        print_success "Cluster '$CLUSTER_NAME' is ready"
    fi

    print_status "Waiting for cluster to be ready..."
    kubectl wait --for=condition=Ready nodes --all --timeout=300s
    print_success "Cluster is ready"
}

install_ingress() {
    if ! kubectl get namespace ingress-nginx &> /dev/null; then
        print_status "Installing nginx ingress controller..."
        kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.13.1/deploy/static/provider/kind/deploy.yaml
        # Con workers, el scheduler puede mandarlo a un nodo sin los puertos 80
        # y 443 mapeados al host: se fija al control-plane (ingress-ready=true)
        kubectl -n ingress-nginx patch deployment ingress-nginx-controller --type merge \
            -p '{"spec":{"template":{"spec":{"nodeSelector":{"ingress-ready":"true"}}}}}'
        print_status "Waiting for nginx ingress controller to be ready..."
        kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s
        print_success "Nginx ingress controller installed"
    else
        print_success "Nginx ingress controller already installed"
    fi
}

build_images() {
    print_status "Building local Docker images..."
    print_status "Using image tag: $IMAGE_TAG"
    for service in $SERVICES; do
        print_status "Building $service service..."
        cd src/$service
        docker build -t the-store-$service:$IMAGE_TAG .
        cd ../..
    done
    print_success "All images built successfully"
}

load_images() {
    print_status "Loading images into Kind cluster..."
    for service in $SERVICES; do
        kind load docker-image the-store-$service:$IMAGE_TAG --name $CLUSTER_NAME
    done
    print_success "Images loaded into cluster"
}

deploy_services() {
    if kubectl get namespace $NAMESPACE &> /dev/null; then
        print_warning "Namespace '$NAMESPACE' already exists"
        read -p "Do you want to delete the namespace and all related resources? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            print_status "Deleting namespace '$NAMESPACE' and all resources..."
            kubectl delete namespace $NAMESPACE
            print_status "Waiting for namespace deletion to complete..."
            kubectl wait --for=delete namespace/$NAMESPACE --timeout=300s
            print_success "Namespace '$NAMESPACE' deleted successfully"
        else
            print_status "Using existing namespace '$NAMESPACE'"
        fi
    fi

    if ! kubectl get namespace $NAMESPACE &> /dev/null; then
        print_status "Creating namespace '$NAMESPACE'..."
        kubectl create namespace $NAMESPACE
        print_success "Namespace '$NAMESPACE' is ready"
    fi

    print_status "Applying Kubernetes manifests to namespace '$NAMESPACE'..."
    kubectl apply -f $DIR/dist/kubernetes.yaml -n $NAMESPACE

    print_status "Waiting for all deployments to be available..."
    kubectl wait --namespace $NAMESPACE --for=condition=available deployments --timeout=300s --all
    print_success "All deployments are available"

    print_status "Waiting for all pods to be ready and running..."
    kubectl wait --namespace $NAMESPACE --for=condition=ready pods --timeout=300s --all
    print_success "All pods are ready and running"
}

show_status() {
    print_status "Showing status for cluster '$CLUSTER_NAME'..."
    if kind get clusters | grep -q "^$CLUSTER_NAME$"; then
        print_status "Cluster Information:"
        kind get clusters
        echo ""
        print_status "Node Status:"
        kubectl get nodes
        echo ""

        if kubectl get namespace ingress-nginx &> /dev/null; then
            print_status "Ingress Controller Status:"
            kubectl get all -n ingress-nginx
            echo ""
        else
            print_warning "Ingress Controller is not installed"
        fi

        # if kubectl get namespace metallb-system &> /dev/null; then
        #     print_status "MetalLB Status:"
        #     kubectl get all -n metallb-system
        #     echo ""
        #     print_status "IP Address Pools:"
        #     kubectl get ipaddresspools -n metallb-system
        # else
        #     print_warning "MetalLB is not installed"
        # fi

        if kubectl get namespace $NAMESPACE &> /dev/null; then
            print_status "Service Status:"
            kubectl get all -n $NAMESPACE
        else
            print_warning "No $NAMESPACE namespace found"
        fi

        print_success "UI service is accessible at: http://localhost"
    else
        print_warning "Cluster '$CLUSTER_NAME' does not exist"
    fi
}

delete_cluster() {
    if kind get clusters | grep -q "^$CLUSTER_NAME$"; then
        kind delete cluster --name $CLUSTER_NAME
        print_success "Cluster '$CLUSTER_NAME' deleted successfully"
    else
        print_error "Cluster '$CLUSTER_NAME' does not exist"
    fi
}

run_e2e_tests() {
    print_status "Running end-to-end tests..."
    bash "$DIR/src/e2e/scripts/run-docker.sh" -n host 'http://localhost'
    print_success "E2E tests completed!"
}

# --- Stack de logs (EFK) ----------------------------------------------------

es_password() {
    kubectl -n logging get secret es-credentials -o jsonpath='{.data.elastic}' | base64 --decode
}

install_logging() {
    print_status "Installing logging stack (EFK)..."
    kubectl apply -f "$LOGGING_DIR/00-namespace.yaml"
    kubectl apply -f "$LOGGING_DIR/network/"

    # Solo la primera vez: regenerarlas desincroniza la contraseña de elastic
    if ! kubectl -n logging get secret es-credentials &> /dev/null; then
        kubectl -n logging create secret generic es-credentials \
            --from-literal=elastic="$(openssl rand -hex 12)" \
            --from-literal=kibana_system="$(openssl rand -hex 12)" \
            --from-literal=fluentd="$(openssl rand -hex 12)" \
            --from-literal=kibana_encryption="$(openssl rand -hex 16)"
    fi

    kubectl apply -f "$LOGGING_DIR/elasticsearch/"
    kubectl -n logging rollout status statefulset/elasticsearch --timeout=300s

    # El template tiene que existir antes del primer log
    kubectl -n logging delete job es-setup --ignore-not-found
    kubectl apply -f "$LOGGING_DIR/setup/"
    kubectl -n logging wait --for=condition=complete job/es-setup --timeout=300s

    kubectl -n ingress-nginx patch configmap ingress-nginx-controller \
        --type merge --patch-file "$LOGGING_DIR/ingress-nginx/log-format-patch.yaml"

    kubectl apply -f "$LOGGING_DIR/fluentd/"
    kubectl -n logging rollout restart daemonset/fluentd   # subPath: no toma solo los cambios del ConfigMap
    kubectl -n logging rollout status daemonset/fluentd --timeout=300s

    kubectl apply -f "$LOGGING_DIR/kibana/kibana.yaml"
    kubectl -n logging rollout status deployment/kibana --timeout=600s

    setup_kibana_objects
    print_success "Kibana: http://kibana.localhost  (user elastic, password: ./local.sh logging-password)"
}

setup_kibana_objects() {
    local pw; pw="$(es_password)"
    local kb=(-s -u "elastic:$pw" -H 'Host: kibana.localhost' -H 'kbn-xsrf: true')

    until curl "${kb[@]}" -o /dev/null -w '%{http_code}' http://localhost/api/status | grep -q 200; do
        print_status "Waiting for Kibana..."; sleep 5
    done

    curl "${kb[@]}" -X POST http://localhost/api/data_views/data_view \
        -H 'Content-Type: application/json' \
        -d '{"data_view":{"id":"k8s-logs","title":"k8s-logs-*","name":"The Store · logs","timeFieldName":"@timestamp"},"override":true}' > /dev/null

    if [ -f "$LOGGING_DIR/kibana/saved-objects.ndjson" ]; then
        curl "${kb[@]}" -X POST "http://localhost/api/saved_objects/_import?overwrite=true" \
            --form file=@"$LOGGING_DIR/kibana/saved-objects.ndjson" > /dev/null
    fi
}

uninstall_logging() {
    print_status "Removing logging stack..."
    kubectl delete namespace logging --ignore-not-found
    # El RBAC de Fluentd es de alcance de clúster: no se va con el namespace
    kubectl delete clusterrolebinding fluentd --ignore-not-found
    kubectl delete clusterrole fluentd --ignore-not-found
    print_success "Logging stack removed"
}

cmd_install_logging()   { check_prerequisites; install_logging; }
cmd_uninstall_logging() { check_prerequisites; uninstall_logging; }
cmd_logging_password()  { es_password; echo; }

show_help() {
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "COMMANDS:"
    echo "  help            Show this help message (default)"
    echo "  create-cluster  Create cluster and deploy services"
    echo "  delete-cluster  Delete the cluster"
    echo "  rebuild-cluster Delete and recreate cluster"
    echo "  status          Show cluster status"
    echo "  reload-images   Build and load Docker images"
    echo "  e2e-test        Run end-to-end tests"
    echo "  load-test       Run load generator tests"
    echo "  install-logging   Install the EFK logging stack (namespace logging)"
    echo "  uninstall-logging Remove the EFK logging stack"
    echo "  logging-password  Print the password of the elastic user"
    echo ""
    echo "OPTIONS:"
    echo "  -c, --cluster NAME   Cluster name (default: the-store)"
    echo "  -n, --namespace NAME Kubernetes namespace (default: the-store)"
    echo "  --skip-tests         Skip running e2e tests when creating/rebuilding cluster"
    echo "  --skip-status        Skip status display when creating/rebuilding cluster"
    echo "  --with-logging       Install the logging stack after create/rebuild"
    echo "  -h, --help           Show this help"
}

cmd_create_cluster() {
    check_prerequisites
    create_cluster_and_deploy
}

cmd_rebuild_cluster() {
    check_prerequisites
    print_status "Rebuilding cluster '$CLUSTER_NAME'..."
    delete_cluster
    create_cluster_and_deploy
}

cmd_delete_cluster() {
    check_prerequisites
    delete_cluster
}

cmd_reload_images() {
    check_prerequisites
    print_status "Building and loading Docker images..."
    build_images
    load_images
    print_success "Images built and loaded successfully"
}

cmd_status() {
    check_prerequisites
    show_status
}

cmd_e2e_tests() {
    check_prerequisites

    if ! kind get clusters | grep -q "^$CLUSTER_NAME$"; then
        print_error "Cluster '$CLUSTER_NAME' does not exist. Please create it first with 'create-cluster' command."
        exit 1
    fi

    if ! kubectl get namespace $NAMESPACE &> /dev/null; then
        print_error "Namespace '$NAMESPACE' does not exist. Please deploy services first with 'create-cluster' command."
        exit 1
    fi

    if ! kubectl wait --namespace $NAMESPACE --for=condition=available deployments --timeout=30s --all &> /dev/null; then
        print_error "Services are not running. Please ensure all deployments are available."
        exit 1
    fi

    run_e2e_tests
}

cmd_load_generator() {
    check_prerequisites

    if ! kind get clusters | grep -q "^$CLUSTER_NAME$"; then
        print_error "Cluster '$CLUSTER_NAME' does not exist. Please create it first with 'create-cluster' command."
        exit 1
    fi

    if ! kubectl get namespace $NAMESPACE &> /dev/null; then
        print_error "Namespace '$NAMESPACE' does not exist. Please deploy services first with 'create-cluster' command."
        exit 1
    fi

    if ! kubectl wait --namespace $NAMESPACE --for=condition=available deployments --timeout=30s --all &> /dev/null; then
        print_error "Services are not running. Please ensure all deployments are available."
        exit 1
    fi

    run_load_generator
}

run_load_generator() {
    print_status "Running load generator..."
    bash "$DIR/src/load-generator/scripts/run-docker.sh" -n host -t 'http://localhost' -d 600
    print_success "Load generator completed!"
}

main() {
    COMMAND="help"
    IMAGE_TAG="latest"
    CLUSTER_NAME="the-store"
    NAMESPACE="the-store"
    SKIP_TESTS=false
    SKIP_STATUS=false
    WITH_LOGGING=false

    while [[ $# -gt 0 ]]; do
        case $1 in
            help|create-cluster|delete-cluster|rebuild-cluster|status|reload-images|e2e-test|load-test|install-logging|uninstall-logging|logging-password) COMMAND="$1"; shift ;;
            -c|--cluster) CLUSTER_NAME="$2"; shift 2 ;;
            -n|--namespace) NAMESPACE="$2"; shift 2 ;;
            --skip-tests) SKIP_TESTS=true; shift ;;
            --skip-status) SKIP_STATUS=true; shift ;;
            --with-logging) WITH_LOGGING=true; shift ;;
            -h|--help) show_help; exit 0 ;;
            *) echo "Unknown option: $1"; show_help; exit 1 ;;
        esac
    done

    case $COMMAND in
        create-cluster) cmd_create_cluster;;
        delete-cluster) cmd_delete_cluster;;
        rebuild-cluster) cmd_rebuild_cluster;;
        status) cmd_status;;
        reload-images) cmd_reload_images;;
        e2e-test) cmd_e2e_tests;;
        load-test) cmd_load_generator;;
        install-logging) cmd_install_logging;;
        uninstall-logging) cmd_uninstall_logging;;
        logging-password) cmd_logging_password;;
        help) show_help; exit 0;;
        *) print_error "Unknown command: $COMMAND"; show_help; exit 1;;
    esac
}

main "$@"
