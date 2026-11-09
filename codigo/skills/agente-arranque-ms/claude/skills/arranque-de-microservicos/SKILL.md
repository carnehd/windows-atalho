---
name: arranque-de-microservicos
description: Analisa um projeto (um microserviço Spring Boot, ou um repositório com vários) e descobre o que é preciso para o arrancar em local - dependências (base de dados, cache, mensagens, identidade, outros serviços), portas, variáveis e ordem - lendo o README, os ficheiros de ambiente, o docker-compose, o application.yml e os scripts. Devolve um plano com os comandos exatos (Docker ou Podman, Maven ou Gradle, Spring Boot) e, só quando o utilizador o pedir, arranca-o e verifica que responde. Usa para "como arranco este serviço?", "o que precisa para correr em local?", "arranca o serviço e as dependências".
---

# Arranque de microserviços

Objetivo: dado um projeto, descobrir o que é preciso para o pôr a correr neste computador e entregar um plano com os comandos exatos: o que arrancar primeiro, com que variáveis, em que portas, e como confirmar que está de pé. Quando o utilizador o pedir, executar o plano.

## Dois modos

- **Analisar** (por omissão). Só leitura: lês, deduzes, entregas o plano. Nada arranca, nada é criado.
- **Arrancar**. Só quando o utilizador o pede nesta conversa, por palavras como "arranca", "sobe", "levanta", "executa o plano", e diz o quê: tudo, só as dependências, ou só o serviço. "Analisa", "diz-me como" e "o que é preciso" são pedidos de análise. Um "sim" a uma pergunta tua ("Arranco?") conta. Na dúvida, estás em modo Analisar e perguntas.

Princípios dos dois modos:
- **Evidência.** Cada dependência, porta e variável cita o ficheiro e a linha onde a viste (`docker-compose.yaml:14`). O que não está escrito em lado nenhum vai para "Dúvidas", com a pergunta que resolve. Nunca preenches um buraco com um palpite.
- **Segredos.** Nunca escreves o valor de uma palavra-passe, token ou chave, nem no relatório nem num comando que mostres. Dizes o nome da variável e onde se define. Um `.env` real só se lê para saber que nomes existem. Se para arrancar falta um segredo, pedes ao utilizador; não inventas um nem usas um que viste noutro ficheiro sem o dizer.
- **Só local.** Usas valores de ambiente local ou de desenvolvimento. Se a configuração aponta para endereços de ambientes partilhados (pré-produção, produção), assinalas e não os usas.
- **O que não é teu não se toca.** Contentores e processos que já corriam antes de tu chegares ficam como estão.
- **Nada que possa ficar preso.** Para analisar não precisas do motor de contentores nem de rede: não os consultes (um Docker bloqueado não responde nunca e prende-te). Tudo o que correres e possa não responder leva o limite de tempo de `referencia/receitas-de-comandos.md`; se estourar, dizes que não responde e segues.

## 1. Reconhecer o projeto

Lista a raiz e procura o que identifica o tipo (`pom.xml`, `mvnw`, `build.gradle(.kts)`, `docker-compose*.yml`, `Dockerfile*`, `Makefile`, `scripts/`). Num repositório com vários módulos Maven, o microserviço arranca-se a partir do módulo da aplicação (o que tem o `@SpringBootApplication` e o `application.yml`); diz qual é. Num repositório com vários microserviços, trata cada um e depois a ordem entre eles.

## 2. Ler, por esta ordem

Ver `referencia/onde-procurar.md` para o que tirar de cada ficheiro.

1. **README e documentos de ambiente local** (`README*`, `AMBIENTE_LOCAL.md`, `CONTRIBUTING.md`, `docs/`): os passos oficiais, pré-requisitos, avisos. É o ponto de partida, não a verdade final.
2. **Contentores**: `docker-compose*.yml`, `Dockerfile*`, `docker/`. Dão as dependências locais, com imagens, portas, variáveis e *healthchecks*.
3. **Configuração da aplicação**: `src/main/resources/application*.yml|.yaml|.properties`. Dão `server.port`, a porta de gestão, a base de dados, a cache, as mensagens, a identidade, os endereços de outros serviços e todas as variáveis `${NOME:valor-por-omissão}`.
4. **Construção**: `pom.xml` ou `build.gradle`, o *wrapper*, `.sdkmanrc` / `.tool-versions`: versão de Java e ferramenta.
5. **Variáveis**: `.env.example`, `.env.sample`, `env/`.
6. **Atalhos**: `Makefile`, `scripts/`, `package.json`.
7. **Cluster** (`k8s/`, `helm/`, `values-*.yaml`) só para perceber que variáveis o serviço recebe e que nomes têm; nunca os valores de ambientes partilhados.
8. **Código**, só para o que a configuração não mostra: `@FeignClient`, `@KafkaListener`, `@RabbitListener`, clientes REST com endereço base.

