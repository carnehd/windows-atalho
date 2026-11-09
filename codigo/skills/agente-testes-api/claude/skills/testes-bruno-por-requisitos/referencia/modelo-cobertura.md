# Cobertura de requisitos

Atualizado em: AAAA-MM-DD · Coleção: `<pasta>` · Ambiente: `<nome>`

Cada requisito tem a sua pasta na raiz da coleção, com o identificador do requisito como nome. Correr um requisito: `bru run <REQ-ID> --env <ambiente>`.

Estados: ✅ coberto e a passar · ❌ coberto e a falhar · ⬜ em falta · ➖ não testável por API

Os testes são links para o ficheiro, com nome completo. Sem abreviaturas.

| Requisito | Critério de aceitação | Testes | Estado | Observação |
|---|---|---|---|---|
| R1 | Criar devolve 201 com o id gerado | [R1/01-prep-criar](R1/01-prep-criar.bru) | ✅ | |
| R1 | Nome obrigatório | [R1/02-criar-sem-nome-400](R1/02-criar-sem-nome-400.bru) | ✅ | |
| R1 | Nome até 100 caracteres | [R1/03-criar-nome-101-400](R1/03-criar-nome-101-400.bru) | ❌ | Código aceita 150; ver `Dominio.java:23` |
| R2 | Apagar com dependências dá 409 | | ⬜ | Regra não existe no código |
| R3 | Enviar email de boas-vindas | | ➖ | Sem endpoint para verificar; confirmar por log |

## Testes por requisito (índice inverso)

Todos os ficheiros da pasta do requisito, com o critério lido do bloco `docs` de cada um.

### R1

| Ficheiro | Critério | O que verifica |
|---|---|---|
| [01-prep-criar](R1/01-prep-criar.bru) | R1 | criar devolve 201 e o id; produz `rXId` |
| [02-criar-sem-nome-400](R1/02-criar-sem-nome-400.bru) | R1 | nome obrigatório |
| [03-criar-nome-101-400](R1/03-criar-nome-101-400.bru) | R1 | limite de 100 caracteres |
| [04-apagar-aprovado-409](R1/04-apagar-aprovado-409.bru) | R2 | não se apaga um recurso aprovado |
| [05-limpeza](R1/05-limpeza.bru) | limpeza da cadeia | remove o recurso criado em 01 |

Testes sem critério: 0.

## Cadeia de pedidos
Ordem de execução e dados que passam de um pedido para o seguinte.

| # | Pedido | Consome | Produz | Estado ou efeito que deixa |
|---|---|---|---|---|
| 01 | `R1/01-prep-criar.bru` | | `rXId` | recurso criado, estado inicial |
| 02 | `R1/02-obter.bru` | `rXId` | | |
| 03 | `R1/03-aprovar.bru` | `rXId` | | estado: aprovado |
| 04 | `R1/04-apagar-aprovado-409.bru` | `rXId` | | sem alteração (409 esperado) |
| 05 | `R1/05-limpeza.bru` | `rXId` | | recurso removido |

## Dúvidas sobre o requisito
- R1: "nome curto" não define mínimo. Assumido 1 carácter.

## Divergências encontradas
- R1 limite de 100: a implementação valida 150 (`Dominio.java:23`). Teste segue o requisito.
