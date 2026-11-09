#!/usr/bin/env bash
# Instala os agentes e as skills num projeto: arrancador-ms (um serviço) e levantador-ambiente (o ambiente de uma
# funcionalidade, com as receitas do projeto).
#   ./instalar.sh <pasta-do-projeto> [claude|copilot|ambos]
set -euo pipefail
ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO="${1:?pasta do projeto}"
ALVO="${2:-ambos}"
[ -d "$DESTINO" ] || { echo "a pasta do projeto não existe: $DESTINO"; exit 1; }

SKILLS="arranque-de-microservicos ambiente-local-de-testes"

copiar() { # $1 pasta de origem (claude|copilot)  $2 pasta de destino (.claude|.github)
  mkdir -p "$DESTINO/$2/agents" "$DESTINO/$2/skills"
  cp "$ORIGEM/$1/agents/"*.md "$DESTINO/$2/agents/"
  for s in $SKILLS; do
    rm -rf "$DESTINO/$2/skills/$s"
    cp -R "$ORIGEM/$1/skills/$s" "$DESTINO/$2/skills/"
  done
  echo "$1 -> $DESTINO/$2/{agents,skills}"
}

case "$ALVO" in
  claude) copiar claude .claude ;;
  copilot) copiar copilot .github ;;
  ambos) copiar claude .claude; copiar copilot .github ;;
  *) echo "alvo desconhecido: $ALVO (claude|copilot|ambos)"; exit 1 ;;
esac
