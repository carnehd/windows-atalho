# Quando a receita não chega: olhar para o microserviço

A receita é o ponto de partida. Quando falta um valor, dois se contradizem ou um passo falha, o valor certo está no microserviço. **Só lês**: não escreves no repositório nem nas receitas.

## Onde está

A tabela **Values** da receita do microserviço tem a linha **Folder**: o caminho absoluto. Se a pasta não existe neste computador, não adivinhes: pergunta ao utilizador onde está.

## O que ler, para cada valor em falta

| O que falta | Onde procurar | O que tirar |
|---|---|---|
| Porta da aplicação | `src/main/resources/application*.yml`, `.yaml`, `.properties` | `server.port` (um `${SERVER_PORT:8080}` quer dizer 8080 por omissão); sem nada, 8080. |
| Porta de gestão | os mesmos | `management.server.port`; sem nada, a da aplicação. |
| Endereço de saúde | os mesmos | `management.endpoints.web.base-path` (por omissão `/actuator`) e `management.endpoint.health`; com o *starter* do *actuator* no `pom.xml`/`build.gradle`, `/actuator/health`. Sem *actuator*: a porta a escutar e a linha `Started ... in N seconds` no registo. |
| Perfil para local | `application-local.yml`, `application-dev.yml`, `spring.profiles.active` | o nome do perfil que existe e é de uso local. |
| Variáveis | todos os `${NOME:valor}` dos ficheiros acima | os que **não têm valor por omissão** têm de ser dados. Compara com a tabela da receita: o que falta, e de onde o valor vem (a tabela de outro serviço da receita, o `.env.example`). |
| O jar | depois de construir: `target/*.jar` (Maven) ou `build/libs/*.jar` (Gradle) | o executável: não o `*-sources.jar`, `*-javadoc.jar`, `*-plain.jar`, nem `*.jar.original`. |
| Versão de Java | `pom.xml` (`java.version`, `maven.compiler.release`), `build.gradle` (`sourceCompatibility`, *toolchain*), `.sdkmanrc`, `.tool-versions` | a versão pedida; diz se a do computador é outra (`java -version`). |
| Nomes de uma base de dados, utilizador, tópico, realm | `application*.yml`, as migrações (`db/changelog`, `db/migration`), o código dos clientes | os nomes que a aplicação usa. Se são diferentes dos que a receita preparou, vale a configuração (com a evidência): ajustas os valores do passo 4 e dizes o desvio. |
| Endereço de outro microserviço | `application*.yml` (`...base-url`, `...url`), `@FeignClient` | a variável e o nome do outro microserviço; a porta é a da instância nova que arrancaste. |

Palavras-passe e valores secretos: **os que estão como valor por omissão da configuração para uso local** (por exemplo `${DB_PASSWORD:postgres}`) são os da configuração e podes usá-los. Um `.env` real, ou uma palavra-passe que só existe num ficheiro de credenciais: nunca. Pergunta ao utilizador.

## Do registo para a causa

Quando um passo falhou ou o microserviço não chega a estar de pé, o fim do registo (`tail -n 60 /tmp/arranque-<ms>/<ms>.log`) costuma dizer porquê:

| No registo | Causa provável | O que verificar no código |
|---|---|---|
| `Port <n> was already in use` | Porta ocupada | escolhe a seguinte livre (secção 3.2 da skill) |
| `Connection refused`, `Unable to obtain connection` | O serviço não está de pé, ou o endereço é outro | o endereço na variável contra a porta em que o serviço ficou |
| `Could not resolve placeholder '<NOME>'` | Falta uma variável sem valor por omissão | o `${NOME}` em `application*.yml` |
| `password authentication failed`, `database "<x>" does not exist` | Utilizador, palavra-passe ou base diferentes | o `spring.datasource.*` e as migrações |
| `UnsupportedClassVersionError`, `release version <n> not supported` | Versão de Java diferente da pedida | `java.version` no `pom.xml` |
| `NOAUTH`, `WRONGPASS` | A cache pede palavra-passe | `spring.data.redis.password` / `REDIS_PASSWORD` |
| `UNAVAILABLE`, `Connection refused: localhost:8085` (mensagens) | O emulador não responde, ou falta `PUBSUB_EMULATOR_HOST` | `spring.cloud.gcp.pubsub.emulator-host` |

## Limites

- **Duas correções por passo.** Cada uma com o valor, a evidência (`ficheiro:linha`) e o resultado. À terceira, pára e pergunta ao utilizador.
- O valor certo vale para esta execução. Vai para a tabela **Desvios da receita** do relatório:

| Passo | A receita dizia | Usei | Evidência |
|---|---|---|---|
| porta de gestão | (sem valor) | 9107 | `application.yml:22` |

- No fim, sugere ao utilizador **Analyse again** no Local setup: a receita fica certa para a próxima vez.
- Nunca uses um endereço que aponte para um ambiente partilhado (pré-produção, produção). Assinala-o e não o uses.
