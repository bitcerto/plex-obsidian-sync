# Plex Sync - Guia do Usuario

## 1) Visao geral

O Plex Sync conecta sua conta Plex (e opcionalmente seu Plex Media Server) com notas no Obsidian.

Ele sincroniza:

1. Filmes e series para notas Markdown.
2. Campo `assistido` entre Plex e Obsidian.
3. Estrutura por pasta:
   - `Media-Plex/Filmes/...`
   - `Media-Plex/Series/...`

## 2) O que NAO faz

1. Nao remove arquivo fisico de filme/serie no disco.
2. Nao apaga item da biblioteca do PMS automaticamente.
3. Nao exige script Python para uso normal do plugin.

## 3) Requisitos

1. Obsidian com Community Plugins habilitado.
2. Plugin instalado em `.obsidian/plugins/plex-obsidian-sync`.
3. Acesso a internet para login com conta Plex.
4. Para modos com servidor, acesso de rede ao PMS.

## 4) Instalacao

### 4.1 Build

```bash
cd /home/lucas/Projetos/plex-obsidian-sync/plex-sync-obsdian-plugin
npm install
npm run typecheck
npm run test
npm run build
```

### 4.2 Copia para o vault

```bash
mkdir -p "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync"
cp manifest.json main.js versions.json "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync/"
```

### 4.3 Ativar no Obsidian

1. Abra `Settings -> Community plugins`.
2. Clique `Reload plugins`.
3. Ative `Plex Sync`.

## 5) Modos de autenticacao

### 5.1 Conta Plex (sem servidor) - `account_only`

Use este modo quando voce quer sincronizar usando apenas a conta Plex.

Passos:

1. Em `Modo de autenticacao`, escolha `Conta Plex (sem servidor)`.
2. Clique `Login com Plex`.
3. Finalize o login no navegador.
4. Clique `Plex Sync: Sync Now`.

Esse modo sincroniza watchlist e historico assistido da conta.

### 5.2 Conta Plex + Descoberta - `hybrid_account`

Use este modo quando deseja acessar bibliotecas do seu PMS via conta Plex.

Passos:

1. Em `Modo de autenticacao`, escolha `Conta Plex + Descoberta`.
2. Clique `Login com Plex`.
3. Clique `Atualizar servidores`.
4. Escolha o servidor em `Servidor Plex`.
5. Clique `Plex Sync: Sync Now`.

### 5.3 Manual (URL + Token do PMS) - `manual`

Use quando quiser apontar diretamente para um PMS especifico.

Passos:

1. Em `Modo de autenticacao`, escolha `Manual (URL + Token do PMS)`.
2. Preencha `Plex Base URL`.
3. Preencha `Plex Token`.
4. Clique `Plex Sync: Sync Now`.

## 6) Configuracoes principais

1. `Bibliotecas`: separadas por virgula. Vazio = todas `movie/show`.
2. `Pasta das notas`: default `Media-Plex`.
3. `Politica de conflito`:
   - `latest`: vence o lado com alteracao mais recente.
   - `plex`: Plex vence.
   - `obsidian`: nota vence.
4. `Sync automatico`:
   - Desligado: sincroniza apenas no `Sync Now` (exceto gatilho de exclusao de nota).
   - Ligado: startup + intervalo.

## 7) Comandos disponiveis

1. `Plex Sync: Sync Now`
2. `Plex Sync: Force Full Rebuild`
3. `Plex Sync: Reset Local State`
4. `Plex Sync: Show Last Sync Report`
5. `Plex Sync: Login with Plex Account`
6. `Plex Sync: Refresh Plex Servers`
7. `Plex Sync: Logout Plex Account`
8. `Plex Sync: Search and Add to Watchlist` (modo `account_only`)

## 8) Como a sincronizacao funciona

### 8.1 Pull (Plex -> Obsidian)

1. Cria notas novas para itens novos.
2. Atualiza metadados e `assistido`.
3. Recria nota removida localmente quando o item ainda existe no Plex.

### 8.2 Push (Obsidian -> Plex)

1. Alterar `assistido` no frontmatter envia mudanca para o Plex.
2. Em series, temporadas e episodios tambem entram no fluxo de sincronizacao.

### 8.3 Exclusao de nota

Ao apagar uma nota dentro da pasta configurada, o plugin agenda sync automatico (debounce de ~1.2s).

Resultado por modo:

1. `account_only`: tenta remover da watchlist e limpar status assistido na conta Plex.
2. `hybrid_account`: dispara sync, mas nao apaga filme/serie da biblioteca PMS.
3. `manual`: dispara sync, mas nao apaga filme/serie da biblioteca PMS.

## 9) Seguranca

1. Tokens sensiveis ficam no armazenamento local do dispositivo.
2. Tokens nao sao gravados nos arquivos tecnicos do vault.
3. Cache tecnico de servidores e salvo sem `accessToken`.
4. Logs de debug mascaram token em URL.
5. Lock distribuido evita sincronizacao simultanea em varios dispositivos.

## 10) Arquivos tecnicos criados no vault

Dentro de `${notesFolder}`:

1. `.plex-obsidian-state*.json`
2. `.plex-obsidian-lock.json`
3. `.plex-obsidian-last-report.json`
4. `.plex-servers-cache.json`

## 11) Multi-dispositivo (Windows/Linux/Android)

1. Use o mesmo vault nos dispositivos.
2. Se usar LiveSync, deixe o lock tecnico sincronizar junto.
3. Cada dispositivo precisa fazer login no plugin localmente.
4. Em caso de lock ativo de outro dispositivo, aguarde expirar o TTL.

## 12) Troubleshooting rapido

### 12.1 "0 servidores encontrados"

1. Confirme se o PMS esta vinculado a mesma conta Plex logada.
2. No modo `hybrid_account`, clique `Atualizar servidores`.
3. Se necessario, use `manual` temporariamente.

### 12.2 "lock mantido por ..."

1. Outro dispositivo esta sincronizando.
2. Aguarde o TTL e tente novamente.

### 12.3 Item nao apareceu apos `Sync Now`

1. Verifique modo atual (`account_only` vs `hybrid/manual`).
2. Verifique filtros em `Bibliotecas`.
3. Abra `Show Last Sync Report` e veja erros.

### 12.4 Apaguei nota e ela voltou

Isso e esperado quando o item continua existente no Plex, principalmente nos modos com PMS.

## 13) FAQ

### Remover da biblioteca apaga arquivo de video?

1. No plugin: nao.
2. No PMS: pode apagar somente se a opcao de exclusao de midia estiver habilitada no servidor.

### Preciso do script Python?

Nao para o fluxo principal com plugin. O `sync.py` pode ficar apenas como fallback.
