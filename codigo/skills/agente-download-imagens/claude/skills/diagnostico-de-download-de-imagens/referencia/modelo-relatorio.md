# Modelo do relatório

Curto, direto, sem floreados. Nenhum segredo: um proxy com utilizador e palavra-passe escreve-se `http://***@host:porta`.

````markdown
# Download da imagem <nome completo>

**Causa provável:** <uma frase>. **Certeza:** <alta | média | baixa>, porque <o que a sustenta>.

## O que vi

| De onde | O quê | Resultado |
|---|---|---|
| Computador | `curl -sS -I -m 15 https://registry-1.docker.io/v2/` | `401` com `www-authenticate`: chega |
| Máquina do Podman | o mesmo | `x509: certificate signed by unknown authority`; emissor `<CA da empresa>` |
| Máquina do Podman | `ls /etc/pki/ca-trust/source/anchors` | vazio |

## O que fazer (os comandos são para correres tu; eu não altero a máquina)

1. <passo, com o comando exato, em PowerShell ou bash conforme o sistema dele>
2. <passo>
3. Reiniciar a máquina e voltar a descarregar:
   ```powershell
   podman machine stop
   podman machine start
   podman pull docker.io/library/redis:7-alpine
   ```

## Como confirmar

<o que o download deve mostrar quando resolver, e o que significa se falhar de outra maneira>

## O que ainda não sei

- <o que faltou: o erro completo, o endereço do proxy sem credenciais, se há VPN...>

---
Cola-me <o que preciso a seguir>.
````

## Com mais de uma hipótese

Uma secção `## Hipóteses, por ordem` antes de "O que fazer": uma linha por hipótese, com o teste mais barato que a confirma ou a afasta.

## Se não consegui medir

Diz-o: "a máquina do Podman não responde, por isso não medi de dentro dela". Nunca preenches o que não mediste.
