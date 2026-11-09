# The skills of QuickDeck's agents

QuickDeck has no model of its own. For a few tasks it starts an agent command line you already have (Claude CLI or
GitHub Copilot CLI) and gives it one of these skills: what to look for. The app adds the task and the form of the answer.

| Skill | Where it is used | What the agent does |
|---|---|---|
| [pr-review](pr-review/SKILL.md) | Git: Pull requests, Push and Changes > Analyse | Reads a change and lists errors and improvements, each at its file and line |
| [local-setup](local-setup/SKILL.md) | Maven > Local setup | Reads a microservice and lists what it needs running on this computer: database, cache, messaging, identity... with the container that runs each one |
| [console-fix](console-fix/SKILL.md) | Maven > the console > right click > Analyse with agent | Reads the lines selected and the code, and proposes a fix |

The agent only reads: it works in a copy of the code, with no command, no edit and none of the repository's own settings.
What it reads goes to the provider of the agent, with your account there.

The first time, the app puts these files in `data/skills/<name>/SKILL.md`, next to the exe. Change those to fit your team
(the part at the end of each one, "Conventions of the project", is there for that): the app keeps your changes, and
gives you a new version of a skill only when you never changed yours. Another skill of your own goes in its own folder
there, or in through **Load skill...** in the gear of Analyse.

## Agents for your terminal

Four packs of agents and skills, in Portuguese, for Claude Code and for GitHub Copilot CLI. QuickDeck does not read them: they are for you to use in a terminal, in your own projects. Install one with `./instalar.sh <project> [claude|copilot|ambos]` (see the README of each).

| Pack | What the agent does |
|---|---|
| [agente-testes-api](agente-testes-api/README.md) | From a requirement, writes and runs Bruno tests for a REST API and gives a coverage matrix |
| [agente-arranque-ms](agente-arranque-ms/README.md) | Two agents. `arrancador-ms`: reads a project (README, environment files, compose, `application.yml`) and gives what a microservice needs to start here, with the commands: dependencies, ports, variables, Spring Boot. `levantador-ambiente`: from the documentation of a feature that spans several microservices, finds the services and support systems it needs (database, Redis, Pub/Sub, Keycloak...), reuses what already runs, assigns ports and follows the project's own recipes (one file per microservice type and per support service, templates in `modelos-de-receita/`). Both start things only when you ask |
| [agente-implementar-tarefas](agente-implementar-tarefas/README.md) | Asks for the documentation of a task, finds which microservices it changes, reads their code, proposes a plan, and (after your yes) implements it with tests, one branch per repository, and a report that ties each requirement to its files and tests |
| [agente-download-imagens](agente-download-imagens/README.md) | Diagnoses why a container image does not download behind a proxy (certificate, proxy not used by the Podman machine, DNS, blocked registry, rate limit, short names, disk) and gives the steps for you to run. It only reads: it never changes the machine, and a guard blocks every command that is not a read |
