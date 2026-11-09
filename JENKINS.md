# Jenkins CI/CD 部署说明

服务器无法访问 GitHub / Docker Hub，因此采用「服务器本地裸仓库 + 服务器构建 + 本地镜像仓库」的拓扑：

```text
Mac: git push
  ├──→ GitHub（备份/协作）
  └──→ 服务器 /srv/git/k8s-demo.git（裸仓库）
             ↓ Jenkins 轮询
        Jenkins 在服务器构建 amd64 镜像
             ↓ docker push
        服务器本地 registry（127.0.0.1:5000）
             ↓ helm upgrade --install
        Deployment 滚动更新
             ↓ k3s containerd 从 127.0.0.1:5000 拉取
```

优点：构建走服务器原生 amd64；镜像集中存放，可回滚、可查历史；以后加 worker 节点只需把 registry 地址换成内网 IP。
缺点：Jenkins 常驻占用约 0.5–1GB 内存；基础镜像需要预先导入（服务器拉不到 Docker Hub）。

> 服务器上已有：k3s、Docker、Helm、kubectl、registry 容器（`127.0.0.1:5000`）。
> 本文档从「安装 Jenkins」开始。

## 0. 前置检查

```bash
# registry 必须在跑
sudo docker ps --filter name=registry
curl -s http://127.0.0.1:5000/v2/_catalog; echo

# k3s 信任本地 registry
sudo cat /etc/rancher/k3s/registries.yaml
```

## 1. 导入基础镜像（服务器拉不到 Docker Hub）

Jenkins 构建需要 `node:20-alpine` 和 `nginx:1.27-alpine`，在 **Mac** 上导出后传过去：

```bash
# Mac
docker pull --platform=linux/amd64 node:20-alpine nginx:1.27-alpine
docker save node:20-alpine nginx:1.27-alpine \
  | gzip | ssh ubuntu@192.144.148.65 'gunzip | sudo docker load'
```

服务器验证：

```bash
sudo docker images | grep -E 'node|nginx'
```

以后升级基础镜像版本时，重复这一步即可。

## 2. 安装 Java 和 Jenkins

```bash
# Java 21
sudo apt update
sudo apt install -y openjdk-21-jdk

# Jenkins 源（pkg.jenkins.io 可访问，慢的话换清华镜像）
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key \
  | sudo tee /etc/apt/keyrings/jenkins-keyring.asc >/dev/null

echo "deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" \
  | sudo tee /etc/apt/sources.list.d/jenkins.list >/dev/null

sudo apt update
sudo apt install -y jenkins
sudo systemctl enable --now jenkins
```

限制 JVM 内存并只监听本机（4GB 机器建议）：

```bash
sudo mkdir -p /etc/systemd/system/jenkins.service.d
sudo tee /etc/systemd/system/jenkins.service.d/memory.conf >/dev/null <<'EOF'
[Service]
Environment="JAVA_OPTS=-Xmx512m"
Environment="JENKINS_LISTEN_ADDRESS=127.0.0.1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart jenkins
```

初始管理员密码：

```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

浏览器通过 SSH 隧道访问（**不要**把 8080 开到公网）：

```bash
ssh -L 8080:127.0.0.1:8080 ubuntu@192.144.148.65
# 本机打开 http://localhost:8080
```

首次进入安装「推荐插件」即可（包含 Git、Pipeline）。

## 3. 给 Jenkins 用户授权

Jenkins 以 `jenkins` 用户运行，需要能用 Docker、能读 kubeconfig：

```bash
# 加入 docker 组（构建和推送镜像）
sudo usermod -aG docker jenkins
sudo systemctl restart jenkins

# 确认能读 kubeconfig（k3s 安装时用了 --write-kubeconfig-mode 644）
sudo -u jenkins test -r /etc/rancher/k3s/k3s.yaml && echo readable

# helm / kubectl 在 /usr/local/bin，默认 PATH 可用
sudo -u jenkins which helm kubectl
```

> 不再需要 `sudo k3s ctr images import`，因此不需要给 jenkins 配 sudoers。

## 4. 建服务器本地裸仓库

放在 `/srv/git` 而不是 `~/repos`：`/home/ubuntu` 权限是 `750`，`jenkins` 用户无法穿过家目录读取仓库。

```bash
sudo mkdir -p /srv/git
sudo git init --bare /srv/git/k8s-demo.git
sudo chown -R ubuntu:ubuntu /srv/git
sudo chmod -R o+rX /srv/git
```

在 Mac 上让一次 push 同时推到 GitHub 和服务器：

```bash
git remote -v    # 先确认现有配置

