# Receitas de comandos

As imagens, versões e valores que o projeto já traz (compose, README, `application.yml`) mandam sobre estas receitas. Estas servem quando o projeto só diz o que precisa, não como o levantar.

## 1. O motor de contentores

Só no modo Arrancar. Um motor bloqueado não responde nunca, por isso corre sempre com limite de tempo. O `timeout` não existe no macOS, e o `alarm` do Perl não pára um programa em Go (como o `docker`, que ignora o sinal); este atalho funciona nos dois:

```bash
limite() { perl -e '$t=shift; $p=fork; if(!$p){exec @ARGV; exit 127} $SIG{ALRM}=sub{kill "KILL",$p; exit 124}; alarm $t; waitpid $p,0; exit($?>>8)' "$@"; }

limite 8 docker info --format '{{.ServerVersion}}'      # Docker
limite 8 podman info --format '{{.Host.Os}}'            # Podman
# código de saída 124: o motor não responde
```

PowerShell: `$j = Start-Job { docker info }; if (Wait-Job $j -Timeout 8) { Receive-Job $j } else { Stop-Job $j; 'não responde' }`.

Usa o que responder; os comandos são os mesmos (`podman` no lugar de `docker`). Se nenhum responde, não arranques nem reinicies o Docker Desktop nem a máquina do Podman sozinho: diz ao utilizador. Isto vale para qualquer comando que possa prender (`docker ps`, `docker compose ps`, `curl` sem `-m`).

Se a aplicação correr dentro de um contentor e chamar uma dependência que está no computador, o endereço é `host.docker.internal` (Docker) ou `host.containers.internal` (Podman), não `localhost`.

## 2. Dependências em contentor (padrões)

Nomes `<projeto>-<dependência>`, para as reconheceres e não colidirem com outros.

| Dependência | Comando | Porta | Está pronto quando |
|---|---|---|---|
| PostgreSQL | `docker run -d --name <projeto>-postgres -e POSTGRES_DB=<base> -e POSTGRES_USER=<utilizador> -e POSTGRES_PASSWORD=<definida pelo utilizador> -p 5432:5432 postgres:16` | 5432 | `docker exec <projeto>-postgres pg_isready -U <utilizador>` |
| Redis | `docker run -d --name <projeto>-redis -p 6379:6379 redis:7` | 6379 | `docker exec <projeto>-redis redis-cli ping` responde `PONG` |
| Emulador Pub/Sub | `docker run -d --name <projeto>-pubsub -p 8085:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators gcloud beta emulators pubsub start --host-port=0.0.0.0:8085` | 8085 | a porta abre; a aplicação usa `PUBSUB_EMULATOR_HOST=localhost:8085` |
| Keycloak | `docker run -d --name <projeto>-keycloak -p 8180:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=<admin> -e KC_BOOTSTRAP_ADMIN_PASSWORD=<definida pelo utilizador> quay.io/keycloak/keycloak start-dev` | 8180 (a 8080 costuma ser da aplicação) | `curl -fsS http://localhost:8180/realms/master` |
| RabbitMQ | `docker run -d --name <projeto>-rabbit -p 5672:5672 -p 15672:15672 rabbitmq:3-management` | 5672, 15672 | `docker exec <projeto>-rabbit rabbitmq-diagnostics -q ping` |
| Kafka | `docker run -d --name <projeto>-kafka -p 9092:9092 apache/kafka` | 9092 | a porta abre |
| Grafana, Loki, Tempo, Prometheus (observabilidade) | `docker run -d --name <projeto>-lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 grafana/otel-lgtm` | 3000, 4317, 4318 | `curl -fsS http://localhost:3000/api/health` |

Palavras-passe, utilizadores de administração e valores semelhantes: os do projeto, se o projeto os der para uso local; senão, **pergunta** ao utilizador. Nunca os escrevas no relatório.

Com `docker-compose`:

```bash
docker compose -f <ficheiro> config --services          # que serviços existem
docker compose -f <ficheiro> up -d --wait <serviço> [<serviço>]   # --wait espera pelo healthcheck
docker compose -f <ficheiro> ps
docker compose -f <ficheiro> logs --tail 50 <serviço>
```

