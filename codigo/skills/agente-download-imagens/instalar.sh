#!/usr/bin/env bash
# Instala o agente e a skill num projeto. Para o Claude Code instala também a guarda que o deixa só ler.
#   ./instalar.sh <pasta-do-projeto> [claude|copilot|ambos]
set -euo pipefail
ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO="${1:?pasta do projeto}"
ALVO="${2:-ambos}"
[ -d "$DESTINO" ] || { echo "a pasta do projeto não existe: $DESTINO"; exit 1; }

copiar() { # $1 pasta de origem (claude|copilot)  $2 pasta de destino (.claude|.github)
  mkdir -p "$DESTINO/$2/agents" "$DESTINO/$2/skills"
  cp "$ORIGEM/$1/agents/"*.md "$DESTINO/$2/agents/"
  rm -rf "$DESTINO/$2/skills/diagnostico-de-download-de-imagens"
  cp -R "$ORIGEM/$1/skills/diagnostico-de-download-de-imagens" "$DESTINO/$2/skills/"
  if [ -d "$ORIGEM/$1/hooks" ]; then
    mkdir -p "$DESTINO/$2/hooks"
    cp "$ORIGEM/$1/hooks/"*.sh "$DESTINO/$2/hooks/"
    chmod +x "$DESTINO/$2/hooks/"*.sh
  fi
  echo "$1 -> $DESTINO/$2/{agents,skills$([ -d "$ORIGEM/$1/hooks" ] && echo ,hooks)}"
}

# A guarda liga-se no .claude/settings.json do projeto (os hooks do cabeçalho do agente não correm): cria o ficheiro, junta a
# entrada ao que já lá está, ou, sem python3, mostra o que juntar. É idempotente.
ligar_guarda() {
  local def="$DESTINO/.claude/settings.json" snippet="$ORIGEM/claude/settings-guarda.json"
  if [ ! -f "$def" ]; then
    cp "$snippet" "$def"; echo "guarda ligada: $def"; return
  fi
  if command -v python3 >/dev/null 2>&1 && python3 - "$def" "$snippet" <<'PY'
import json, sys
dest, snip = sys.argv[1], sys.argv[2]
d = json.load(open(dest)); e = json.load(open(snip))
entry = e["hooks"]["PreToolUse"][0]
lista = d.setdefault("hooks", {}).setdefault("PreToolUse", [])
if not any(h.get("command") == entry["hooks"][0]["command"] for x in lista for h in x.get("hooks", [])):
    lista.append(entry)
json.dump(d, open(dest, "w"), indent=2, ensure_ascii=False); open(dest, "a").write("\n")
PY
  then echo "guarda ligada: $def"
  else
    echo "ATENÇÃO: não consegui juntar a guarda a $def. Junta-lhe isto, senão o agente só se guia pelas regras escritas:"
    cat "$snippet"
  fi
}

case "$ALVO" in
  claude) copiar claude .claude; ligar_guarda ;;
  copilot) copiar copilot .github ;;
  ambos) copiar claude .claude; ligar_guarda; copiar copilot .github ;;
  *) echo "alvo desconhecido: $ALVO (claude|copilot|ambos)"; exit 1 ;;
esac
