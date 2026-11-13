# Modelo do relatório

Português, direto. As secções por esta ordem. Uma secção sem nada diz-se numa linha ("Nenhum desvio"). Nunca o valor de um segredo: o nome da variável e `(segredo)`.

```
## Resumo
<Uma frase: o que pediste, o que ficou de pé e o veredicto da saúde.>

## Receitas lidas
- <caminho da pasta>
- microservices/<ms>.md, services/<serviço>.md ... (o bloco de <ms>)
Partes em falta: <"Not known" na receita de ..., ou "nenhuma">

## O que corre agora
| Item | Tipo | Como ficou | Onde | Porta | Endereço |
|---|---|---|---|---|---|
| postgres | serviço | reutilizado | contentor <nome> | 5432 | localhost:5432 |
| redis | serviço | novo | contentor <nome> (<imagem>) | 6380 | localhost:6380 |
| <ms> | microserviço | novo | PID <pid>, registo /tmp/arranque-<ms>/<ms>.log | <PORT> | http://localhost:<PORT> |
"Como ficou": reutilizado (já corria, não é teu), novo (arrancaste tu), falhou.

## Valores dados ao microserviço
Só os nomes: SERVER_PORT, SPRING_PROFILES_ACTIVE, DB_URL, DB_PASSWORD (segredo)...

## Saúde (teste de saúde)
**Veredicto: Saudável | Parcial | Com problemas**

| Nível | Verificação | Resultado | Evidência |
|---|---|---|---|
| Serviço postgres | porta, pronto, entrar como <utilizador>, esquema | OK | `select 1` -> 1 |
| Serviço redis | PING | OK | PONG |
| Microserviço | processo, porta, saúde | OK | `{"status":"UP"}` |
| Microserviço | componentes | OK | db UP, redis UP |
| Ponta a ponta | DB_URL -> localhost:5432 | OK | porta a responder |
| Ponta a ponta | CATALOG_URL -> localhost:8082 | FALHOU | sem resposta |

## Desvios da receita
| Passo | A receita dizia | Usei | Evidência |
|---|---|---|---|
| porta de gestão | (sem valor) | 9107 | `application.yml:22` |
Sugestão: **Analyse again** no Local setup para a receita ficar certa.

## Como parar
Só o que arrancaste. Corre-os tu quando quiseres: não os corro sem pedido.
- microserviço: `kill -TERM <pid>` (confirma antes com `ps -p <pid> -o command=`)
- contentores que arranquei: `docker stop <nome> ...`
(O que reutilizei não é meu: não está aqui.)

## Dúvidas e o que falhou
- <o que não consegui, a evidência, e o que o utilizador pode fazer>
```

Em modo **Planear**, as secções por esta ordem: Resumo, Receitas lidas, Passos por ordem, **Saúde (o que se verificaria)**, Valores dados ao microserviço, Desvios da receita (com a linha "Sugestão: Analyse again…" no fim, se há desvios), Como parar, Dúvidas. Um plano sem a secção Saúde está incompleto. No lugar de "O que corre agora" e do resultado da "Saúde", a lista dos passos por ordem, com o comando exato de cada um e o que esperar, **e no fim a secção Saúde (o que se verificaria): a tabela dos três níveis, com o comando de cada verificação e o que conta como bom** (por exemplo `psql ... select 1` para a base de dados, `redis-cli ping`, o endereço de saúde, e cada endereço das variáveis), e uma linha a dizer como pedir o arranque ("arranca o <ms>").

Em Planear a secção Saúde tem a **mesma tabela**, com a coluna "Resultado" escrita como "por verificar" e a "Evidência" como o comando e o que contaria como bom, e o veredicto como "por dar (depois de arrancar)". Uma linha por verificação, sem a resumir numa frase:

```
## Saúde (o que se verificaria)
| Nível | Verificação (comando) | Conta como bom |
|---|---|---|
| Serviço postgres | `<engine> exec <NAME> pg_isready` e `psql -h 127.0.0.1 -U <utilizador> -d <base> -c "select 1"` | accepting connections; devolve 1 |
| Serviço redis | `<engine> exec <NAME> redis-cli ping` | PONG |
| Microserviço | `curl -fsS --max-time 5 http://127.0.0.1:<porta>/<caminho de saúde>` e o PID vivo | `"status":"UP"`, sem componente DOWN |
| Ponta a ponta (conectividade) | `nc -z -w 2 127.0.0.1 <porta>` para cada endereço das variáveis (DB_URL, REDIS_HOST, os outros microserviços) | porta a responder |
```

Em modo **Validar**: só "Resumo", "O que corre agora" (o que encontraste), "Saúde" e "Dúvidas".
