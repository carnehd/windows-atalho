# Do erro à causa

Os textos dos erros variam com a versão do Podman e do Docker: procura a ideia, não a frase igual. Os passos de "O utilizador faz" são **para o utilizador correr**; tu nunca os corres.

| O erro diz | Causa provável | Secção |
|---|---|---|
| `x509: certificate signed by unknown authority`, `certificate verify failed`, `tls: failed to verify certificate` | O proxy inspeciona o TLS e a máquina não conhece o certificado da empresa | A |
| `i/o timeout`, `context deadline exceeded`, `Client.Timeout exceeded`, `proxyconnect`, `407`, `connection refused` | A máquina não chega ao registo: não usa o proxy | B |
| `no such host`, `server misbehaving`, `Temporary failure in name resolution` | DNS da máquina | C |
| `403`, uma página HTML de bloqueio, `connection reset`, o manifesto passa e as camadas ficam presas; só um registo falha | Registo ou endereço de camadas bloqueado | D |
| `toomanyrequests`, `429`, `unauthenticated pull rate limit` | Limite de pedidos do registo (IP partilhado) | E |
| `manifest unknown`, `name unknown`, `denied`, `unauthorized`, `short-name resolution enforced`, `did not resolve to an alias` | Nome ou etiqueta errados, imagem privada, ou nome curto sem registo | F |
| `Cannot connect to Podman`, `unable to connect to Podman socket` | A máquina ou o motor está parado | G |
| `no space left on device` | A máquina está cheia | H |
| `no image found in manifest list for architecture`, `exec format error` | Arquitetura errada | I |
| Fica preso, ou `unexpected EOF` a meio de uma camada | Limite do proxy para downloads grandes, filtro, ligação lenta | J |

## A. Certificado desconhecido

- **Confirmar (só a ler):** `curl -sS -v -I -m 15 https://registry-1.docker.io/v2/` no computador e dentro da máquina. Nas linhas `issuer:` e `subject:`, um emissor da própria empresa (e não uma entidade pública) indica inspeção de TLS. Se o computador não dá erro e a máquina dá, a máquina não conhece a entidade. `ls /etc/pki/ca-trust/source/anchors` na máquina mostra se já lá há um certificado.
- **O utilizador faz:** obtém o certificado raiz da empresa (com a equipa de IT, ou exportado do repositório de certificados do Windows em Base64 X.509, `.cer` ou `.pem`) e instala-o na máquina do Podman. Um caminho habitual, a confirmar na versão dele:
  ```powershell
  Get-Content .\ca-empresa.pem | podman machine ssh "sudo tee /etc/pki/ca-trust/source/anchors/ca-empresa.crt > /dev/null"
  podman machine ssh "sudo update-ca-trust"
  podman machine stop
  podman machine start
  ```
  Em alternativa, só para um registo: o certificado em `/etc/containers/certs.d/<registo>/ca.crt` dentro da máquina. Num Linux sem máquina, o mesmo em `/etc/pki/ca-trust/source/anchors/` e `sudo update-ca-trust`.
- **Nota:** `--tls-verify=false` no download desliga a verificação. Serve ao utilizador para provar a causa (se com isso descarrega, é o certificado), não como solução.

## B. A máquina não usa o proxy

- **Confirmar:** do computador, `curl -sS -I -m 15 -x <proxy> https://registry-1.docker.io/v2/` (o endereço que o utilizador deu) e o mesmo sem proxy com `--noproxy '*'`. De dentro da máquina, os mesmos dois. Se o computador chega só com o proxy e a máquina falha sem ele, a máquina precisa do proxy. Os nomes das variáveis de proxy no computador e na máquina (receita só dos nomes) mostram se alguma está definida. Um `407` quer dizer que o proxy exige autenticação: não levas credenciais; o utilizador ou a equipa de rede resolvem.
- **O utilizador faz:** dá o proxy à máquina. No Podman Desktop, a definição de proxy (e reinicia a máquina). Na linha de comandos, as variáveis `HTTP_PROXY`, `HTTPS_PROXY` e `NO_PROXY` para o serviço do Podman dentro da máquina: o modo depende da versão, por isso lê o guia do Podman sobre proxy antes. O `NO_PROXY` leva os endereços locais e os internos da empresa. Depois volta a descarregar.

