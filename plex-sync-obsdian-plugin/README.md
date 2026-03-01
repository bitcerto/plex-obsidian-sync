# Plex Sync Plugin

Plugin Obsidian para sincronizacao bidirecional com Plex:

- `Plex -> Obsidian`: cria/atualiza notas da biblioteca
- `Obsidian -> Plex`: altera `assistido` no frontmatter e reflete no Plex
- Compatibilidade: Windows, Linux e Android (via Obsidian + LiveSync)
- Autenticacao por conta Plex (PIN flow) com descoberta de servidores

## Funcionalidades

- Sync manual, no startup e por intervalo
- Controle de conflito (`latest`, `plex`, `obsidian`)
- Lock distribuido no vault para evitar sync simultaneo entre dispositivos
- Relatorio do ultimo ciclo
- Modo hibrido (conta Plex + selecao manual de servidor) e modo manual legado
- Tokens sensiveis ficam em armazenamento local do dispositivo (nao sao gravados nos arquivos tecnicos do vault)

## Build

```bash
cd /home/lucas/Projetos/plex-obsidian-sync/plex-sync-obsdian-plugin
npm install
npm run typecheck
npm run build
```

## Instalacao manual no Obsidian

1. Gere o build (`main.js`)
2. Copie para a pasta do plugin no vault:

```bash
# Exemplo Linux
mkdir -p "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync"
cp manifest.json main.js versions.json "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync/"
```

3. Abra Obsidian -> Settings -> Community plugins -> Reload plugins
4. Ative `Plex Sync`

No Android, a mesma pasta de plugin deve estar presente no vault sincronizado pelo LiveSync.

## Configuracao minima

- Modo recomendado:
  - `Modo de autenticacao` = `Conta Plex (sem servidor)` para usar apenas conta Plex
  - `Login com Plex`
- Modo com PMS descoberto:
  - `Modo de autenticacao` = `Conta Plex + Descoberta`
  - `Login com Plex`
  - `Atualizar servidores`
  - selecionar `Servidor Plex`
- Modo manual (fallback):
  - `Plex Base URL`
  - `Plex Token`
- `Pasta das notas` (default: `Media-Plex`)

Estrutura de notas gerada:

- `Media-Plex/Filmes/...`
- `Media-Plex/Series/...`

No modo `Conta Plex (sem servidor)`, o plugin sincroniza watchlist da conta e campo `assistido` via endpoints `discover.provider.plex.tv` / `metadata.provider.plex.tv`.

## Comandos

- `Plex Sync: Sync Now`
- `Plex Sync: Login with Plex Account`
- `Plex Sync: Refresh Plex Servers`
- `Plex Sync: Force Full Rebuild`
- `Plex Sync: Reset Local State`
- `Plex Sync: Show Last Sync Report`
- `Plex Sync: Logout Plex Account`
- `Plex Sync: Search and Add to Watchlist` (modo `Conta Plex (sem servidor)`)

## Arquivos tecnicos no vault

Dentro de `${notesFolder}`:

- `.plex-obsidian-state.json`
- `.plex-obsidian-lock.json`
- `.plex-obsidian-last-report.json`
- `.plex-servers-cache.json`

## Desenvolvimento

```bash
npm run dev
npm run test
```
