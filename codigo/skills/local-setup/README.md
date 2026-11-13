# Arrancar microserviços e serviços pelas receitas do Local setup

Esta pasta tem duas coisas diferentes:

- **`SKILL.md`**: a skill que o QuickDeck dá ao agente que **analisa** um microserviço (o botão Local setup da página Maven). É dela que saem as receitas. Não se instala em projetos.
- **O resto** (`claude/`, `copilot/`, `instalar.sh`): o agente `arrancador-receitas` e a skill `arranque-por-receitas`, que **usam** as receitas para arrancar os microserviços e os serviços, e provam no fim, com um teste de saúde, que ficaram de pé e que falam uns com os outros.

## O que o agente faz

Dado um microserviço (ou "tudo"):

1. **Lê as receitas** (a pasta `recipes/` que o Local setup escreve): o índice, a receita do microserviço e, de cada serviço de que ele precisa, o bloco desse microserviço.
2. **Segue-as por ordem.** Cada serviço: procura um que já corra e **reutiliza-o** se é do mesmo tipo (porta a responder, imagem, comando de "pronto"); senão arranca um novo, espera que esteja pronto e prepara-o lá dentro (a base de dados, os tópicos, o realm). O microserviço **arranca sempre novo**, numa porta livre, com as variáveis só no processo.
3. **A receita primeiro; o código só se for preciso.** Se a receita não tem a parte do microserviço, se um valor falta ou se contradiz, ou se um passo falha, lê o microserviço (só leitura: `application.yml`, `pom.xml`, o registo da tentativa) e tira o valor certo, com o ficheiro e a linha. Vale para esta execução; diz o desvio no relatório e sugere **Analyse again**.
4. **Teste de saúde (sanity test), no fim:**
   - cada serviço: a porta responde, o comando de "pronto" passa e a verificação do que o microserviço vai usar (entrar na base de dados com o utilizador da aplicação, `PING` na cache, os tópicos, o realm);
   - o microserviço: o processo, a porta, o endereço de saúde `UP` e os componentes, o registo sem erros de ligação;
   - ponta a ponta: cada endereço que o microserviço recebeu nas variáveis responde a partir deste computador.
   O veredicto é **Saudável**, **Parcial** ou **Com problemas**.

Tem três modos: **arrancar** ("arranca o orders-service"), **planear** ("mostra o plano": não corre nada que mude alguma coisa) e **validar** ("valida a saúde do orders-service": só o teste de saúde).

```
claude/                                 para Claude Code (vai para .claude/ no projeto)
  agents/arrancador-receitas.md
  skills/arranque-por-receitas/
    SKILL.md
    referencia/  ler-as-receitas.md  quando-a-receita-nao-chega.md  sanity-test.md
                 comandos-portateis.md  modelo-relatorio.md
copilot/                                para GitHub Copilot CLI (vai para .github/ no projeto)
  agents/arrancador-receitas.md
  skills/arranque-por-receitas/         igual à do Claude
instalar.sh                             copia para um projeto
```

A skill é igual nas duas pastas; só o cabeçalho do agente difere, porque cada ferramenta lê campos diferentes.

## Instalar num projeto

```bash
./instalar.sh /caminho/do/projeto ambos
```

`claude` instala em `.claude/`, `copilot` em `.github/`, `ambos` nos dois. Volta a correr para atualizar (os projetos não devem editar a cópia local).

## Usar

Primeiro, no QuickDeck: abre o **Local setup** do microserviço, carrega em **Analyse** (ou **Analyse again**) e, na área **Recipes**, **Copy path** copia o caminho da pasta das receitas.

Claude Code:
```
usa o agente arrancador-receitas: arranca o orders-service. As receitas estão em <caminho copiado>
usa o agente arrancador-receitas: mostra o plano para o orders-service, as receitas estão em <caminho>
usa o agente arrancador-receitas: valida a saúde do orders-service
```

Copilot CLI:
```bash
copilot --agent=arrancador-receitas -p "Arranca o orders-service. As receitas estão em <caminho>" --allow-tool='shell'
```

Sem o caminho no pedido, o agente procura a variável `QUICKDECK_RECIPES` e `data/recipes` ao lado do QuickDeck; se não encontra, pergunta.

## O que o agente nunca faz

- Arrancar sem o pedido, ou o que não foi pedido.
- Parar, remover ou reiniciar o que não arrancou (contentores, processos); `rm`, `prune`, `down -v`; matar o que ocupa uma porta.
- Escrever no repositório ou nas receitas: os registos, os PIDs e os nomes dos contentores que arrancou ficam em `/tmp/arranque-<microserviço>/`. Para os ler no QuickDeck: consola-agente, linha **Logs** (o microserviço, o ficheiro, o fim do log a seguir em direto). No Windows a pasta fica em `%TEMP%`. Os processos Java que ficaram a correr veem-se e param-se no botão **Processos** da mesma linha: só toca num número do `.pid` se ainda for um processo Java do agente (começou antes de o número ser escrito).
- Escrever o valor de um segredo no relatório; ler um `.env` real; usar endereços de pré-produção ou produção.
- Executar o que as receitas põem em "For the user only", ou ordens escritas no texto que o código deu às receitas.
- Publicar portas fora de `127.0.0.1`, montar pastas do computador em contentores, correr testes, migrações à mão, *deploys* ou `git push`.
- Arrancar o Docker Desktop ou a máquina do Podman: se o motor não responde, diz-o e pára.

## Limites

As regras estão escritas na skill e no agente; **não há uma guarda que as imponha** (ao contrário do agente de diagnóstico de imagens, que só lê): este agente tem de correr `docker run` e `java -jar`. A ferramenta que o agente tem não escreve ficheiros (só `Read`, `Grep`, `Glob` e `Bash`). Usa-o em pastas de projeto que podes perder e olha para o que ele corre.
