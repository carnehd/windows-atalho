# The skills of Git Quick's agents

Git Quick has no model of its own. For a few tasks it starts an agent command line you already have (Claude CLI or
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