Quando dois ficheiros se contradizem (o README diz uma porta e o compose outra), vale o que é executado (compose, `application.yml`) e a divergência vai para as Dúvidas.

## 3. Dependências

Para cada uma: o quê (PostgreSQL, Redis, emulador Pub/Sub, Keycloak, outro microserviço...), a evidência, como se arranca em local (serviço do compose, ou `docker run` / `podman run` com imagem, porta e variáveis), e a classe:
- **Obrigatória para arrancar**: sem ela a aplicação falha no arranque (base de dados com migrações, por exemplo).
- **Necessária para uma funcionalidade**: arranca sem ela, mas uma parte não funciona (um serviço que só se chama num endpoint).
- **Opcional**: observabilidade, painéis.

## 4. Portas e variáveis

- **Portas**: da aplicação, de gestão (*actuator*), de *debug*, e de cada dependência. Confirma, só a ler, se estão livres: `lsof -nP -iTCP:<porta> -sTCP:LISTEN`. Uma porta ocupada vai para o relatório com quem a ocupa; não se mata nada.
- **Variáveis**: cada `${NOME:valor}` da configuração. Sem valor por omissão: obrigatória, e diz de onde vem o valor (compose, `.env.example`, README) ou que falta. Marca as que são segredos.

## 5. O plano

Ordem: dependências primeiro, o microserviço depois; entre microserviços, primeiro os que os outros chamam. Cada passo traz o comando completo, copiável, a pasta onde se corre, e o que esperar quando correu bem (a linha do log, a resposta do *health*). Receitas em `referencia/receitas-de-comandos.md`. Termina com a verificação e com como parar o que o plano arrancou.

## 6. Relatório (modo Analisar)

Segue `referencia/modelo-relatorio.md`: resumo numa frase, dependências, portas, variáveis, comandos por ordem, verificação, como parar, dúvidas. Acaba com uma linha a perguntar o que arrancar, e como pedir ("arranca tudo", "só as dependências", "só o serviço").

## Modo Arrancar

Antes de começares, diz numa linha por item o que vais arrancar, com porta e ordem. Se o utilizador já disse claramente o quê, avança sem perguntar de novo. Se falta um segredo, pergunta antes.

1. **Motor de contentores.** Só agora o consultas: vê qual responde (`docker info` ou `podman info`) com o limite de tempo das receitas (o `timeout` não existe no macOS). Se nenhum responde, não o arranques nem o reinicies sozinho: diz ao utilizador.
2. **Ordem e espera.** Dependências primeiro. Antes de passar ao passo seguinte, espera que a anterior responda (*healthcheck* do compose, `pg_isready`, `redis-cli ping`, porta aberta). Limite: 60 s por dependência, 120 s para o microserviço. **Sem ciclos de `sleep`**: o Claude Code bloqueia-os em primeiro plano. Espera com `docker compose up -d --wait`, com `curl --retry` (receitas, secção 5), ou repetindo a verificação em chamadas separadas.
3. **Contentores.** Só os serviços necessários (`docker compose up -d <serviços>`, não um `up` de tudo se não foi pedido). Nomes com o prefixo do projeto. Se um contentor com esse nome já corre, reutilizas e dizes; se existe parado, `start` e dizes. Nunca `down -v`, `rm`, `prune`, nem apagar volumes ou imagens.
4. **Portas ocupadas.** Não matas nada. Dizes quem ocupa, e propões outra porta (`SERVER_PORT`) ou perguntas.
5. **O microserviço.** Em segundo plano, com o registo num ficheiro fora do repositório, sempre na mesma pasta (`/tmp/arranque-<projeto>/<serviço>.log`; no Windows `$env:TEMP\arranque-<projeto>\`), e o PID guardado ao lado (`<serviço>.pid`). `<projeto>` é o nome da pasta do projeto. As variáveis vão na própria linha de comando; **nunca escreves num ficheiro do projeto**.
6. **Se falhar.** Lês o fim do registo e dizes a causa provável (porta ocupada, base de dados inacessível, variável em falta). Uma segunda tentativa só se a causa for clara e a correção estiver dentro destas regras; senão, paras e dizes.
7. **No fim**, uma tabela do que arrancou: serviço, porta, PID ou contentor, onde está o registo, como parar.
8. **Parar** só quando o utilizador pedir, e só o que arrancaste tu: os PIDs e os contentores da tabela desta conversa; numa conversa nova, os PIDs que estão em `/tmp/arranque-<projeto>/*.pid` (se não souberes o projeto, `ls /tmp/arranque-*/*.pid` e confirmas a quem pertence cada um), depois de confirmares que o processo ainda é o mesmo (`ps -p <pid> -o command=` mostra o comando que arrancaste) e que a porta é a dele. Um PID que já não corresponde não se toca. O que já corria antes não se pára, nem se procura por nome (`pkill -f`): só por PID.

Nunca, em nenhum modo: correr testes, migrações à mão, *deploys*, `git push`, nem alterar ficheiros do projeto.
