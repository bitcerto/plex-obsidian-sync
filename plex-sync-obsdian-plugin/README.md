# Plex Sync Plugin

Plugin Obsidian para sincronizacao bidirecional com Plex.

## O que faz

1. `Plex -> Obsidian`: cria e atualiza notas de filmes/series.
2. `Obsidian -> Plex`: envia alteracoes de status `assistido`.
3. Funciona em Windows, Linux e Android (com o mesmo vault, por exemplo com LiveSync).

## Guia de uso completo

Leia o guia detalhado em:

- `docs/GUIA-USUARIO.md`

Esse guia cobre instalacao, configuracao por modo, comandos, sincronizacao, seguranca e troubleshooting.

## Build rapido

```bash
cd /home/lucas/Projetos/plex-obsidian-sync/plex-sync-obsdian-plugin
npm install
npm run typecheck
npm run test
npm run build
```

## Instalacao manual no Obsidian

```bash
mkdir -p "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync"
cp manifest.json main.js versions.json "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync/"
```

Depois no Obsidian:

1. `Settings -> Community plugins -> Reload plugins`
2. Ative `Plex Sync`

## Desenvolvimento

```bash
npm run dev
```
