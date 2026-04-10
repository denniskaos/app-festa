
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
- CSRF token é injetado automaticamente nos formulários (com fallback same-origin para compatibilidade).
- CSRF token é renovado no login/registo para reduzir risco de reutilização de sessão.
- Limite de tentativas de login é persistido na base de dados (sobrevive a restart).
- Para bloquear qualquer POST sem token, ativa `STRICT_CSRF=1`.
- Eventos de autenticação são registados em `auth_audit` (sucesso, falha, rate-limit, logout).
- Admin pode consultar os eventos em `/seguranca/audit`.
