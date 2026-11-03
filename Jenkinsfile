pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 20, unit: 'MINUTES')
    }

    parameters {
        string(name: 'RELEASE', defaultValue: 'demo', description: 'Helm release 名称')
        string(name: 'NAMESPACE', defaultValue: 'demo', description: 'Kubernetes 命名空间')
        choice(name: 'IMAGE_PLATFORM', choices: ['linux/amd64', 'linux/arm64'], description: '镜像目标平台')
    }

    environment {
        KUBECONFIG = '/etc/rancher/k3s/k3s.yaml'
    }

    triggers {
        pollSCM('H/2 * * * *')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Prepare') {
            steps {
                script {
                    env.IMAGE_TAG = sh(
                        returnStdout: true,
                        script: 'git rev-parse --short=8 HEAD'
                    ).trim()
                    echo "镜像 tag: ${env.IMAGE_TAG}，平台: ${params.IMAGE_PLATFORM}"
                }
            }
        }

        stage('Build images') {
            steps {
                sh '''
                    set -eu
                    docker build --platform="${IMAGE_PLATFORM}" -t "demo-backend:${IMAGE_TAG}" ./backend
                    docker build --platform="${IMAGE_PLATFORM}" -t "demo-frontend:${IMAGE_TAG}" ./frontend
                '''
            }
        }

        stage('Import images into k3s') {
            steps {
                sh '''
                    set -eu
                    docker save "demo-backend:${IMAGE_TAG}" "demo-frontend:${IMAGE_TAG}" \
                      | gzip | sudo k3s ctr images import -
                '''
            }
        }

        stage('Helm upgrade') {
            steps {
                sh '''
                    set -eu
                    helm upgrade --install "${RELEASE}" ./chart \
                      -n "${NAMESPACE}" --create-namespace \
                      -f values-server.yaml \
                      --set backend.image.repository=demo-backend \
                      --set backend.image.tag="${IMAGE_TAG}" \
                      --set frontend.image.repository=demo-frontend \
                      --set frontend.image.tag="${IMAGE_TAG}" \
                      --wait --timeout 5m
                '''
            }
        }

        stage('Verify') {
            steps {
                sh '''
                    set -eu
                    kubectl -n "${NAMESPACE}" get pods
                    curl -fsS http://127.0.0.1/api/hello
                '''
            }
        }
    }

    post {
        failure {
            sh '''
                kubectl -n "${NAMESPACE}" get pods || true
                kubectl -n "${NAMESPACE}" describe deploy/"${RELEASE}"-backend | tail -40 || true
            '''
        }
        success {
            echo "已部署 ${RELEASE} 到 ${NAMESPACE}，镜像 tag ${IMAGE_TAG}"
        }
        always {
            sh 'docker image prune -f >/dev/null 2>&1 || true'
        }
    }
}
