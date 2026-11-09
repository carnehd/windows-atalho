---
name: testes-bruno-por-requisitos
description: Cria ou atualiza testes automáticos Bruno (.bru) a partir de requisitos funcionais de uma API REST, cruzando o requisito com o contrato OpenAPI/Swagger, o código (validações, regras de negócio, formato de erros) e a coleção Bruno existente. Corre a coleção, classifica as falhas e produz uma matriz de cobertura requisito → testes. Usa quando houver um requisito novo ou alterado para validar, quando se pedir "cria testes para este requisito", "verifica se o requisito X está implementado", ou "cobre o endpoint Y com testes".
---

# Testes Bruno a partir de requisitos

Objetivo: dado um requisito, garantir que existe um conjunto de pedidos Bruno que prova que o requisito está implementado e a funcionar, e dizer com clareza o que falta.

Princípios:
- O requisito manda. O código e o swagger servem para descobrir como chamar a API e que erros esperar, nunca para decidir o que é correto. Se o código contradiz o requisito, o teste segue o requisito e falha.
- Nunca alterar o código da aplicação para fazer um teste passar. Só se escrevem ficheiros dentro da pasta da coleção Bruno e o ficheiro de cobertura.
- Cada teste tem de ser repetível: corre duas vezes seguidas e passa as duas.
- Seguir as convenções da coleção que já existe. Só se inventa estrutura quando não há nenhuma.
- Ficheiros de ambiente (`environments/*.bru`), `bruno.json` e pedidos que já existiam não se alteram em silêncio. Se for mesmo preciso mudar um, o relatório diz qual, o que mudou e porquê. Mudar o `baseUrl` para apontar a outra porta nunca é solução: se a app não responde no ambiente indicado, reporta-se.

## 1. Recolher contexto

Faz-se em duas partes. Primeiro os documentos fonte (passos 1 e 2). Depois para-se para validar com o utilizador (secção 1b). Só depois se lê o código e a coleção (passos 3 a 5). A razão: se o entendimento do requisito estiver errado, tudo o que vier a seguir é trabalho perdido, e o código pode contaminar a leitura do requisito.

Lê, por esta ordem, e toma notas curtas:

1. **Requisito**: texto, ficheiro ou ticket indicado. Separa-o em critérios de aceitação verificáveis, um por linha. Se um critério for ambíguo, regista a dúvida e assume a interpretação mais restritiva.
2. **Contrato**: procura OpenAPI/Swagger (`**/*openapi*.{yaml,yml,json}`, `**/*swagger*.{yaml,yml,json}`, `**/api/**/*.y*ml`). Anota paths, métodos, parâmetros, campos obrigatórios, enums, códigos de resposta documentados. Anota também **o que cada endpoint produz e o que consome**: um `POST` que devolve `id` alimenta os `GET /{id}`, `PUT`, `DELETE` do mesmo recurso; um campo de pedido que referencia outro recurso (`clienteId` no corpo, `{encomendaId}` no path) obriga a que esse recurso exista antes.
**Para aqui. Valida com o utilizador antes de continuar (secção 1b).**

3. **Código**: controladores ou handlers do endpoint em causa, classes de domínio e validadores, o handler global de erros (para saber o formato do corpo de erro e o mapeamento exceção → código HTTP), e as propriedades de configuração que afetam o comportamento (chaves de API, limites, tamanhos). Procura em especial **pré-condições de estado**: regras do tipo "só se o recurso X estiver no estado Y", "só se o cliente estiver ativo", "só se houver saldo ou quantidade disponível", transições de estado permitidas, e efeitos colaterais de uma operação sobre outro recurso (criar um pedido altera o estado do artigo; cancelar repõe a quantidade). Cada uma destas regras é uma dependência entre pedidos.
4. **Coleção Bruno existente**: `bruno.json`, `environments/*.bru`, estrutura de pastas, numeração `seq`, nomes, como encadeiam variáveis, como limpam dados, se há `script:pre-request` para dados únicos. Lê `referencia/sintaxe-bruno.md` se precisares da sintaxe.
5. **Como correr a aplicação**: `README`, `AMBIENTE_LOCAL.md`, `docker-compose`, portas. Confirma se está a correr com um pedido simples ao endpoint de saúde ou à raiz da API.

## 1b. Validar os requisitos com o utilizador

Depois de ler o requisito e o contrato, e **antes de abrir qualquer ficheiro de código ou escrever qualquer teste**, apresenta ao utilizador o que entendeste e pede confirmação. Esta paragem é obrigatória, salvo se o pedido inicial disser explicitamente para avançar sem validar.