## C. DNS

- **Confirmar:** `nslookup registry-1.docker.io` no computador; `getent hosts registry-1.docker.io` e `cat /etc/resolv.conf` na máquina. Se o computador resolve e a máquina não, o DNS da máquina é o problema (muda com a VPN).
- **O utilizador faz:** reinicia a máquina com a VPN já ligada; se continuar, o DNS da máquina fica com a equipa de rede.

## D. Registo ou endereço bloqueado

- **Confirmar:** `curl -sS -I -m 15 https://<registo>/v2/` a cada registo. `401` com `www-authenticate` quer dizer que o registo responde (é o normal sem credenciais). `403`, uma página de bloqueio ou um *reset* quer dizer bloqueio. O erro do download traz os endereços exatos que falharam: testa esses. Os habituais: o `docker.io` usa `registry-1.docker.io`, `auth.docker.io` e `production.cloudflare.docker.com` (camadas); o `quay.io` usa `quay.io` e os `cdn*.quay.io`; o `ghcr.io` usa `ghcr.io` e `pkg-containers.githubusercontent.com`. Confirma sempre no erro real, que manda.
- **O utilizador faz:** pede à equipa de rede ou de segurança que autorize os endereços; ou usa um espelho interno (Artifactory, Nexus) configurado em `registries.conf` com um `[[registry.mirror]]`, e os nomes das imagens não mudam.

## E. Limite de pedidos

- **Confirmar:** o texto do erro basta. O limite é por IP, e numa empresa o IP é partilhado.
- **O utilizador faz:** `podman login docker.io` com uma conta própria (a palavra-passe escreve-a ele, nunca tu), ou espera, ou usa um espelho interno.

## F. Nome da imagem

- **Confirmar:** `podman manifest inspect <imagem completa>` diz se a imagem e a etiqueta existem. Compara o nome com o do `docker-compose` ou da ferramenta (Grep). Um nome curto (`postgres:16`) sem registo obriga o Podman a perguntar de que registo, e sem terminal interativo (uma ferramenta, um script) falha.
- **O utilizador faz:** usa o nome completo (`docker.io/library/postgres:16`), ou define `unqualified-search-registries` no `registries.conf`. Para uma imagem privada, `podman login <registo>`.

## G. Máquina ou motor parado

- **Confirmar:** `podman machine list` (a coluna do estado) e `podman system connection list`; `docker info` no Docker.
- **O utilizador faz:** `podman machine start`, ou abre o Docker Desktop. Tu não.

## H. Sem espaço

- **Confirmar:** `podman machine ssh "df -h /var"` e `podman system df`.
- **O utilizador faz:** liberta espaço (`podman image prune`, a decisão e o comando são dele), ou aumenta o disco da máquina parada (`podman machine set --disk-size <GB>`).

## I. Arquitetura

- **Confirmar:** `uname -m` no computador e na máquina; `podman manifest inspect <imagem>` lista as plataformas.
- **O utilizador faz:** outra imagem ou etiqueta com a plataforma certa, ou `--platform`.

## J. Preso ou lento, sem erro claro

- **Causas habituais:** o proxy corta downloads grandes (as camadas maiores são centenas de MB) por tempo ou por tamanho; um antivírus ou um filtro analisa o ficheiro todo antes de o largar; ligação lenta.
- **Confirmar:** o `curl` ao registo responde depressa (o caminho está aberto) mas a camada grande falha sempre no mesmo ponto: limite do proxy. Pergunta se o mesmo acontece com uma imagem pequena (se descarrega, o caminho funciona e o problema é o tamanho).
- **O utilizador faz:** volta a tentar (as camadas já descarregadas costumam ser reaproveitadas), tenta fora das horas de ponta, pergunta à equipa de rede o limite, ou obtém a imagem de outro modo (um espelho interno, ou um ficheiro `.tar` e `podman load`, que corre ele).
