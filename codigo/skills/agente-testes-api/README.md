# Agente de testes de API por requisitos

Agente `testador-api` + skill `testes-bruno-por-requisitos`. Genéricos: servem para qualquer API REST com uma coleção Bruno.

```
claude/                              para Claude Code (vai para .claude/ no projeto)
  agents/testador-api.md
  skills/testes-bruno-por-requisitos/
copilot/                             para GitHub Copilot CLI (vai para .github/ no projeto)
  agents/testador-api.md
  skills/testes-bruno-por-requisitos/
instalar.sh                          copia para um projeto
```

A skill é igual nas duas pastas; só o cabeçalho do agente difere, porque cada ferramenta lê campos diferentes.

## Instalar num projeto

```bash
./instalar.sh /caminho/do/projeto ambos
```

`claude` instala em `.claude/`, `copilot` em `.github/`, `ambos` nos dois.

## Usar

Claude Code:
```
usa o agente testador-api: requisito em docs/requisitos/R12.md
```

Copilot CLI:
```bash
copilot --agent=testador-api -p "Requisito: $(cat docs/requisitos/R12.md). Cria os testes Bruno e corre-os com --env local."
```

O requisito pode ser texto colado, um ficheiro ou um ticket. O agente lê o contrato OpenAPI, o código das validações e a coleção existente, escreve os `.bru`, corre `bru run`, e devolve uma matriz de cobertura em `COBERTURA.md` na raiz da coleção.

## O que o agente nunca faz

- Alterar código da aplicação.
- Afrouxar uma asserção para o teste passar.
- Arrancar a aplicação sem ser pedido.

## Atualizar

Edita aqui, nas duas pastas, e volta a correr `instalar.sh` em cada projeto. Os projetos não devem editar a cópia local.
