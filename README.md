
# Nossa Senhora da Graça 2026 — Orçamento (sem Produtos/Stock/Vendas)

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
4) (Opcional) cria admin inicial com variáveis:
   - `ADMIN_BOOTSTRAP_EMAIL=admin@local`
   - `ADMIN_BOOTSTRAP_PASSWORD=<password forte>`
5) Abre http://localhost:3000 e regista a primeira conta

### Regras de segurança
- Passwords devem ter pelo menos 10 caracteres, com maiúsculas, minúsculas, número e símbolo.
- Não há passwords por omissão para novos utilizadores.
