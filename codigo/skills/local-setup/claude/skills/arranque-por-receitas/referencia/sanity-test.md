# O teste de saúde (sanity test)

O fim de qualquer arranque, e o modo **Validar** sozinho. Pergunta, não escreve: nenhum `INSERT`, nenhuma criação de tópicos ou utilizadores. Cada verificação leva limite de tempo (`referencia/comandos-portateis.md`) e regista o comando, a resposta resumida e o resultado.

Os valores vêm da receita e de onde arrancaste: a porta real de cada serviço (a que ficou, não a da receita, se a mudaste), o `<NAME>` do contentor (reutilizado ou novo), a `<PORT>` do microserviço e o endereço de saúde. Palavras-passe: usadas nos comandos, nunca escritas no relatório.

## Nível 1: cada serviço

Para todos: **a porta responde** (`nc -z -w 2 127.0.0.1 <porta>`; PowerShell: `Test-NetConnection 127.0.0.1 -Port <porta>`) e **o comando de "pronto" da receita passa** dentro do contentor. Depois, o que prova o que o microserviço vai usar:

| Serviço | Verificação | Bom quando |
|---|---|---|
| PostgreSQL | `<engine> exec <NAME> pg_isready -U postgres` e, com o utilizador da aplicação (o DML da receita), por TCP: `<engine> exec -e PGPASSWORD=<valor> <NAME> psql -h 127.0.0.1 -U <utilizador> -d <base> -tAc "select 1"` | `accepting connections`, e `1`. Para o esquema: `psql ... -tAc "select 1 from information_schema.schemata where schema_name='<esquema>'"` dá `1`. |
| Redis | `<engine> exec <NAME> redis-cli ping` (com `-a <valor>` se a receita lhe dá palavra-passe) | `PONG` |
| Emulador Pub/Sub | `curl -s -m 5 http://127.0.0.1:<porta>/v1/projects/<projeto>/topics` | a resposta inclui cada tópico que a receita criou |
| Keycloak | `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:<porta>/realms/<realm>/.well-known/openid-configuration` | `200` |
| Grafana, LGTM e semelhantes | `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health` (a porta da receita) | `200` |
| Outro (RabbitMQ, Kafka, MongoDB...) | a porta e o comando de "pronto" da receita; se ela não traz um, só a porta | a porta responde e o comando passa |
| Outro microserviço | a porta; e o endereço de saúde dele se a receita o diz | porta a responder e, se há, `UP` |

Se o serviço foi **reutilizado**, a verificação é a mesma: o que importa é que sirva este microserviço (a base de dados e o utilizador existem lá, os tópicos existem).

## Nível 2: o microserviço

| Verificação | Comando | Bom quando |
|---|---|---|
| O processo existe | `ps -p <pid> -o command=` | é o teu comando |
| A porta escuta | `lsof -nP -iTCP:<PORT> -sTCP:LISTEN` ou `nc -z -w 2 127.0.0.1 <PORT>` | alguém escuta |
| Saúde | `curl -fsS -m 5 http://127.0.0.1:<PORT-de-gestão><endereço-de-saúde>` | a resposta tem `"status":"UP"` |
| Componentes | a mesma resposta: procura `"status":"DOWN"` | nenhum componente (`db`, `redis`, `pubsub`...) `DOWN`. Sem componentes detalhados, não conta contra. |
| Registo | `tail -n 200 /tmp/arranque-<ms>/<ms>.log` | sem `Connection refused`, `Unable to obtain connection`, `Could not resolve placeholder`, `password authentication failed`, nem uma linha `ERROR` seguida de *stack trace* do arranque |

Sem *actuator*: a porta escuta e o registo tem `Started <Aplicação> in N seconds`.

## Nível 3: conectividade de ponta a ponta

Das variáveis que o microserviço recebeu, as que são um endereço (nome com `URL`, `HOST`, `ADDR`, `ENDPOINT`; ou um valor `jdbc:...`, `http://...`, `redis://...`, `localhost:porta`): tira o *host* e a porta e verifica que **respondem a partir deste computador** (`nc -z -w 2 <host> <porta>`). Isto apanha o erro típico de uma porta que mudou num serviço e não nos valores do microserviço.

- Para cada endereço: o resultado e a que serviço corresponde (ou "externo", se não é nenhum dos que arrancaste: assinala-o e não o testes se for de um ambiente partilhado).
- Outros microserviços de que este depende: a porta que cada instância nova recebeu, e o endereço de saúde deles.

## Veredicto

| Se | Veredicto |
|---|---|
| Tudo o que é obrigatório passou | **Saudável** |
| Só falharam coisas opcionais | **Parcial** |
| Falhou algo obrigatório | **Com problemas** |

Com problemas: secção 4 da skill (olhar para o microserviço), no máximo duas correções por passo, repetindo só as verificações que falharam. Se continua a falhar, entregas o relatório com o que falha, a evidência e o que o utilizador pode fazer. **Não escondas uma falha para dar um veredicto bom.**

## Em modo Validar (sem arrancar nada)

Primeiro **lês as receitas** (a do microserviço e o bloco dele em cada serviço): é a receita que diz o que verificar (a porta de cada serviço, o nome do contentor, o utilizador e a base de dados, os tópicos, o realm, a porta e o endereço de saúde do microserviço). Sem as receitas não há teste.

Depois descobre o que corre: os `.pid` de `/tmp/arranque-*/` e `/tmp/arranque-<ms>/contentores.txt`, e os contentores (`<engine> ps --format "{{.Names}} {{.Image}} {{.Ports}}"`, para achar o contentor que tem cada porta). Para saber quem escuta numa porta: `lsof -nP -iTCP:<porta> -sTCP:LISTEN` e `ps -p <pid> -o command=`; **não listes os processos do computador** (não são teus nem têm que ver com o teste). Sem pids nem contentores teus, verifica pelas portas e pelos endereços de saúde da receita e diz que não sabes se o que responde foi arrancado por ti.

Fazes **os três níveis completos**, serviço a serviço (também os que parecem óbvios), e entregas sempre a tabela e o veredicto. Se uma verificação não se pode fazer (o motor não responde), a linha da tabela diz **não verificado** e porquê; isso conta como falha para o veredicto se a coisa é obrigatória.