O que apresentar, curto e numerado:
1. **Requisitos e critérios encontrados**: a lista de critérios de aceitação derivados, com o identificador que lhes vais dar (`R7-1.1`, `R7-1.2`, …), uma linha cada. É esta numeração que vai aparecer na matriz e nos ficheiros, por isso o utilizador tem de a ver agora.
2. **Endpoints envolvidos**, tal como o contrato os descreve.
3. **Dúvidas e assunções**: o que o requisito não diz e a leitura que vais assumir se o utilizador não responder.
4. **O que ficou de fora**: partes do requisito que não dão teste por API, e porquê.

Termina com duas perguntas, exatamente estas:
- "Falta algum requisito ou critério, ou algum está mal entendido?"
- "Posso avançar para o código e para os testes?"

E depois **espera**. Não leias código, não cries ficheiros, não corras nada até teres resposta.

Com a resposta:
- Se o utilizador corrigir ou acrescentar, atualiza a lista, mostra só o que mudou, e volta a perguntar se podes avançar.
- Se disser que sim, segue para os passos 3 a 5 e para a secção 2, usando a lista confirmada como fonte de verdade. Os critérios confirmados não se renumeram.
- Se não houver forma de perguntar (execução não interativa, sem canal de resposta), não assumas o sim: entrega a lista com as dúvidas e assunções, diz que paraste à espera de confirmação, e explica como continuar: repetir o pedido com "lista confirmada, avança" e as correções que quiser.

Quando corres como subagente e não falas diretamente com o utilizador, a paragem faz-se devolvendo a lista ao agente que te chamou, com as duas perguntas, para ele as fazer ao utilizador. Continuas quando te for devolvida a confirmação.

## 2. Derivar os casos de teste

Para cada critério de aceitação, gera casos nesta ordem. Não saltes categorias; se uma não se aplica, diz porquê no ficheiro de cobertura.

| Categoria | O que cobre | Exemplo de asserção |
|---|---|---|
| Caminho feliz | O pedido correto devolve o resultado certo | status, campos do corpo, cabeçalhos |
| Validação de entrada | Cada regra de formato ou obrigatoriedade, nos limites (vazio, mínimo, máximo, máximo + 1, tipo errado) | status 400 e mensagem |
| Regra de negócio | Estados, transições, unicidade, dependências entre recursos | status 409/422 e mensagem |
| Não encontrado | Identificadores inexistentes em cada path param | status 404 |
| Autorização | Cabeçalhos ou tokens obrigatórios em falta ou inválidos | status 401/403 |
| Efeito secundário | O estado mudou de facto: confirmar com um GET a seguir ao POST/PUT/DELETE | corpo do GET |
| Formato de erro | O corpo de erro tem a estrutura definida no projeto | campos presentes e tipos |
| Idempotência e limpeza | Dados únicos por execução; apagar no fim o que se criou | status do DELETE |

Regras para escolher asserções:
- Afirmar o que o requisito diz, não tudo o que a resposta traz. Uma asserção por facto relevante.
- Nunca afirmar valores gerados (ids, datas, tokens) por igualdade; usar `isDefined`, `isNumber`, `matches`.
- Em listas, afirmar a presença do elemento criado no teste, não o tamanho total.
- Mensagens de erro: afirmar com `contains` numa palavra-chave estável, não com a frase inteira.

## 2b. Ligar os pedidos: ordem e dados partilhados

Os testes de um requisito raramente são independentes. Antes de escrever ficheiros, desenha a cadeia de pedidos e só depois numeras.

**Como descobrir a ordem**
1. Para cada caso de teste, lista o que ele precisa que exista antes: recursos (um artigo, um cliente), estados (artigo disponível, cliente ativo, pedido aprovado), e valores gerados (ids, tokens, nomes únicos).
2. Para cada pré-condição, identifica o pedido que a produz. Vem de três sítios: o contrato (o `POST` que cria e devolve o `id`), o código (a regra que exige um estado, e a operação que o produz), e o próprio requisito (quando descreve um fluxo: "depois de aprovada, pode ser entregue").
3. Ordena por dependência: produtor antes de consumidor. Se A precisa de B e B precisa de C, a ordem é C, B, A. Se a ordem não for determinável, não a inventes: regista a dúvida e escolhe a mais conservadora (criar tudo primeiro).
4. Para fluxos com estados, a sequência é a máquina de estados do código: um pedido por transição, pela ordem em que as transições são permitidas. Os testes de transição inválida ficam no estado em que são inválidos (testar `criado → entregue` antes de aprovar; testar `aprovado → criado` depois de aprovar).

