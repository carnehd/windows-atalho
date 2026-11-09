# Agente de diagnóstico do download de imagens

Agente `diagnostico-imagens` + skill `diagnostico-de-download-de-imagens`. Genéricos: servem para qualquer imagem de contentores (Podman ou Docker), pensados para o caso em que um proxy de empresa atrapalha o download (Redis, Pub/Sub, PostgreSQL, Keycloak...).

Descobre **porque** o download falha ou fica preso (certificado desconhecido, a máquina do Podman sem proxy, DNS, registo bloqueado, limite de pedidos, nome curto sem registo, falta de espaço, arquitetura) e entrega a causa provável e os passos que **tu** corres. **Só diagnostica: nunca altera a máquina.**

```
claude/                              para Claude Code (vai para .claude/ no projeto)
  agents/diagnostico-imagens.md
  hooks/so-leitura-imagens.sh        a guarda: só deixa passar comandos de leitura
  settings-guarda.json               a entrada que liga a guarda no .claude/settings.json
  skills/diagnostico-de-download-de-imagens/
copilot/                             para GitHub Copilot CLI (vai para .github/ no projeto)
  agents/diagnostico-imagens.md
  skills/diagnostico-de-download-de-imagens/
instalar.sh                          copia para um projeto
```

A skill é igual nas duas pastas; o cabeçalho do agente difere, porque cada ferramenta lê campos diferentes.

## Instalar num projeto

```bash
./instalar.sh /caminho/do/projeto ambos
```

`claude` instala em `.claude/` e liga a guarda no `.claude/settings.json` do projeto (cria o ficheiro, ou junta-lhe a entrada; sem `python3` mostra o que juntar), `copilot` em `.github/`, `ambos` nos dois. Num Windows, corre o `instalar.sh` no Git Bash, ou copia as pastas à mão.

## Usar

Primeiro corre o download num terminal e guarda o erro completo (as últimas 30 linhas):

```powershell
podman pull --log-level=debug docker.io/library/redis:7-alpine
```

Claude Code:
```
usa o agente diagnostico-imagens: o pull do redis falha atrás do proxy. O erro é este: <cola o erro>
```

Copilot CLI, em modo interativo (sem `-p`), para aprovares cada comando:
```bash
copilot --agent=diagnostico-imagens --deny-tool=write
```

O agente pergunta o que lhe falta, mede só a ler (do computador e de dentro da máquina do Podman) e devolve o relatório: causa provável, o que viu, os comandos para correres tu, como confirmar. Depois do que corrigires, voltas a correr o download e colas o resultado.

## O que o agente nunca faz

- Alterar a máquina, mesmo que lho peças: descarregar (`pull`, `run`, `load`), instalar, copiar certificados, editar `registries.conf` ou variáveis, arrancar, parar ou reiniciar a máquina do Podman, apagar, escrever ficheiros. Dá-te os comandos para correres tu.
- Ler ou repetir segredos: `~/.docker/config.json`, `auth.json`, `.netrc`, chaves, `.env`, utilizador e palavra-passe de um proxy.
- Dar por certo o que não mediu.

## Como é garantido

- **Claude Code.** O agente só tem as ferramentas `Read`, `Grep`, `Glob` e `Bash` (sem `Write` nem `Edit`), e a guarda `.claude/hooks/so-leitura-imagens.sh` corre antes de cada uma, ligada no `.claude/settings.json` do projeto. Só atua quando quem pede é este agente (`agent_type`): as tuas outras sessões não são afetadas. Só deixa passar os comandos de `referencia/comandos-de-leitura.md` (estado do motor, `curl` com limite de tempo a registos, `nslookup`, `manifest inspect`, alguns `cat` e `ls` dentro da máquina do Podman) e bloqueia o resto: encadear, redirecionar, `$`, substituições, `pull`, `rm`, `machine start`, `sudo`... e a leitura de ficheiros de credenciais. Em caso de dúvida, bloqueia. O agente recebe o motivo e pede-te que corras tu.
- **Copilot CLI.** Não tem guarda: a barreira é o que o agente se impõe e a tua aprovação a cada comando. Usa o modo interativo, não passes `--allow-tool='shell'`, e recusa tudo o que altere.

Limites: a guarda é uma lista, não uma prova; só vigia o que passa pelo agente (o que corres tu, é contigo). Testada no Claude Code 2.1.319, onde os *hooks* no cabeçalho do agente não correm e os do `settings.json` sim; se apagares o ficheiro da guarda, tira também a entrada do `settings.json` (sem ele, o `bash` falha e bloqueia). Precisa do `bash` (no Windows, o Git Bash, que o Claude Code já exige). O que o agente lê vai para o fornecedor dele, com a tua conta: por isso não lê credenciais.

## Atualizar

Edita aqui, nas duas pastas, e volta a correr `instalar.sh` em cada projeto. Os projetos não devem editar a cópia local.
