#!/usr/bin/env bash
# Instala o agente arrancador-receitas e a skill arranque-por-receitas num projeto.
#   ./instalar.sh <pasta-do-projeto> [claude|copilot|ambos]
# (O SKILL.md desta pasta é outra coisa: é a skill que o QuickDeck dá ao agente que analisa um microserviço. Não se instala.)
set -euo pipefail
ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO="${1:?pasta do projeto}"
ALVO="${2:-ambos}"
[ -d "$DESTINO" ] || { echo "a pasta do projeto não existe: $DESTINO"; exit 1; }

SKILL="arranque-por-receitas"

copiar() { # $1 pasta de origem (claude|copilot)  $2 pasta de destino (.claude|.github)
  mkdir -p "$DESTINO/$2/agents" "$DESTINO/$2/skills"
  cp "$ORIGEM/$1/agents/"*.md "$DESTINO/$2/agents/"
  rm -rf "$DESTINO/$2/skills/$SKILL"
  cp -R "$ORIGEM/$1/skills/$SKILL" "$DESTINO/$2/skills/"
  echo "$1 -> $DESTINO/$2/{agents,skills}"
}

case "$ALVO" in
  claude) copiar claude .claude ;;
  copilot) copiar copilot .github ;;
  ambos) copiar claude .claude; copiar copilot .github ;;
  *) echo "alvo desconhecido: $ALVO (claude|copilot|ambos)"; exit 1 ;;
esac