**Como passar dados entre pedidos**
- O pedido produtor guarda o que os seguintes precisam com `vars:post-response` (`artigoId: res.body.id`, `token: res.body`), com nomes com prefixo do requisito para não colidir com outras pastas (`r7ArtigoId`, não `artigoId`).
- O consumidor usa `{{r7ArtigoId}}` no URL, no corpo ou nos cabeçalhos.
- Nunca copies um id a mão nem assumas valores fixos de sequências. Se um teste precisa de um id inexistente, usa um valor impossível (`999999999`), não um que "provavelmente" não existe.
- Um valor que vem da resposta e muda em cada execução (token, data, id) só se afirma por forma, nunca por igualdade.

**Como organizar a cadeia na pasta**
- Primeiros ficheiros: preparação, um por recurso base, por ordem de dependência (cliente → artigo → pedido). O nome diz que é preparação: `01-prep-criar-cliente.bru`.
- A seguir, os casos de teste pela ordem da cadeia. Casos que não mudam estado (GET, validações 400, 404) podem ir em qualquer ponto depois da preparação; casos que mudam estado (PATCH, DELETE, operações com efeito colateral) ficam onde o estado está certo e **depois** dos casos que precisavam do estado anterior.
- Depois de cada operação com efeito colateral noutro recurso, um `GET` que confirma o efeito (criar pedido → `GET` do artigo mostra o estado reservado e a quantidade a menos).
- Últimos ficheiros: limpeza pela ordem inversa da criação (pedidos antes de artigos, artigos antes de clientes), porque as regras de integridade costumam impedir apagar o pai com filhos vivos. Se um recurso não puder ser apagado por desenho (histórico), diz no relatório.
- Se a cadeia for longa, parte-a em subpastas dentro da pasta do requisito (`REQ-7/1-artigos/`, `REQ-7/2-pedidos/`, `REQ-7/3-clientes/`), numeradas de forma a correrem pela ordem certa, cada uma com a sua preparação. A ordem entre subpastas é alfabética, por isso o prefixo numérico é obrigatório quando uma depende da outra. Para correr só um requisito: `bru run REQ-7 --env <ambiente>`.

**Regista a cadeia**
No `COBERTURA.md`, uma secção "Cadeia de pedidos" com a ordem e, por pedido, o que produz e o que consome. Exemplo:

```
01-prep-criar-cliente        produz r7Cliente
02-prep-ativar-cliente       consome r7Cliente              estado: ativo
03-prep-criar-artigo         produz r7ArtigoId              estado: disponível, quantidade 3
04-criar-pedido              consome r7ArtigoId, r7Cliente  produz r7PedidoId; efeito: artigo reservado, quantidade 1
05-get-artigo-reservado      consome r7ArtigoId             confirma o efeito de 04
06-aprovar-pedido            consome r7PedidoId             estado: aprovado
...
```

Com isto, quem ler a pasta percebe porque é que o `seq` é o que é, e o próximo requisito reutiliza a preparação em vez de a repetir.

## 3. Escrever os ficheiros .bru

- **Uma pasta por requisito, na raiz da coleção, com o identificador do requisito como nome**: `REQ-7/`, `US-123/`, `JIRA-4512/`, tal como o requisito é conhecido no projeto, em minúsculas se a coleção já usar minúsculas. Todos os pedidos desse requisito ficam lá dentro: preparação, casos de teste, confirmações de efeito e limpeza. Nada do requisito fica espalhado por outras pastas.
- Se o requisito não tiver identificador, usa-se um nome curto derivado do título (`req-precos-e-stock`) e diz-se no relatório qual se escolheu.
- Se já existir uma pasta com esse nome, é o mesmo requisito a ser revisto: atualizam-se os pedidos que lá estão em vez de criar uma pasta nova. Pedidos que deixaram de fazer sentido com a nova versão do requisito apagam-se e o relatório lista-os.
- Dentro da pasta, ficheiros numerados `NN-nome.bru` com `seq` igual ao número, pela ordem da cadeia definida em 2b, porque o Bruno corre por `seq` dentro da pasta e as pastas por ordem alfabética.
- Pedidos de outras pastas que o requisito partiu (por exemplo, um campo que passou a ser obrigatório) corrigem-se no sítio onde estão, com a alteração mínima, e o relatório lista cada um. Não se copiam para a pasta do requisito.
- Os primeiros pedidos da pasta são a preparação: criam os dados base pela ordem de dependência e guardam ids em variáveis com `vars:post-response`. Dados únicos por execução com `script:pre-request` e `Date.now().toString(36)`, definidos no primeiro pedido da pasta.
- Últimos pedidos da pasta limpam o que foi criado.
- Nome do ficheiro e `meta.name` dizem o que se testa: `03-criar-sem-email-400.bru`, não `03-teste3.bru`.
- Cabeçalhos com hífen não funcionam em `assert`; usar o bloco `tests` com `res.getHeader("nome")`.
- Ficheiros para upload ficam numa pasta da coleção e referenciam-se com caminho relativo à raiz da coleção.
- Um docs block curto em cada ficheiro liga o teste ao critério: `docs { Critério R3.2: ... }`.