git remote set-url --add --push origin https://github.com/yudc13/k8s-demo.git
git remote set-url --add --push origin ssh://ubuntu@192.144.148.65/srv/git/k8s-demo.git

git remote -v    # 应看到两个 push 地址
git push origin main
```

之后正常 `git push` 会同时更新两边。

## 5. 创建 Jenkins 任务

1. **New Item** → 名称 `demo-deploy` → **Pipeline** → OK
2. **Pipeline** → Definition 选 **Pipeline script from SCM**
3. SCM 选 **Git**
   - Repository URL：`file:///srv/git/k8s-demo.git`
   - Branch Specifier：`*/main`
4. Script Path：`Jenkinsfile`
5. **Build Triggers** 勾选 **Poll SCM**，填 `H/2 * * * *`（每两分钟左右检查一次）
6. 保存，点 **Build Now** 测试

流水线阶段：

```text
Checkout → Prepare → Build & Push images → Helm upgrade → Verify
```

镜像引用由 `values-server.yaml` 提供（`127.0.0.1:5000/demo-backend`、`127.0.0.1:5000/demo-frontend`），流水线只覆盖 tag（commit sha）。

## 6. 验证

构建成功后：

```bash
helm history demo -n demo
kubectl -n demo get pods
kubectl -n demo get deploy -o wide
curl -s http://127.0.0.1:5000/v2/demo-backend/tags/list; echo
```

浏览器访问 `http://<服务器公网IP>/`，改一行前端代码再 push，等 Jenkins 轮询触发即可看到自动发布。

## 7. 回滚

```bash
helm history demo -n demo
helm rollback demo <revision> -n demo
```

旧镜像仍在 registry 里，只要 tag 存在就能拉回。

定期清理旧 tag，避免磁盘占满：

```bash
# 1. 当前 registry 容器未开启删除，先开启（数据在 /opt/registry/data，不会丢）
sudo docker rm -f registry
sudo docker run -d --name registry \
  --restart=always \
  -e REGISTRY_STORAGE_DELETE_ENABLED=true \
  -p 127.0.0.1:5000:5000 \
  -v /opt/registry/data:/var/lib/registry \
  registry:2

# 2. 列出 tag
curl -s http://127.0.0.1:5000/v2/demo-backend/tags/list

# 3. 在 Mac 上通过 SSH 隧道删除 tag（需先开隧道）
crane delete 127.0.0.1:5000/demo-backend:<旧tag> --insecure

# 4. 回收空间
sudo docker exec registry registry garbage-collect /etc/docker/registry/config.yml
```

## 8. 其他拓扑

- **Jenkins 装在 Mac**：构建后不能直接用 `docker push`（Docker Desktop 的 daemon 在 VM 里，访问不到 Mac 的 127.0.0.1 隧道），需要 `docker save` + `crane push --insecure`；部署需 kubeconfig 远程执行 helm。
- **代码走 Gitee**：把任务里的 SCM URL 改成 Gitee 仓库地址，并在 Gitee 配置 webhook 或轮询。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| `docker: permission denied` | `jenkins` 未加入 docker 组，或未重启 Jenkins |
| `docker build` 拉 `node:20-alpine` 超时 | 基础镜像未导入，回到第 1 节 |
| `docker push` 报 `connection refused` | registry 容器没跑：`sudo docker ps` |
| `ImagePullBackOff` + `http: server gave HTTP response to HTTPS client` | k3s 未加载 `registries.yaml`，`sudo systemctl restart k3s` |
| `manifest unknown` | 镜像 tag 不存在，`curl .../tags/list` 确认 |
| `helm: command not found` | 把 helm 移到 `/usr/local/bin` 并确认 Jenkins PATH |
| 内存不足 / OOM | 已加 2GB swap；用第 2 节的 `JAVA_OPTS=-Xmx512m` |
| 轮询不触发 | 仓库 push 是否到了服务器裸仓库；Jenkins 是否能读 `file://` 路径 |
