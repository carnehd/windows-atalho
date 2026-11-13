# Comandos portáteis

Os que as receitas e o teste de saúde pedem, escritos para macOS e Linux (*shell* POSIX), com o equivalente em PowerShell onde difere. Os comandos das receitas ganham sobre estes: servem para o que a receita deixa por dizer.

## Limite de tempo

Um comando que pode não responder (o motor de contentores bloqueado, uma rede parada) prende-te para sempre. Leva sempre limite. O `timeout` não existe no macOS, e o `alarm` do Perl não pára um programa em Go (como o `docker`); este atalho fá-lo.

**Cada chamada da ferramenta Bash começa uma *shell* nova: uma função definida numa chamada não existe na seguinte.** Define o `limite` na mesma linha de comando em que o usas (`limite() {...}; limite 8 docker info`). Se um comando falha com `command not found: limite`, a causa é essa, não o motor: não concluas que o motor não responde sem o repetires com a função definida.

```bash
limite() { perl -e '$t=shift; $p=fork; if(!$p){exec @ARGV; exit 127} $SIG{ALRM}=sub{kill "KILL",$p; exit 124}; alarm $t; waitpid $p,0; exit($?>>8)' "$@"; }

limite 8 docker info --format '{{.ServerVersion}}'
limite 8 podman info --format '{{.Host.Os}}'
# código de saída 124: não responde
```

PowerShell: `$j = Start-Job { docker info }; if (Wait-Job $j -Timeout 8) { Receive-Job $j } else { Stop-Job $j; 'não responde' }`. Com `curl`, o próprio `-m <segundos>` chega.

## O motor

`docker info` e, se falhar, `podman info`. O que responder é o `<engine>`; os comandos são os mesmos. Se nenhum responde: não arranques o Docker Desktop nem a máquina do Podman (`podman machine start`): diz ao utilizador.

Se uma aplicação correr **dentro** de um contentor e chamar uma dependência que está no computador, o endereço é `host.docker.internal` (Docker) ou `host.containers.internal` (Podman), não `localhost`. Os microserviços das receitas correm no computador, por isso `localhost` serve.

## Uma porta responde?

```bash
nc -z -w 2 127.0.0.1 <porta> && echo responde || echo silenciosa      # macOS e Linux
lsof -nP -iTCP:<porta> -sTCP:LISTEN                                    # quem escuta (macOS e Linux)
```
```powershell
(Test-NetConnection 127.0.0.1 -Port <porta> -WarningAction SilentlyContinue).TcpTestSucceeded   # True: responde
Get-NetTCPConnection -LocalPort <porta> -State Listen                  # quem escuta
```

Que contentor tem a porta: `<engine> ps --format "{{.Names}} {{.Image}} {{.Ports}}"` e procurar `:<porta>->`.

## Esperar sem `sleep`

O Claude Code recusa `sleep` em primeiro plano e o comando inteiro falha. Esperas com o `curl` a repetir sozinho, ou repetindo a verificação em chamadas separadas:

```bash
# o microserviço: de 3 em 3 s, até 2 min
curl -fsS --retry 40 --retry-delay 3 --retry-connrefused --max-time 5 "http://127.0.0.1:<PORT-de-gestão>/actuator/health"
# um serviço: o comando de "pronto" da receita, repetido em chamadas separadas (de 2 em 2 s, até 4 min)
```

## Em segundo plano, com registo e PID

```bash
LOGS="/tmp/arranque-<ms>"; mkdir -p "$LOGS"
nohup env SERVER_PORT=<PORT> SPRING_PROFILES_ACTIVE=<perfil> <OUTRAS=valor> java -jar <jar> > "$LOGS/<ms>.log" 2>&1 &
echo $! > "$LOGS/<ms>.pid"
echo "<nome do contentor que arrancaste>" >> "$LOGS/contentores.txt"       # um por linha, só os teus
```

Os valores só no processo, na linha de comando: nunca num ficheiro do repositório. O registo e o PID ficam fora do repositório, em `/tmp/arranque-<ms>/`. Ver o registo: `tail -n 60 "$LOGS/<ms>.log"`.

PowerShell: `$env:SERVER_PORT='<PORT>'; Start-Process java -ArgumentList '-jar','<jar>' -RedirectStandardOutput "$env:TEMP\arranque-<ms>\<ms>.log" -PassThru | ForEach-Object { $_.Id }`.

## Construir

Preferir o *wrapper* do projeto. Sem testes (a receita traz o comando exato):

```bash
./mvnw -DskipTests package          # Windows: mvnw.cmd
./gradlew build -x test             # Windows: gradlew.bat
```

## Depois de arrancar: o que parar (só se o utilizador o pedir)

Só o que arrancaste. O processo, pelo PID (nunca `pkill -f`); os contentores, pelos nomes que estão em `contentores.txt`:

```bash
ps -p "$(cat "$LOGS/<ms>.pid")" -o command=       # confirma que ainda é o teu comando
kill -TERM "$(cat "$LOGS/<ms>.pid")"              # e numa chamada à parte: ps -p <pid>
docker stop <nome-do-contentor-que-arrancaste>
```

Estes comandos vão no relatório, em "Como parar", para o utilizador. **Não os corras sem pedido.**
