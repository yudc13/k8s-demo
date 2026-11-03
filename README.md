# Kubernetes Demo：前端 + 后端

一个最小但结构完整的双服务示例，用来练习 Deployment、Service、ConfigMap、探针、滚动更新和 HPA。

## 架构

```
浏览器
  │  localhost:8088 (kubectl port-forward)
  ▼
Service frontend (ClusterIP :80)
  ▼
frontend Pod ×2  (nginx)
  ├── /            → 静态页面 index.html / app.js / style.css
  └── /api/hello   → proxy_pass http://backend:8080
                        ▼
                    Service backend (ClusterIP :8080)
                        ▼
                    backend Pod ×2 (Node.js, 由 HPA 管理)
```

关键点：

- 浏览器只访问 frontend，`/api` 由 nginx 反向代理到后端，**没有跨域问题**，也不需要对外暴露后端。
- 后端通过 **Service 名称 `backend`** 被访问，这是集群内 DNS 服务发现。
- 后端 2 副本，刷新页面能看到 `pod` 字段在两个 Pod 之间变化（Service 负载均衡）。
- HPA 基于 CPU 在 2–6 副本之间自动扩缩容（依赖集群里的 metrics-server）。

## 目录结构

```
demo/
├── Makefile
├── backend/
│   ├── Dockerfile
│   └── server.js          # 无第三方依赖的 HTTP 服务
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf         # 静态资源 + /api 反向代理
│   ├── index.html
│   ├── app.js
│   └── style.css
└── k8s/
    ├── kustomization.yaml
    ├── namespace.yaml
    ├── backend.yaml       # ConfigMap + Deployment + Service
    ├── frontend.yaml      # nginx ConfigMap + Deployment + Service
    └── hpa.yaml
```

## 快速开始

前提：kind 集群 `kind-learning` 正在运行，且已安装 metrics-server。

```bash
cd demo

# 构建镜像 → 加载进 kind → 部署
make up

# 查看状态
make status

# 端口转发（保持前台运行）
make access
```

浏览器打开 <http://localhost:8088>。

> 镜像用 `demo-backend:dev` / `demo-frontend:dev`，`imagePullPolicy: IfNotPresent`，
> 通过 `kind load docker-image` 注入节点，不依赖镜像仓库。

## 验证命令

```bash
kubectl -n demo get deploy,svc,pods,hpa
kubectl -n demo describe pod -l app=backend
kubectl -n demo logs -l app=backend --tail=20 --prefix
kubectl -n demo get endpoints backend
kubectl -n demo get hpa backend -w
```

在集群内部验证 Service 与 DNS（不经过 frontend）：

```bash
kubectl -n demo run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://backend:8080/api/hello
```

## 使用 Helm

`chart/` 是这个 demo 的 Helm 化版本，部署结果与 `k8s/` 完全一致，适合练习 Helm 的模板、values 和版本回滚。

```text
chart/
├── Chart.yaml
├── values.yaml            # 所有可调参数
└── templates/
    ├── _helpers.tpl       # 名称/标签模板
    ├── configmap-backend.yaml
    ├── deployment-backend.yaml
    ├── service-backend.yaml
    ├── configmap-frontend.yaml
    ├── deployment-frontend.yaml
    ├── service-frontend.yaml
    ├── hpa.yaml
    ├── ingress.yaml
    └── NOTES.txt
```

常用命令：

```bash
# 校验与预览（不安装）
helm lint chart
helm template demo chart -n demo

# 安装
helm install demo chart -n demo --create-namespace

# 覆盖参数
helm upgrade --install demo chart -n demo \
  --set backend.replicas=3 \
  --set backend.greeting="来自 Helm 的问候"

# 查看与回滚
helm list -n demo
helm history demo -n demo
helm rollback demo 1 -n demo
helm uninstall demo -n demo
```

生产/多环境可以用 values 文件：

```yaml
# values-prod.yaml
backend:
  replicas: 3
  image:
    tag: "1.0.0"
ingress:
  host: demo.example.com
```

```bash
helm upgrade --install demo chart -n demo -f values-prod.yaml
```

两个 Helm 细节：

- `templates/*.yaml` 里的 `checksum/config` 注解让 ConfigMap 内容变化时自动触发 Deployment 滚动更新，这是 Helm 里常见写法。
- `ingress.host` 留空表示按 IP 访问；设置域名后会写入 Ingress 的 `host` 规则。

## 练习建议

1. **负载均衡**：连续点页面上的按钮，观察「响应 Pod」在两个后端副本间切换。
2. **滚动更新**：修改 `k8s/backend.yaml` 里 ConfigMap 的 `GREETING`（或改 `server.js` 重新构建），
   执行 `kubectl -n demo rollout restart deploy/backend` 后 `kubectl -n demo rollout status deploy/backend`，
   观察 Pod 逐个替换、页面不中断。
3. **手动扩缩容**：`kubectl -n demo scale deploy/backend --replicas=4`，再看 `kubectl get endpoints backend`。
4. **HPA 压测**：另开一个终端跑压测 Pod（见下），观察 `kubectl -n demo get hpa -w` 的副本数上涨。

   ```bash
   kubectl -n demo run load --rm -it --image=busybox:1.36 --restart=Never -- \
     sh -c 'while true; do wget -q -O- http://backend:8080/api/hello >/dev/null; done'
   ```

5. **故障观察**：`kubectl -n demo delete pod -l app=backend`，观察 Deployment 自动重建。
6. **探针**：临时把后端 `/healthz` 改坏，观察 Pod 何时变为 NotReady、何时被重启。

## 关于这个 demo 的看法

**为什么这样拆**