Um serviço do compose com `profiles:` só sobe com `--profile <nome>`. Um com `depends_on: condition: service_healthy` espera pelo *healthcheck* da dependência.

## 3. O microserviço Spring Boot

Maven (preferir o *wrapper* do projeto, `./mvnw`; no Windows, `mvnw.cmd`):

```bash
./mvnw spring-boot:run
./mvnw -pl <módulo-da-aplicação> -am spring-boot:run                    # vários módulos
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev                   # um perfil
./mvnw spring-boot:run -Dspring-boot.run.arguments="--server.port=8081" # outra porta
./mvnw -DskipTests package && java -jar <módulo>/target/<nome>.jar      # pelo jar
```

Gradle:

```bash
./gradlew bootRun
./gradlew bootRun --args='--server.port=8081 --spring.profiles.active=dev'
```

Variáveis de ambiente, na própria linha, sem escrever em ficheiros:

```bash
SERVER_PORT=8081 DB_HOST=localhost REDIS_HOST=localhost ./mvnw spring-boot:run
```

*Debug* (a porta que o IDE usa, por omissão 5005):

```bash
./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
```

Java: se o projeto pede uma versão e a do computador é outra, diz-o; se há `.sdkmanrc`, `sdk env` ajusta (só com pedido).

## 4. Em segundo plano, com registo e PID (modo Arrancar)

```bash
LOGS="/tmp/arranque-<projeto>"; mkdir -p "$LOGS"
nohup env SERVER_PORT=8081 ./mvnw spring-boot:run > "$LOGS/<serviço>.log" 2>&1 &
echo $! > "$LOGS/<serviço>.pid"
```

O registo e o PID ficam fora do repositório. Para ver: `tail -n 40 "$LOGS/<serviço>.log"`.

## 5. Esperar e verificar

```bash
# espera até 120 s sem `sleep` (o Claude Code bloqueia ciclos com sleep em primeiro plano): o curl repete sozinho
curl -fsS --retry 40 --retry-delay 3 --retry-connrefused --max-time 5 "http://localhost:<porta-de-gestão>/actuator/health"
lsof -nP -iTCP:<porta> -sTCP:LISTEN          # alguém escuta nesta porta? (repete em chamadas separadas)
```

Sem *actuator*: a porta a escutar e a linha `Started <Aplicação> in N seconds` no registo.

Se falhar, o fim do registo costuma dizer porquê:

| No registo | Causa provável |
|---|---|
| `Port <n> was already in use` | Porta ocupada: ver quem a ocupa, propor outra |
| `Connection refused`, `Connection to localhost:5432 refused`, `Unable to obtain connection` | A dependência não está de pé, ou o endereço é outro (dentro de um contentor, `localhost` é o próprio contentor) |
| `Could not resolve placeholder '<NOME>'` | Falta uma variável sem valor por omissão |
| `password authentication failed`, `FATAL: database "<x>" does not exist` | Utilizador, palavra-passe ou nome da base de dados diferentes dos da configuração |
| `UnsupportedClassVersionError`, `release version <n> not supported` | Versão de Java diferente da que o projeto pede |

## 6. Parar (só o que o plano arrancou)

```bash
kill "$(cat "$LOGS/<serviço>.pid")"; pkill -TERM -P "$(cat "$LOGS/<serviço>.pid")"
docker stop <projeto>-postgres <projeto>-redis
```

Depois do `kill`, confirma com `ps -p <pid>` numa chamada a seguir, sem ciclo de `sleep`; se ainda corre, repete o `kill -TERM`, e só com `kill -9` se continuar, dizendo-o.

`docker stop` pára; não apaga. Nunca `docker rm`, `docker compose down -v`, `docker system prune` ou `docker volume rm`: os dados da base de dados vivem nos volumes.

## 7. Windows (PowerShell)

```powershell
$env:SERVER_PORT = "8081"; .\mvnw.cmd spring-boot:run
Get-NetTCPConnection -LocalPort 8080 -State Listen          # quem escuta
Invoke-RestMethod http://localhost:8081/actuator/health
Start-Process -FilePath .\mvnw.cmd -ArgumentList "spring-boot:run" -RedirectStandardOutput "$env:TEMP\arranque-<projeto>\<serviço>.log" -PassThru
```
