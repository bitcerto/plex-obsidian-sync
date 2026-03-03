# Plex Sync

Projeto do plugin Obsidian para sincronizacao bidirecional com Plex.

## Estrutura

1. Plugin: `plex-sync-obsdian-plugin/`
2. Guia principal: `plex-sync-obsdian-plugin/docs/GUIA-USUARIO.md`

## Build rapido

```bash
cd /home/lucas/Projetos/plex-obsidian-sync/plex-sync-obsdian-plugin
npm install
npm run typecheck
npm run test
npm run build
```

## Instalar no vault do Obsidian

```bash
mkdir -p "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync"
cp manifest.json main.js versions.json "/caminho/do/vault/.obsidian/plugins/plex-obsidian-sync/"
```

Depois no Obsidian:

1. `Settings -> Community plugins -> Reload plugins`
2. Ative `Plex Sync`

## Observacao

O caminho oficial deste repositorio e o plugin Obsidian.
