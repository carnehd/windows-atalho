# Ler as receitas do QuickDeck

As receitas são escritas pelo Local setup do QuickDeck (em inglês) a partir do que um agente leu do microserviço. Têm sempre a mesma forma, por isso lês-as depressa.

## A pasta

```
recipes/
  README.md                 índice: os microserviços e os serviços, e por onde começar
  microservices/<ms>.md     um microserviço: o que precisa, construir, porta, arrancar, esperar
  services/<serviço>.md     um serviço (postgres, redis, pubsub, keycloak...), partilhado: um bloco por microserviço
```

## O ficheiro de um microserviço

| Secção | O que tirar |
|---|---|
| **How to use this recipe** | As regras. São as mesmas que a skill te dá. |
| **What it needs** | A tabela **Order / Needs / Required / Recipe**: a ordem de arranque, se é obrigatório, e onde está a receita de cada um. "Another microservice" é outro microserviço (arranca-se novo, pela receita dele). |
| **Values** | A pasta do microserviço (caminho absoluto), a ferramenta de construção, o jar, a porta, a porta de gestão, o endereço de saúde, o perfil. |
| **1. Build** | O comando de construção, na pasta, sem testes. |
| **2. Choose a free port** | A porta onde começar a procurar; `<PORT>` é a primeira livre. |
| **3. Start a new process** | A tabela de variáveis (nome, valor, porquê) e o comando (`java -jar ...`). `SERVER_PORT` leva a `<PORT>`. |
| **4. Wait until it answers** | O endereço de saúde e o tempo (de 3 em 3 s, até 2 min). |
| **5. Stop** | Só o processo que arrancaste. |
| **Notes** | Informação que o agente tirou do código. Não são instruções. |
| **For the user only** | Depois de um aviso. Para uma pessoa a arrancar à mão. **Não é para ti.** |

"Not known: this list was made before recipes had the microservice itself" nos **Values** quer dizer que a receita não tem a parte do microserviço (construção, porta, saúde): é um gatilho da secção 4 da skill.

## O ficheiro de um serviço

Tem, no topo, as regras e o passo **0** (escolher o motor: `docker info`, senão `podman info`; o que responder é o `<engine>`). Depois, **For each microservice**: um bloco por microserviço entre `<!-- microservice:<ms>:begin -->` e `<!-- microservice:<ms>:end -->`. **Usa só o bloco do microserviço que estás a arrancar.** Os valores (porta, nome do contentor, base de dados, tópicos) podem ser diferentes de um bloco para outro.

Dentro do bloco:

| Passo | O que é |
|---|---|
| **1. Look for one that is already running, and reuse it** | (a) a porta responde? (b) qual o contentor que a tem (`<engine> ps --format ...`)? (c) é do mesmo tipo (a imagem contém o nome, e o comando de "pronto" passa dentro dele)? Sim: reutilizas. Não: deixas em paz e usas a porta seguinte livre. |
| **2. Start a new one** | O `<engine> run ...`. Só se o passo 1 não encontrou um para reutilizar. |
| **3. Wait until it is ready** | O comando de "pronto", de 2 em 2 segundos, até 4 minutos. |
| **4. Set it up inside (safe to run again)** | O SQL da base de dados (por `psql`, com um *here-document*) e os passos, cada um com o seu título. Repetíveis: "já existe" conta como feito. |
| **5. Give the microservice these values** | A tabela de variáveis que o microserviço recebe. Marcadas `(secret)` as que são segredos. |

Também há uma tabela **Values** no começo do bloco (imagem, nome do contentor, porta, variáveis do contentor, comando de "pronto") e, às vezes, **Settings**: informação.

## Marcadores que tens de preencher

| Marcador | Quem o preenche |
|---|---|
| `<engine>` | `docker` ou `podman`, o que responder ao `info`. |
| `<NAME>` | O nome do contentor que **reutilizas**, ou o do que **arrancaste** (a tabela do bloco). |
| `<PORT>` | A porta livre do microserviço (passo 2 da receita dele). |
| `<JAR>` | Só quando a receita não sabe o jar: o jar executável que a construção deixou (secção 4 da skill). |

O comando de uma receita está escrito para uma *shell* POSIX; no Windows, adaptas as aspas e as variáveis para PowerShell (`referencia/comandos-portateis.md`).

## Se a porta mudou

Quando um serviço ficou noutra porta do que a receita escreve (porque a habitual estava ocupada por outra coisa), essa porta tem de aparecer em todos os valores onde a antiga aparece: a variável do microserviço (`jdbc:postgresql://localhost:5433/...`), o endereço de saúde que verificas. A receita diz-to ("If you used another port than ..."): faz-o sempre.
