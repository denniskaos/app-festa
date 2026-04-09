# Changelog

All notable changes to this project will be documented in this file.

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
