# Changelog

## 0.5.1 — 2026-10-07

Correções de integridade, determinismo e escala, sem mudança de contrato público.

- `memory_update_item` herda a janela de validade do antecessor quando o chamador omite
  `valid_from`/`valid_until`. Antes, substituir um fato com prazo o tornava permanente
  em silêncio e sem auditoria.
- Nó inexistente é recusado com `NODE` em escrita, movimentação e criação de nó-pai,
  antes de chegar ao banco.
- Violações de constraint do Postgres passam a virar `Fault` acionável (`CONFLICT`,
  `REFERENCE`, `INPUT`) em vez de `INTERNAL` opaco. Isso cobre duas revisões pendentes
  competindo pelo mesmo antecessor no modo manual.
- `graph()` e a busca lexical de mídia recebem ordenação determinística, porque a fusão
  RRF depende da ordem de cada braço.
- `memory_project`, `memory_resume` e `memory_maintenance` leem fontes uma vez e
  diagnosticam referências em lote, em vez de abrir uma transação por item.
- `syncSources` compara observações por índice, removendo um diff quadrático em 5000 fontes.
- `bounded()` reancla o cursor da página na última linha retida, para que linhas cortadas
  pelo orçamento continuem alcançáveis; paginação que não coubse nenhum item falha com
  `BUDGET` em vez de devolver página vazia com cursor já exaurido.
- Payload enviado a rerank e síntese é limitado por `RERANK_PAYLOAD_BYTES` (1 MiB por
  padrão) sem truncar a evidência entregue ao agente.
- Ingestão persiste o `heading` da seção, já usado no UUID determinístico e na prévia.
- Limites de PDF deixam de ser engolidos como `pdf_extraction_unavailable`.
- `memory_record.locator` passa a usar o contrato de locator seguro de `source_refs`.
- `memory_mutations` projeta a auditoria e devolve `next_after`, omitindo `item`/`before`.
- `/health` responde por cache curto; o caminho JWT valida o formato antes de gastar ida
  ao banco, reduzindo carga não autenticada.
- O conector local reobserva fontes quando o estado Git muda ou a janela de 60s expira,
  em vez de re-hashear toda a árvore a cada chamada de ferramenta.
- `scripts/evaluate.mjs` deixa de usar a regex de workspace anterior a 0.5.0.
- `WORKSPACE_PATTERN` passa a ser declarado uma única vez, com todos os validadores
  derivando dele.
- `pg_dump`/`pg_restore` em scripts de backup recebem timeout e sinal de término.
- Removidos `Store.recent` e `repositoryLabel`, sem referências.
- `tsx` passa a ser dependência de desenvolvimento declarada, e não apenas transitiva de `railway`.
- Documentação: contagens de ferramentas corrigidas para 43, contrato do bridge
  (`memory_connection_status`) explicitado, e limitações conhecidas registradas em
  PARITY.md. Novo `docs/PLAN.md`.

## 0.5.0 — 2026-10-05

Schema 3, conector Git/stdio, matrícula automática com credencial de escopo, revogação
por epoch, observações de fontes, guia de agente, retirement auditado, substituição por
chave e métricas globais sem corpus. Inferência paga sem teto de preço por decisão do
operador. `jose` fixado para validação de tokens.

## 0.4.0 — 2026-10-05

Síntese migra de modelo fixo para rota lógica gratuita com catálogo dinâmico e preferência
por modelos maiores. Fallbacks pagos explícitos com teto de preço. Contexto declara modelo
efetivo e classe da rota.

## 0.3.0 — 2026-10-05

Inferência generativa seletiva: `synthesize`, `enrich` e `summarize` falsos por padrão.
Provisionamento administrativo de workspace via MCP, idempotente e auditado.
`EXTRA_AUTH_PROFILES` acrescenta perfis sem substituir a base. Migration 002.

## 0.2.0 — 2026-10-05

Política padrão de escrita passa a ativação automática. Rerank permanece padrão e não
corta resultados pelo limiar de escrita. Busca e degradação declaram proveniência.

## 0.1.0 — 2026-10-05

Reconstrução independente: 32 ferramentas MCP com SDK oficial, HTTP remoto autenticado e
stdio local, PostgreSQL/pgvector com RLS, revisão separada, histórico/auditoria, ingestão
transacional, S3 privado, continuidade e registros tipados. Configuração local gerada,
Railpack declarativo, avaliação privada, backup de snapshot com mídia e verificação de
restore. Nenhum dado, configuração ou histórico Git da instalação antiga foi distribuído.
