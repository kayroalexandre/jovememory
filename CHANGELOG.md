# Changelog

## 0.5.3 — 2026-10-08

Correção da armadilha de bootstrap e decisão de arquitetura sobre memória de
desenvolvimento.

- `runtimeDatabaseUrl` derivava a senha da role runtime de hostname mais **pathname** (o
  nome do banco), mas o `ALTER ROLE` é do **cluster inteiro**. Bootstrapear um banco de
  teste rotacionava a senha compartilhada e bloqueava o banco principal de
  desenvolvimento — descoberto empiricamente, não por leitura. A derivação passa a usar
  apenas o hostname: estável em todos os bancos do mesmo servidor, distinta entre
  servidores. Teste novo cobre bancos de teste e de restore no mesmo cluster.
- **Migração da senha:** no próximo deploy, o pre-deploy bootstrap grava a senha derivada
  da fórmula nova. Runtime e bootstrap usam a mesma fórmula e a mesma variável, então o
  deploy é consistente; a janela de drenagem de 20 segundos pode recusar novas conexões do
  processo antigo, como em qualquer rotação de credencial.
- Documentada a decisão de arquitetura: **uma memória durável por repositório, em
  produção**; experimentos em workspace descartável via CLI, nunca no workspace do
  projeto. Memória não é uma web app — dividir a memória de um repositório por ambiente
  destrói a continuidade que ela existe para preservar e mandaria o conhecimento mais
  valioso para a casa menos durável. O override por projeto no cliente (mesmo nome,
  endpoint local) fica registrado como caminho de crescimento, rejeitado hoje por custar
  disponibilidade, durabilidade e dogfooding.
- `OPERATIONS.md` ganha o procedimento de workspace descartável e o smoke mínimo
  pós-deploy executável.
- Registrado resíduo conhecido: um nó de projeto cliente dentro do workspace do próprio
  jovememory, vazio, herança de uso descuidado anterior. Não há ferramenta de remoção de
  nó; fica documentado em vez de SQL administrativo contra produção.

## 0.5.2 — 2026-10-07

O observatório deixa de ser um servidor MCP separado e passa a ser servido pelo próprio
broker do projeto, atrás da mesma credencial de escopo.

- O bloco opcional `observer` na configuração do broker aponta para um token de leitura
  global. O broker conecta esse segundo cliente, acrescenta `memory_overview` ao mesmo
  catálogo e encaminha a chamada por ele.
- O agente passa a ver **um** servidor de memória. A entrada `jovememory-observatory` do
  cliente pode ser removida.
- **O token de leitura global deixa de estar no processo do agente.** Antes ele vivia no
  `Authorization` da configuração do cliente; agora só o broker o lê, de arquivo externo
  ao projeto. Isso é mais restrito do que a configuração anterior, não apenas diferente.
- O observatório é global e continua disponível mesmo quando o repositório atual não
  consegue se matricular.
- `memory_connection_status` passa a declarar `observatory.configured`, `connected`,
  `tools` e `error`.
- Nenhuma ferramenta do observatório aceita `workspace`: o broker remove o campo do schema
  e o descarta dos argumentos antes de encaminhar.
- O roteamento é uma allowlist explícita de `memory_overview`, e a conexão é recusada com
  `OBSERVER_ROLE` se a credencial expuser qualquer ferramenta fora dela. Confiar apenas no
  papel do token permitiria que um `observer.token_file` apontado por engano para um token
  de administrador transformasse o broker em repasse global de privilégio.
- Falha em uma chamada do observatório derruba a conexão, para que o próximo ciclo
  reconecte e o catálogo não declare uma ferramenta que falha.
- `tools/list` do projeto é isolado em try/catch: um endpoint de projeto fora do ar não
  derruba mais o observatório junto.
- Sem repositório vinculado, o observatório continua funcionando. O limite de "credencial
  fora do projeto" passa a ser o diretório de trabalho, e não o home, que rejeitaria a
  própria configuração documentada.

Corrigido na revisão, vindo de 0.5.1:

- O estado barato do repositório passou a incluir `git diff HEAD`. `status --porcelain` não
  contém hash de conteúdo, então dois conteúdos do mesmo arquivo já modificado produziam
  estado idêntico e o hash de fonte ficava obsoleto em silêncio, sem erro visível.
- Falhas de constraint do Postgres passam a considerar o nome da constraint, para que uma
  colisão de `projects.repository_id` entre workspaces reporte `PROJECT_COLLISION` em vez da
  mensagem genérica de item duplicado.
- O braço semântico da busca de mídia ganhou desempate estável por `m.id`.

Isolado do 0.5.1 porque altera o catálogo de ferramentas e o que o agente enxerga, e por
isso exige smoke próprio depois do deploy.

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
