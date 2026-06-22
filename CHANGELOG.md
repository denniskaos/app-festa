# Changelog

All notable changes to this project will be documented in this file.

## [1.5.1]
### Fixed
- Corrige o número de leilões da festa de quatro para três.

### Changed
- O Painel passa a incluir leilões recebidos e os totais vendido, pago e em falta dos lugares.
- O atalho de navegação “Venda de lugares” passa a chamar-se apenas “Lugares”.

## [1.5.0]
### Added
- Página de Leilões com três registos fixos, data, valor recebido e total acumulado.
- Página de Venda de Lugares com comprador, lugar, valor total, valor pago e cálculo automático do valor em falta.
- Validação para impedir pagamentos acima do valor da venda e a venda duplicada do mesmo lugar.

## [1.4.7]
### Added
- Recuperação manual segura: pedidos ficam pendentes numa área administrativa e o link temporário é apresentado apenas uma vez ao administrador.
- CI no GitHub Actions para executar verificações e testes em cada pull request e push para `main`.

### Changed
- Deploy Render alinhado com o disco persistente real em `/opt/render/project/src/data` e health check promovido para `/readyz`.
- Backup completo da base de dados passa a usar a API de backup online do SQLite, incluindo alterações ainda presentes em WAL.

### Fixed
- Links secretos de recuperação deixam de ser escritos nos logs de produção.
- Rotas de backup ficam limitadas a administradores e utilizadores financeiros autenticados.

## [1.4.6]
### Added
- Segurança: auditoria de autenticação persistente com interface administrativa (`/seguranca/audit`) para listar/exportar/purgar eventos e desbloquear tentativas por email.
- Segurança: limitação persistente de tentativas de login (SQLite) e testes automáticos dedicados para segurança/auditoria/rate-limit.
- Segurança: recuperação de password via "Esqueci-me da password" (`/password/forgot` e `/password/reset`) com token temporário.
- Importação: novo fluxo de importação CSV de eventos com preview + confirmação (`/import` e `/import/confirm`) e relatório de erros por linha.
- Backup/exportação: exportação `events.csv` e inclusão do cronograma no ZIP de todos os CSV.

### Changed
- Segurança: proteção CSRF com token por sessão, rotação após autenticação e modo estrito opcional por `STRICT_CSRF=1`.
- Operação: logs estruturados com `requestId`, purga automática de retenção de auditoria no arranque e checks de pré-arranque (`check-conflicts` + `node --check`).
- Qualidade: testes automáticos expandidos (unitários + integração de registo/dashboard) e validações de password forte em registo/gestão de utilizadores.

### Fixed
- Deploy: mitigação de falhas de build em ambientes que executam Yarn por omissão através de configuração `.yarnrc` (registry/timeout).

## [1.4.5]
### Fixed
- Sessões em produção: removido bloqueio de arranque quando `SESSION_SECRET` não está definido; a aplicação passa a usar um fallback determinístico e emitir aviso.
- Sessões em produção: adicionado modo estrito opcional com `STRICT_SESSION_SECRET=1` para forçar erro quando faltar `SESSION_SECRET`.
- Migração de peditórios: corrigido backfill de `valor_prometido_cents` / `valor_entregue_cents` a partir de `valor_cents` em bases legadas.
- Exportações: reforçada compatibilidade com esquemas antigos em patrocinadores/casais nas rotas de backup (CSV/ZIP/XLSX).

### Changed
- Qualidade de runtime: adicionado script `npm test` para validação sintática rápida (`node --check`).
- Logging: pedidos HTTP continuam ativos por omissão em dev e ficam controláveis em produção via `LOG_REQUESTS=1`.

## [1.4.4]
### Added
- Rodízio movido de **Definições** para a secção **Casais**, com ecrã completo em `/casais/rodizio`.
- Rodapé global com indicação da release em todas as páginas: `Release v1.4.4`.

### Changed
- Página **Casais** atualizada para layout alinhado com o dashboard de Rodízio.
- `definicoes/rodizio` passou a redirecionar para `casais/rodizio`.
- Ajustes visuais no Backup e melhorias de exportação (encoding e cabeçalhos legíveis).

## [1.4.3]
### Added
- Orçamento: nova página de criação de serviço (`/orcamento/new`) com botão **Novo** na listagem.
- Orçamento: nova página de edição de serviço (`/orcamento/:id/edit`) com ação **Editar** na tabela.

### Changed
- Orçamento: removida edição inline com botão **Guardar** na tabela, alinhando o fluxo com patrocinadores e peditórios.
- Orçamento: adicionados indicadores de **Saldo Final** e **Valor em falta** (`total orçamento - saldo final`).
- Peditórios: consolidação final do fluxo com criação/edição em páginas dedicadas, mantendo totais prometido/entregue/em falta.

## [1.4.2]
### Added
- Peditórios: nova página de criação com botão **Novo** e campo **Nome da pessoa**.
- Jantares: ação em massa para marcar todos os convidados como presentes.

### Changed
- Peditórios: substituição do valor único por **Valor Prometido**, **Valor Entregue** e cálculo de **Em Falta**.
- Peditórios: removidos os campos **Data** e **Notas** da UI/fluxo atual.
- Dashboard e Rodízio: totais de peditórios passam a usar `valor_entregue_cents` (com fallback para legado).
- Backups/exportações (CSV, ZIP e XLSX): peditórios atualizados com os novos campos e coluna de em falta.
- Migrações de base de dados para suportar novos campos de peditórios mantendo compatibilidade com dados antigos.

### Fixed
- Ajustes de consistência entre listagens, formulários e exportações dos peditórios.

## [1.4.1]
### Added
- Versão anterior de referência.
