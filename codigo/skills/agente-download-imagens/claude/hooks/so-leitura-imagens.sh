#!/usr/bin/env bash
# Guarda do agente diagnostico-imagens (Claude Code, PreToolUse, ligada no .claude/settings.json do projeto). Só deixa passar
# comandos de leitura e ficheiros sem segredos, e só quando quem pede é este agente (o hook vê todas as sessões do projeto).
# Lê o pedido (JSON) no stdin. Sai com 0 para deixar passar e com 2 para bloquear (a mensagem volta para o agente).
# Regra de fundo: se não percebe o pedido, bloqueia. Sem barras invertidas, sem encadear (; &), sem redirecionar (> <),
# sem $ ` ( ) { } ! no comando. Com um pipe, só para grep, head, tail ou wc -l.
entrada="$(cat)"
nega() { echo "Bloqueado pela guarda: $1. Este agente só lê e diagnostica: diz ao utilizador o que correr e pede-lhe que cole o resultado." >&2; exit 2; }

# o valor (ainda com os escapes do JSON) da última chave com este nome
campo() { printf '%s' "$entrada" | sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | tail -n 1; }
corta() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

AGENTE="diagnostico-imagens"
[ "$(campo agent_type)" = "$AGENTE" ] || exit 0   # outra sessão ou outro agente do projeto: não é com esta guarda

ferramenta="$(campo tool_name)"
[ -n "$ferramenta" ] || nega "não percebi o pedido"

case "$ferramenta" in
  Read|Grep|Glob)
    # ficheiros de credenciais e chaves: nunca
    segredo='(^|/)(\.docker|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.netrc|\.npmrc|auth\.json|\.env[^/]*|credentials[^/]*|id_[a-z0-9]+|[^/]*\.(key|p12|pfx|jks))(/|$)'
    for chave in file_path path pattern glob; do
      v="$(campo "$chave")"
      if [ -n "$v" ] && printf '%s' "$v" | grep -Eiq "$segredo"; then nega "ficheiro de credenciais ou chaves ($v)"; fi
    done
    exit 0 ;;
  Bash) ;;
  *) nega "ferramenta $ferramenta" ;;
esac

cmd="$(campo command)"
[ -n "$cmd" ] || nega "comando vazio ou ilegível"
printf '%s' "$cmd" | grep -Eq '\\([^"]|$)' && nega "barras invertidas"
cmd="$(corta "$(printf '%s' "$cmd" | sed 's/\\"/"/g')")"

# comandos exatos que mostram só os NOMES das variáveis de proxy, nunca os valores (podem trazer utilizador e palavra-passe)
EXATOS=(
  "env | grep -i -o -E '^[a-z_]*proxy[a-z_]*='"
  "podman machine ssh \"env | grep -i -o -E '^[a-z_]*proxy[a-z_]*='\""
)
for e in "${EXATOS[@]}"; do [ "$cmd" = "$e" ] && exit 0; done

case "$cmd" in
  *';'*|*'&'*|*'`'*|*'$'*|*'>'*|*'<'*|*'('*|*')'*|*'{'*|*'}'*|*'!'*|*$'\n'*) nega "o comando encadeia, redireciona ou substitui" ;;
esac

H='[A-Za-z0-9.-]+'
IMG='[A-Za-z0-9._:/@-]+'
URL="https?://$H(:[0-9]+)?(/[A-Za-z0-9._/?=:%-]*)?"
NP="--noproxy ('[*]'|\"[*]\"|$H)"
CF="(-[sSIvLk]+|--head|-m [0-9]{1,3}|--max-time [0-9]{1,3}|--connect-timeout [0-9]{1,3}|$NP|-x https?://$H(:[0-9]+)?|--proxy https?://$H(:[0-9]+)?)"
CURL='^curl(\.exe)?( '"$CF"')* '"$URL"'$'
ENG='^(podman|docker) (--version|version|info|images|ps|ps -a|image ls|volume ls|network ls|context ls|system df|system connection list|machine list|machine inspect( [A-Za-z0-9_-]+)?|(image exists|image inspect|manifest inspect) '"$IMG"')$'
REDE='^((nslookup|host|getent hosts) '"$H"'|dig( \+short)? '"$H"'|netsh winhttp show proxy|scutil --proxy|uname -a|uname -sm)$'
# dentro da máquina do Podman
DENTRO='^(cat /etc/(containers/(registries\.conf|policy\.json|containers\.conf|registries\.conf\.d/[A-Za-z0-9._-]+)|resolv\.conf|os-release)|ls /etc/(containers(/certs\.d(/[A-Za-z0-9._:-]+)?|/registries\.conf\.d)?|pki/ca-trust/source/anchors)|df -h( /var| /var/lib/containers)?|getent hosts '"$H"'|uname -r|uname -m|podman (info|images|--version))$'
FILTRO='^(grep( -[ivEFcoqn]+)* ("[A-Za-z0-9._:/=^*+? -]+"|'"'"'[A-Za-z0-9._:/=^*+? -]+'"'"'|[A-Za-z0-9._:/=^*+?-]+)|(head|tail)( -n [0-9]{1,4}| -[0-9]{1,4})|wc -l)$'

curl_com_limite() { [[ "$1" =~ (^|\ )(-m\ |--max-time\ ) ]] || nega "o curl leva sempre limite de tempo (-m 15)"; }

IFS='|' read -r -a partes <<< "$cmd"
[ "${#partes[@]}" -ge 1 ] && [ "${#partes[@]}" -le 3 ] || nega "pipes a mais"
primeiro="$(corta "${partes[0]}")"
[ -n "$primeiro" ] || nega "comando vazio"

if [[ "$primeiro" =~ ^podman\ machine\ ssh\ (.+)$ ]]; then
  dentro="$(corta "${BASH_REMATCH[1]}")"
  dentro="${dentro#\"}"; dentro="${dentro%\"}"
  [[ "$dentro" != *'"'* ]] || nega "aspas no comando da máquina"
  if [[ "$dentro" =~ $CURL ]]; then curl_com_limite "$dentro"
  elif ! [[ "$dentro" =~ $DENTRO ]]; then nega "dentro da máquina do Podman só os comandos de leitura da lista"; fi
elif [[ "$primeiro" =~ $CURL ]]; then curl_com_limite "$primeiro"
elif [[ "$primeiro" =~ $ENG ]] || [[ "$primeiro" =~ $REDE ]]; then :
else nega "comando fora da lista de leitura"; fi

i=1
while [ "$i" -lt "${#partes[@]}" ]; do
  f="$(corta "${partes[$i]}")"
  [[ "$f" =~ $FILTRO ]] || nega "depois de um pipe só grep, head, tail ou wc -l"
  i=$((i + 1))
done
exit 0
