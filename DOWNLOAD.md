# Descarregar o QuickDeck

O QuickDeck chamava-se Git Quick. Quem tem o Git Quick passa para o QuickDeck pelo **Check for updates**, com os mesmos dados.

**[Última versão](https://github.com/carnehd/windows-atalho/releases/latest)**: descarrega o `QuickDeck-<versão>.exe`.

Se a tua rede bloquear o download de ficheiros `.exe`, usa o `QuickDeck-<versão>.zip`, que tem o mesmo exe lá dentro.
Abre o zip e tira o exe para a pasta onde o queres usar.

O zip traz também o `logs-config.example.json`, um exemplo da configuração da página Logs para a Grafana. Para o usar, copia-o para `data\logs-config.json`, ao lado do exe, e preenche o endereço da Grafana, o `orgId` e o `datasourceUid`. Os valores são os mesmos do `config.json` do log-explorer.

Todas as versões, com as notas de cada uma, estão na página de [Releases](https://github.com/carnehd/windows-atalho/releases).

Depois de instalada, a app atualiza-se a si própria: em **Settings > Check for updates**, o **Download** põe o zip da última versão na pasta do exe e tira de lá o `QuickDeck-<versão>.exe`, ao lado do que está a correr. **Open &lt;versão&gt; now** fecha esta e abre a nova, com a mesma pasta `data`.

Depois de descarregar:

1. Põe o exe numa pasta, por exemplo `C:\Tools\QuickDeck`.
2. Faz duplo clique. A app fica na bandeja do Windows, junto ao relógio.
3. Na primeira vez, o Windows pode avisar (SmartScreen): escolhe "Mais informações" e depois "Executar mesmo assim".

Mais detalhes, incluindo como levar os teus dados para outro PC, no [LEIA-ME](LEIA-ME.txt).