- 前端用 nginx 静态站点而不是 Node 前端框架：镜像小、启动快，把注意力放在 K8s 对象上，而不是前端构建链。
- 后端用一个无第三方依赖的 Node HTTP 服务：`node:20-alpine` 即可运行，暴露 Prometheus 式的健康检查也很容易。
- 两个服务各自独立 Deployment/Service，边界清晰，符合真实微服务的最小形态。

**为什么用 ClusterIP + port-forward，而不是 NodePort/Ingress**

- kind 集群创建时没有配 `extraPortMappings`，宿主机访问不到 NodePort；再叠加 Ingress 会多一层与学习目标无关的复杂度。
- `port-forward` 只把流量打到本机，安全且随用随开；等你想练 Ingress 时，再装 ingress-nginx 也不冲突。

**这个 demo 有意省略的东西（真实环境需要）**

- **镜像仓库与版本 tag**：现在靠 `kind load`，真实环境应推到 registry 并用不可变 tag/ digest。
- **配置与密钥**：`GREETING` 用了 ConfigMap，密码类应使用 Secret（或外部密钥管理）。
- **存储**：没有状态；加数据库会引入 PVC、StatefulSet、备份等一整条学习线。
- **Ingress / TLS、NetworkPolicy、PDB、多节点调度**：都是后续可以逐个加练的独立主题。
- **可观测性**：只有探针和日志，生产还应加指标、追踪、告警。

**一个值得注意的细节**

后端设了 `requests.cpu: 50m` 和 HPA `60%` 目标，所以 HPA 的「利用率」是相对 requests 计算的；如果没有 requests，HPA 无法计算百分比。这是新手最容易踩的坑之一。

## CI/CD（GitHub Actions + 腾讯云 TCR）

服务器所在网络无法直连 GitHub / Docker Hub，所以流水线采用：

```text
push main
  → GitHub Actions 构建 linux/amd64 镜像
  → 推送到腾讯云 TCR（服务器可快速拉取）
  → SSH 同步 chart 到服务器
  → helm upgrade --install（新镜像 tag）
  → Deployment 滚动更新
```

工作流文件：`.github/workflows/deploy.yml`。

### 需要的 GitHub Secrets

| Secret | 说明 |
| --- | --- |
| `TCR_USERNAME` | TCR 访问凭证用户名 |
| `TCR_PASSWORD` | TCR 访问凭证密码 |
| `TCR_NAMESPACE` | TCR 命名空间，例如 `k8s-demo` |
| `SSH_HOST` | 服务器公网 IP |
| `SSH_USER` | 登录用户，例如 `ubuntu` |
| `SSH_KEY` | 部署用 SSH 私钥（ed25519） |

### 服务器准备

在 `~/k8s-demo/values-server.yaml` 保存服务器专用参数（工作流不会覆盖它）：

```yaml
fullnameOverride: demo
ingress:
  enabled: true
  className: traefik

# TCR 命名空间为私有时启用，并先创建 Secret：
# kubectl -n demo create secret docker-registry tcr-pull \
#   --docker-server=ccr.ccs.tencentyun.com \
#   --docker-username=<TCR_USERNAME> \
#   --docker-password=<TCR_PASSWORD>
# imagePullSecrets:
#   - name: tcr-pull
```

### 工作流做了什么

1. 使用 `docker/build-push-action` 构建 amd64 镜像，tag 为 commit sha
2. `scp` 把 `chart/` 打包上传到 `/tmp`
3. SSH 登录执行 `helm upgrade --install`，通过 `--set` 传入新镜像地址和 tag
4. `--wait` 等待滚动更新完成，最后用 `curl` 验证后端接口

### 回滚

```bash
helm history demo -n demo
helm rollback demo <revision> -n demo
```

镜像 tag 使用 commit sha，旧版本镜像仍保留在 TCR，回滚不需要重新构建。

## 部署到云服务器（k3s）

本地 kind 用 `kind load`，云服务器一般用 k3s，步骤不同：

```bash
# 1. 服务器安装 k3s（Ubuntu 24.04，配置 kubeconfig 可读）
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -

# 2. 国内服务器配置 Docker Hub 镜像加速，否则系统 Pod 起不来
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/registries.yaml > /dev/null <<'EOF'
mirrors:
  docker.io:
    endpoint:
      - "https://mirror.ccs.tencentyun.com"
EOF
sudo systemctl restart k3s

# 3. 在开发机（Mac，arm64）交叉构建 amd64 镜像
docker build --platform=linux/amd64 -t demo-backend:dev backend
docker build --platform=linux/amd64 -t demo-frontend:dev frontend
docker save demo-backend:dev demo-frontend:dev | gzip > demo-images-amd64.tar.gz

# 4. 上传并导入 k3s 的 containerd（注意不是 docker load）
scp demo-images-amd64.tar.gz <user>@<server>:/tmp/
gunzip -c /tmp/demo-images-amd64.tar.gz | sudo k3s ctr images import -

# 5. 部署（代码可通过 scp 或 git 送到服务器）
kubectl apply -k k8s
kubectl apply -f k8s/ingress.yaml

# 6. 放行云厂商防火墙/安全组的 TCP 80，然后访问 http://<公网IP>/
```

注意事项：

- 服务器访问不了 GitHub 时，用 `tar + scp` 传代码，或在本地打包后上传。
- k3s 自带 Traefik，`ingressClassName` 用 `traefik`。
- 3M 带宽下上传 64MB 镜像包约 3–5 分钟，属正常。

## 清理

```bash
make clean          # 删除 demo 命名空间下所有资源
docker rmi demo-backend:dev demo-frontend:dev
```
