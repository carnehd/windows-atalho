# Comandos de leitura

Só estes. No Claude Code uma guarda deixa passar exatamente este conjunto e bloqueia o resto. Sem `;`, `&`, `>`, `<`, `$`, `(`, `)`, `{`, `}`, `!`, barras invertidas nem acentos graves. Um pipe só para `grep`, `head`, `tail` ou `wc -l`.

## 1. O motor

```bash
podman --version
podman info
podman machine list
podman machine inspect
podman system connection list
podman images
podman ps -a
podman system df
podman manifest inspect docker.io/library/redis:7-alpine
podman image exists docker.io/library/redis:7-alpine
```

O mesmo com `docker` (`docker version`, `docker info`, `docker images`, `docker context ls`, `docker manifest inspect <imagem>`). `manifest inspect` só lê o manifesto no registo e não grava nada; mostra se a imagem e a etiqueta existem e para que plataformas.

## 2. A rede, a partir do computador

```bash
curl -sS -I -m 15 https://registry-1.docker.io/v2/
curl -sS -v -I -m 15 https://registry-1.docker.io/v2/
curl -sS -I -m 15 -x http://proxy.exemplo:8080 https://registry-1.docker.io/v2/
curl -sS -I -m 15 --noproxy '*' https://registry-1.docker.io/v2/
curl -sS -I -k -m 15 https://registry-1.docker.io/v2/
nslookup registry-1.docker.io
dig +short gcr.io
netsh winhttp show proxy
scutil --proxy
uname -sm
```

- `curl` leva sempre `-m 15` (ou `--max-time`). No Windows, `curl.exe`.
- `-v` mostra o certificado do emissor: é aqui que se vê a inspeção de TLS (`issuer:`).
- `-x` só com um endereço sem utilizador nem palavra-passe. Se o proxy exige autenticação, não a levas: o utilizador faz esse teste.
- `-k` (não verifica o certificado) só serve para ver se o erro é do certificado. Nunca o dás como solução.
- Os registos habituais: `registry-1.docker.io`, `gcr.io`, `quay.io`, `ghcr.io`, `mcr.microsoft.com`.

Os **nomes** das variáveis de proxy, sem os valores (o valor pode ter utilizador e palavra-passe). Só esta frase exata passa:

```bash
env | grep -i -o -E '^[a-z_]*proxy[a-z_]*='
```

O endereço do proxy pede-se ao utilizador, sem credenciais.

## 3. Dentro da máquina do Podman

É lá que o download se faz. `podman machine ssh "<comando>"` só com estes comandos:

```bash
podman machine ssh "cat /etc/containers/registries.conf"
podman machine ssh "cat /etc/containers/policy.json"
podman machine ssh "cat /etc/containers/containers.conf"
podman machine ssh "cat /etc/resolv.conf"
podman machine ssh "ls /etc/containers/registries.conf.d"
podman machine ssh "ls /etc/containers/certs.d"
podman machine ssh "ls /etc/pki/ca-trust/source/anchors"
podman machine ssh "df -h /var"
podman machine ssh "getent hosts registry-1.docker.io"
podman machine ssh "uname -m"
podman machine ssh "podman info"
podman machine ssh "curl -sS -v -I -m 15 https://registry-1.docker.io/v2/"
podman machine ssh "env | grep -i -o -E '^[a-z_]*proxy[a-z_]*='"
```

O mesmo `curl` (com `-x` e `--noproxy`) que no computador. Comparar os dois resultados é o centro do diagnóstico.

## 4. Ficheiros (Read, Grep, Glob)

Os do projeto (`docker-compose*.yml`, o README, os ficheiros de ambiente de exemplo) e as configurações do motor no computador (`~/.config/containers/registries.conf`, `containers.conf`, `/etc/containers/`). Para os certificados da empresa, só os públicos (`.pem`, `.crt`, `.cer`).

**Nunca**: `~/.docker/config.json`, `auth.json`, `.netrc`, `.ssh`, `.aws`, `.env` com valores, chaves privadas. A guarda bloqueia-os.

## 5. O que pedes ao utilizador que corra

Não são para ti: ou alteram a máquina, ou levam credenciais, ou o resultado só ele o vê.

O download, para trazeres o erro completo (é o ponto de partida):

```powershell
podman pull --log-level=debug docker.io/library/redis:7-alpine
```

O proxy do sistema no Windows (o endereço pode vir com credenciais: que as tape antes de colar):

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable, ProxyServer, AutoConfigURL
```

Os nomes das variáveis de proxy no Windows (só os nomes):

```powershell
Get-ChildItem Env: | Where-Object Name -match 'proxy' | Select-Object Name
```

E tudo o que corrige: os passos de `arvore-de-causas.md`.
