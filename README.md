
# Festa da Aldeia — Orçamento (sem Produtos/Stock/Vendas)

Inclui: Login, Painel, Cronograma, Importação CSV, **Orçamento** (linhas), Movimentos, Patrocinadores, Backup/Export.

Export CSV:
- `events.csv`
- `orcamento.csv`  ← (mapa interno para a tabela `categorias`)
- `movimentos.csv`
- `patrocinadores.csv`

## Instalar
1) `cp .env.example .env` e define `SESSION_SECRET`
2) `npm install`
3) `npm run dev`
4) Abre http://localhost:3000 — login **admin@local / admin123**
