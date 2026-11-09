# Onde procurar, e o que tirar de cada ficheiro

Lê só o que existir. Cada linha do relatório cita `ficheiro:linha`.

| Onde | O que diz | O que extrair |
|---|---|---|
| `README*`, `AMBIENTE_LOCAL.md`, `CONTRIBUTING.md`, `docs/` | Os passos oficiais, pré-requisitos, avisos | Comandos, versões, ordem, o que o autor diz que é preciso |
| `docker-compose*.yml`, `compose*.yaml`, `docker/` | As dependências em local | Serviços, imagens, portas (`host:contentor`), variáveis, `healthcheck`, `depends_on`, `profiles` |
| `Dockerfile*`, `Dockerfile.local` | Como a aplicação corre em contentor | `EXPOSE`, argumentos, variáveis de ambiente |
| `.env.example`, `.env.sample`, `env/*.env` | Os nomes das variáveis | Nomes e valores de exemplo. Um `.env` real: só os nomes, nunca os valores |
| `src/main/resources/application*.yml`, `.yaml`, `.properties` | A configuração da aplicação | `server.port`, `management.server.port`, `spring.datasource.*`, `spring.data.redis.*`, Kafka / RabbitMQ / Pub/Sub, endereços OAuth e Keycloak, endereços de outros serviços, cada `${NOME:valor}`, os perfis (`application-dev.yaml`) |
| `pom.xml`, `build.gradle(.kts)`, `mvnw`, `gradlew`, `.sdkmanrc`, `.tool-versions` | Versão de Java e ferramenta | `java.version`, plugins (spring-boot, Liquibase, Flyway), módulos, se há *wrapper* |
| `db/changelog/`, `db/migration/`, `init*.sql`, `docker/init-db.sql` | A base de dados e o esquema | Nome da base e do esquema, utilizadores a criar (os nomes; as palavras-passe nunca) |
| `Makefile`, `scripts/`, `package.json` (scripts) | Atalhos já prontos | Comandos de arranque, de preparação |
| `k8s/`, `helm/`, `values-*.yaml`, `templates/configmap.yaml` | As variáveis que o serviço recebe no cluster | Os nomes e a forma dos endereços. Nunca os valores de ambientes partilhados |
| `bruno/`, `*.http`, coleções Postman, `environments/` | O endereço base e a porta onde o serviço é chamado | `baseUrl` |
| `.github/workflows/`, `.gitlab-ci.yml` | Como o CI levanta as dependências (`services:`) | Imagens e variáveis que os testes usam |
| Código: `@FeignClient`, `@KafkaListener`, `@RabbitListener`, `@Value`, `@ConfigurationProperties`, clientes REST | Dependências que a configuração não mostra | Nome do serviço chamado, tópico ou fila |

## Pistas dentro do `application.yml`

| Chave | Dependência |
|---|---|
| `spring.datasource.url` (`jdbc:postgresql://`, `jdbc:mysql://`, `jdbc:h2:`) | Base de dados: qual, onde, que nome. `h2` em memória não precisa de nada |
| `spring.liquibase.*`, `spring.flyway.*` | Migrações no arranque: a base de dados tem de existir e responder antes |
| `spring.data.redis.*`, `spring.redis.*` | Redis |
| `spring.kafka.bootstrap-servers` | Kafka |
| `spring.rabbitmq.*` | RabbitMQ |
| `spring.cloud.gcp.pubsub.*`, `PUBSUB_EMULATOR_HOST` | Pub/Sub, e se há emulador |
| `spring.security.oauth2.*.issuer-uri`, `jwk-set-uri`, `keycloak*` | Identidade: o servidor tem de estar de pé e o *realm* existir |
| `management.otlp.*`, `otel.*`, `OTLP_ENDPOINT*` | Observabilidade: opcional, quase sempre |
| `*.base-url`, `*.url`, `feign.client.config.*` | Outros microserviços que este chama |
| `server.port`, `management.server.port` | As portas da aplicação |

## Quando os ficheiros não chegam

- A dependência aparece no código mas não na configuração: diz-o nas Dúvidas, com a classe.
- O README descreve um passo que nenhum ficheiro executável confirma: cita o README e assinala que não foi confirmado.
- Falta o valor de uma variável sem valor por omissão: é uma pergunta ao utilizador, não um palpite.
