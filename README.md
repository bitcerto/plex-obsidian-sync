# Sincronizacao Plex <-> Obsidian (bidirecional)

Este fluxo sincroniza:
- Biblioteca do Plex para notas Markdown no Obsidian
- Campo `assistido` do Plex para o Obsidian
- Campo `assistido` do Obsidian de volta para o Plex

O titulo fica em pt-BR porque vem direto do Plex (`titulo`), sem usar Trakt.

## Arquivos

- Script: `sync.py`
- Dependencias: `requirements.txt`
- Exemplo de variaveis: `.env.example`

## Requisitos

1. Python 3.10+
2. Acesso ao Plex Media Server
3. Token do Plex (`X-Plex-Token`)
4. Caminho local do seu Vault do Obsidian

## Instalacao

```bash
cd /home/lucas/Projetos/plex-obsidian-sync
python3 -m venv .venv-plex-sync
source .venv-plex-sync/bin/activate
pip install -r requirements.txt
```

## Configuracao

Copie o exemplo e ajuste os valores:

```bash
cp .env.example /tmp/plex-obsidian-sync.env
```

Exemplo minimo:

```bash
export PLEX_BASE_URL="http://192.168.1.10:32400"
export PLEX_TOKEN="SEU_TOKEN"
export OBSIDIAN_VAULT_DIR="/home/lucas/Obsidian/Vault"
export OBSIDIAN_NOTES_SUBDIR="Media/Plex"
export PLEX_LIBRARIES="Filmes,Series"
export SYNC_CONFLICT_POLICY="plex"
export SYNC_INTERVAL_SECONDS="30"
```

## Uso

Sincronizacao unica:

```bash
python3 sync.py
```

Modo continuo:

```bash
python3 sync.py --loop
```

Teste sem gravar alteracoes:

```bash
python3 sync.py --dry-run
```

## Rodar em background (systemd --user)

Template: `plex-obsidian-sync.service.example`

Passos:

```bash
mkdir -p ~/.config/systemd/user
cp plex-obsidian-sync.service.example ~/.config/systemd/user/plex-obsidian-sync.service

# Ajuste os paths dentro do .service e crie seu arquivo de env:
cp .env.example ~/.config/plex-obsidian-sync.env

systemctl --user daemon-reload
systemctl --user enable --now plex-obsidian-sync.service
systemctl --user status plex-obsidian-sync.service
```

Logs:

```bash
journalctl --user -u plex-obsidian-sync.service -f
```

## Como editar no Obsidian

Cada nota recebe frontmatter com campos gerenciados pelo sync:

```yaml
plex_rating_key: "12345"
biblioteca: Filmes
titulo: Cidade de Deus
assistido: true
```

Para atualizar no Plex a partir do Obsidian, altere somente `assistido` (`true`/`false`).

## Politica de conflito

Quando os dois lados mudam no mesmo ciclo:

- `SYNC_CONFLICT_POLICY=plex`: Plex vence
- `SYNC_CONFLICT_POLICY=obsidian`: Obsidian vence
- `SYNC_CONFLICT_POLICY=latest`: usa timestamp mais recente

## Observacoes

- O script sincroniza secoes de video (`movie` e `show`).
- O estado da sincronizacao fica em:
  - `<OBSIDIAN_VAULT_DIR>/<OBSIDIAN_NOTES_SUBDIR>/.plex-obsidian-state.json`
- Renomear/mover notas manualmente pode causar recriacao de arquivo no proximo ciclo.
- A sincronizacao de volta para o Plex cobre o campo `assistido` (watch/unwatch).
- Titulo e metadados sao fonte do Plex para manter o pt-BR igual ao servidor.


## Plugin Obsidian (recomendado para multi-dispositivo)

Para uso em Windows/Linux/Android sem host sempre ligado, use o plugin em:

- `/home/lucas/Projetos/plex-obsidian-sync/obsidian-plugin`

O script `sync.py` permanece como fallback.

### Plugin v0.2.0 (Conta Plex + descoberta)

O plugin agora suporta:

- Login pela conta Plex via PIN flow (`plex.tv`)
- Descoberta dos servidores da conta
- Selecao manual do servidor
- Estrategia de conexao (`remote_first`, `local_first`, `local_only`)
- Modo manual legado (`Plex Base URL + Token`) para fallback

### Plugin v0.3.0 (Conta Plex sem servidor)

Novo modo de autenticacao:

- `Conta Plex (sem servidor)` para sincronizar watchlist da conta e campo `assistido` sem depender de PMS local
- Mantem os modos anteriores (`Conta Plex + Descoberta` e `Manual`)
- Inclui comando para buscar filmes/séries na conta Plex e adicionar direto na Lista para assistir
- Estrutura de notas por tipo: `Media-Plex/Filmes/...` e `Media-Plex/Series/...`