Antes de correr, valida a sintaxe lendo cada ficheiro novo uma vez. Erros comuns: `seq` repetido, chaveta por fechar, `body: json` sem bloco `body:json`, variável usada antes de ser definida.

## 4. Correr e classificar

```bash
cd <pasta da coleção> && bru run --env <ambiente> --reporter-json resultados.json
```
Se a CLI não estiver instalada: `npx -y @usebruno/cli@2 run --env <ambiente>`. Se só interessa uma pasta: `bru run <pasta> --env <ambiente>`.

Se a aplicação não estiver a correr, não a arranques às escondidas: diz como arrancar e para onde apontar o ambiente, e deixa os testes prontos.

Para cada falha, decide uma de três classificações e justifica com o que viste no código:
1. **Requisito não implementado**: o código não tem a validação ou regra. O teste fica, a falhar, e aparece na matriz como "em falta".
2. **Implementação diverge do requisito**: existe, mas com outro código HTTP, outra mensagem ou outra regra. O teste fica a seguir o requisito; a divergência vai para o relatório com a linha de código.
3. **Teste errado**: pedido mal construído, variável não definida, dados que colidem. Corrige o teste e volta a correr.

Nunca "afrouxes" uma asserção para passar sem a justificares como classificação 3.

## 5. Registar cobertura

Cria ou atualiza `COBERTURA.md` na raiz da coleção, com o modelo em `referencia/modelo-cobertura.md`. Tem obrigatoriamente estas partes:

1. **Matriz requisito → testes.** Uma linha por critério de aceitação, com o identificador do requisito (`R7-1.1`, `US-123-3`), o critério em texto, os testes que o cobrem, o estado (✅ coberto e a passar, ❌ coberto e a falhar, ⬜ em falta, ➖ não testável por API) e a observação. Cada teste é um **link para o ficheiro**, com o nome completo e caminho relativo à raiz da coleção: `[REQ-7/1-pet/06-criar-sem-price-400](REQ-7/1-pet/06-criar-sem-price-400.bru)`. Nunca abreviaturas como `06` ou `43 a 46`: quem lê tem de poder clicar e abrir o teste.
2. **Índice inverso teste → requisito.** Uma tabela por pasta ou subpasta do requisito, com todos os ficheiros `.bru` dessa pasta, o critério que cada um cobre e uma frase do que verifica. Preparação e limpeza marcam-se como "preparação da cadeia" e "limpeza da cadeia". Um teste sem critério é um erro: ou se lhe atribui o critério ou se justifica.
3. **Cadeia de pedidos.** A ordem de execução e os dados que passam entre pedidos, como em 2b.
4. **Dúvidas e divergências.**

Para a ligação ser verificável, cada ficheiro `.bru` leva no bloco `docs` o código do critério que cobre, no formato `Critério <ID>: <frase>`, e os de preparação levam `Preparação para <ID>: ...`. O índice inverso lê-se daí, não de memória. No fim, confirma que cada link da matriz aponta para um ficheiro que existe e que cada ficheiro da pasta aparece no índice inverso.

## 6. Relatório final

Responde com, por esta ordem:
1. Lista dos critérios de aceitação derivados, com dúvidas assinaladas.
2. Pasta do requisito criada ou atualizada, e ficheiros criados, alterados ou apagados, incluindo os de outras pastas que foi preciso corrigir.
3. Resultado da execução: totais, e por cada falha a classificação e a justificação.
4. **Matriz requisito → testes**, completa, não resumida: para cada requisito e critério encontrado, os testes que o cobrem, com o nome completo do ficheiro, e o estado. É a mesma matriz do `COBERTURA.md`; no relatório pode ir sem os links, mas com os nomes inteiros. Agrupa por requisito quando houver mais do que um.
5. O que fica por fazer e precisa de decisão humana.

Sem floreados. Se tudo passou, diz isso em uma linha e mostra a matriz.
