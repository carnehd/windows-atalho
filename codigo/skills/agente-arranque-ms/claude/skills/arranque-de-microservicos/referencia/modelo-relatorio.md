# Modelo do relatório (modo Analisar)

Curto, em tabelas, sem floreados. Cada linha cita o ficheiro e a linha onde o dado foi visto. Nenhum valor de segredo.

````markdown
# Arranque de <nome-do-serviço>

**Resumo:** <uma frase: o que é, e o que precisa para arrancar. Ex.: "Spring Boot 3 (Java 21), precisa de PostgreSQL e Redis; sobe na 8081.">

**Pasta:** `<módulo ou pasta onde se corre>` · **Ferramenta:** Maven (`./mvnw`) · **Java:** 21 (`pom.xml:31`)

## Dependências

| Dependência | Classe | Evidência | Como arrancar em local |
|---|---|---|---|
| PostgreSQL 16, base `orders` | obrigatória | `application.yml:9`, `docker-compose.yaml:3` | serviço `postgres` do compose |
| Redis | necessária (cache de sessões) | `application.yml:14` | serviço `redis` do compose |
| Keycloak | opcional em local (`security.enabled=false` no perfil `dev`) | `application-dev.yaml:4` | não é preciso |

## Portas

| O quê | Porta | Livre? | Evidência |
|---|---|---|---|
| Aplicação | 8081 | sim | `application.yml:2` |
| Gestão (*actuator*) | 9091 | sim | `application.yml:21` |
| PostgreSQL | 5432 | **ocupada** por `<processo>` | `docker-compose.yaml:7` |

## Variáveis

| Nome | Valor por omissão | Obrigatória | Origem do valor |
|---|---|---|---|
| `DB_HOST` | `localhost` | não | `application.yml:9` |
| `DB_PASSWORD` | (nenhum) | **sim, segredo** | falta: o utilizador define-a |

## Comandos, por ordem

1. Dependências (na pasta `<...>`):
   ```bash
   docker compose up -d postgres redis
   ```
   Pronto quando: `docker compose ps` mostra `healthy` nos dois.
2. O serviço (na pasta `<...>`):
   ```bash
   DB_PASSWORD=<a tua> ./mvnw spring-boot:run
   ```
   Pronto quando o registo mostra `Started OrdersApplication in N seconds` e `curl -fsS http://localhost:9091/actuator/health` responde `UP`.

## Verificar

```bash
curl -fsS http://localhost:9091/actuator/health
```

## Parar

```bash
# Ctrl-C no terminal do serviço
docker compose stop postgres redis
```

## Dúvidas

- <o que nenhum ficheiro diz, e a pergunta que o resolve>
- <divergências: o README diz 8080, o `application.yml` diz 8081; valeu o `application.yml`>

---
Arranco? Diz **"arranca tudo"**, **"só as dependências"** ou **"só o serviço"**.
````

## Vários microserviços

Uma secção `## Ordem entre serviços` antes dos comandos: uma linha por serviço com quem o chama e a porta, e a ordem de arranque. Depois, um bloco de comandos por serviço, com a sua pasta e a sua porta própria (sem duas iguais).

## Modo Arrancar: a tabela final

```markdown
| Serviço | Porta | PID / contentor | Registo | Parar |
|---|---|---|---|---|
| postgres | 5432 | `orders-postgres` | `docker logs orders-postgres` | `docker stop orders-postgres` |
| orders-service | 8081 | PID 48213 | `/tmp/arranque-orders/orders-service.log` | `kill 48213` |
```

E uma linha: o que já corria antes e ficou intacto.
