# Jenkins CI/CD 部署说明

服务器无法访问 GitHub / Docker Hub，因此采用「服务器本地裸仓库 + 本地构建 + 导入 k3s」的拓扑：

```text
Mac: git push
  ├──→ GitHub（备份/协作）
  └──→ 服务器 ~/repos/k8s-demo.git（裸仓库）
             ↓ Jenkins 轮询
        Jenkins 在服务器构建 amd64 镜像
             ↓ docker save | k3s ctr images import
        helm upgrade --install
             ↓
        Deployment 滚动更新
```

优点：不依赖镜像仓库、不需要传镜像、构建走服务器原生 amd64。
缺点：Jenkins 常驻占用约 0.5–1GB 内存；push 需要同时推两个远端（可自动完成）。

## 1. 安装依赖（服务器）

```bash
# Java 21
sudo apt update
sudo apt install -y openjdk-21-jdk

# Docker（用于构建镜像）
sudo apt install -y docker.io

# Docker Hub 镜像加速（否则拉不到 node / nginx 基础镜像）
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]
}
EOF
sudo systemctl enable --now docker
sudo systemctl restart docker
```

验证 Docker 能拉镜像：

```bash
sudo docker run --rm hello-world
```

## 2. 安装 Jenkins

```bash
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key \
  | sudo tee /etc/apt/keyrings/jenkins-keyring.asc >/dev/null

echo "deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" \
  | sudo tee /etc/apt/sources.list.d/jenkins.list >/dev/null

sudo apt update
sudo apt install -y jenkins
sudo systemctl enable --now jenkins
```

> 如果 `pkg.jenkins.io` 下载太慢，把源换成清华镜像：
> `https://mirrors.tuna.tsinghua.edu.cn/jenkins/debian-stable`，
> key 换成 `https://mirrors.tuna.tsinghua.edu.cn/jenkins/jenkins.io-2023.key`。

初始管理员密码：

```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

浏览器通过 SSH 隧道访问（**不要**把 8080 开到公网）：

```bash
ssh -L 8080:127.0.0.1:8080 ubuntu@<服务器IP>
# 本机打开 http://localhost:8080
```

首次进入安装「推荐插件」即可（包含 Git、Pipeline）。

## 3. 给 Jenkins 用户授权

Jenkins 以 `jenkins` 用户运行，需要：

```bash
# 1. 允许使用 Docker
sudo usermod -aG docker jenkins

# 2. 允许免密执行 k3s ctr（导入镜像）
echo 'jenkins ALL=(ALL) NOPASSWD: /usr/local/bin/k3s' \
  | sudo tee /etc/sudoers.d/jenkins-k3s
sudo chmod 440 /etc/sudoers.d/jenkins-k3s

# 3. 重启让用户组生效
sudo systemctl restart jenkins
```

确认 Jenkins 能读 kubeconfig（k3s 安装时用了 `--write-kubeconfig-mode 644`）：

```bash
sudo -u jenkins test -r /etc/rancher/k3s/k3s.yaml && echo readable
```

## 4. 建服务器本地裸仓库

```bash
mkdir -p ~/repos
git init --bare ~/repos/k8s-demo.git
chmod -R o+rX ~/repos
```

在 Mac 上让一次 push 同时推到 GitHub 和服务器：

```bash
git remote -v    # 先确认现有配置

git remote set-url --add --push origin git@github.com:yudc13/k8s-demo.git
git remote set-url --add --push origin ssh://ubuntu@192.144.148.65/home/ubuntu/repos/k8s-demo.git

git remote -v    # 应看到两个 push 地址
git push origin main
```

之后正常 `git push` 会同时更新两边。

## 5. 创建 Jenkins 任务

1. **New Item** → 名称 `demo-deploy` → **Pipeline** → OK
2. **Pipeline** → Definition 选 **Pipeline script from SCM**
3. SCM 选 **Git**
   - Repository URL：`file:///home/ubuntu/repos/k8s-demo.git`
   - Branch Specifier：`*/main`
4. Script Path：`Jenkinsfile`
5. **Build Triggers** 勾选 **Poll SCM**，填 `H/2 * * * *`（每两分钟左右检查一次）
6. 保存，点 **Build Now** 测试

流水线阶段：

```text
Checkout → Prepare → Build images → Import images into k3s → Helm upgrade → Verify
```

## 6. 验证

构建成功后：

```bash
kubectl -n demo get deploy -o wide
kubectl -n demo get pods
helm history demo -n demo
```

浏览器访问 `http://<服务器公网IP>/`，改一行前端代码再 push，等 Jenkins 轮询触发即可看到自动发布。

## 7. 回滚

```bash
helm history demo -n demo
helm rollback demo <revision> -n demo
```

旧镜像仍在 k3s containerd 中，直接回滚即可。定期清理旧 tag，避免磁盘占满：

```bash
sudo k3s ctr images ls | grep demo-
sudo k3s ctr images rm <旧tag>
```

## 8. 其他拓扑

- **Jenkins 装在 Mac**：把 Jenkinsfile 的后两步改为 `scp` 镜像包到服务器 + SSH 执行 import，`runs-on` 不适用，`agent` 用 Mac 上的内置节点。
- **代码走 Gitee**：把任务里的 SCM URL 改成 Gitee 仓库地址，并在 Gitee 配置 webhook 或轮询。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| `docker: permission denied` | `jenkins` 未加入 docker 组，或未重启 Jenkins |
| `sudo: a password is required` | sudoers 规则未生效，检查 `/etc/sudoers.d/jenkins-k3s` |
| `k3s: command not found` | sudoers 路径与实际 `which k3s` 不一致 |
| 拉取 node/nginx 基础镜像超时 | Docker 镜像加速未生效，检查 `docker info` 的 Registry Mirrors |
| `helm: command not found` | 把 helm 移到 `/usr/local/bin` 并确认 Jenkins PATH |
| 内存不足 / OOM | 4GB 机器建议加 2GB swap；Jenkins JVM 可用 `JAVA_OPTS=-Xmx512m` |
| 轮询不触发 | 仓库 push 是否到了服务器裸仓库；Jenkins 是否能读 `file://` 路径 |
