# Agente de arranque de microserviços

Agente `arrancador-ms` + skill `arranque-de-microservicos`. Genéricos: servem para qualquer microserviço (pensado para Spring Boot com Maven ou Gradle, e dependências em Docker ou Podman).

Analisa o projeto, procura nos ficheiros de ambiente, no README, no docker-compose e no `application.yml` o que o serviço precisa para arrancar (base de dados, cache, mensagens, identidade, outros serviços), e devolve o que é preciso fazer, com os comandos: arrancar as dependências, arrancar o Spring Boot, portas, variáveis, como confirmar que está de pé e como parar. **Se lhe pedires, arranca-os.**

```
claude/                              para Claude Code (vai para .claude/ no projeto)
  agents/arrancador-ms.md
  skills/arranque-de-microservicos/
copilot/                             para GitHub Copilot CLI (vai para .github/ no projeto)
  agents/arrancador-ms.md
  skills/arranque-de-microservicos/
instalar.sh                          copia para um projeto
```

A skill é igual nas duas pastas; só o cabeçalho do agente difere, porque cada ferramenta lê campos diferentes.

## Instalar num projeto

```bash
./instalar.sh /caminho/do/projeto ambos
```

`claude` instala em `.claude/`, `copilot` em `.github/`, `ambos` nos dois.

## Usar

Claude Code:
```
usa o agente arrancador-ms: o que é preciso para arrancar este serviço?
```

Copilot CLI:
```bash
copilot --agent=arrancador-ms -p "O que é preciso para arrancar este serviço em local? Dá-me os comandos."
```

O agente lê o projeto, não escreve nada nele, e entrega um plano. Para o executar, diz-lhe o quê, na mesma conversa:

```
arranca tudo            # as dependências e o serviço
só as dependências
só o serviço
arranca estes dois serviços: <pasta-a> <pasta-b>    # primeiro o que o outro chama
```

Na Copilot CLI, em modo não interativo (`-p`), o agente só consegue arrancar se o pedido já o disser (`... e arranca tudo`) e se as ferramentas de shell estiverem permitidas (`--allow-tool='shell'`).

## O que o agente nunca faz

- Arrancar sem o utilizador o pedir.
- Escrever o valor de um segredo, ou inventar um que falta (pergunta).
- Escrever em ficheiros do projeto: variáveis na linha de comando, registos e PIDs fora do repositório.
- Matar o que já corria, ou o que ocupa uma porta; apagar contentores, volumes ou imagens.
- Usar endereços de pré-produção ou produção.
- Correr testes, migrações à mão, *deploys* ou `git push`.

## Atualizar

Edita aqui, nas duas pastas, e volta a correr `instalar.sh` em cada projeto. Os projetos não devem editar a cópia local.
