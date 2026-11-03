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

## 清理

```bash
make clean          # 删除 demo 命名空间下所有资源
docker rmi demo-backend:dev demo-frontend:dev
```
