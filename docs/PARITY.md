# Funcionalidades e contratos novos

Esta é uma reconstrução, com schema e transporte novos. O catálogo anterior de 28 ferramentas foi usado como inventário. Manter o objetivo funcional **não significa aceitar todos os argumentos ou formatos antigos**: adapte clientes ao schema publicado por `tools/list`.

| Objetivo | Ferramentas reconstruídas | Contrato novo |
| --- | --- | --- |
| Recuperação híbrida | `memory_search`, `memory_read`, `memory_tree` | FTS português, pgvector exato, grafo e recência de candidatos; rerank padrão com provedor ativo, proveniência e degradação |
| Política/diagnóstico | `memory_version`, `memory_capabilities`, `memory_doctor`, `memory_stats` | Catálogo por perfil; apenas workspaces autorizados; sem dados de configuração privada |
| Conteúdo paginado | `memory_list`, `memory_list_proposed` | Cursor vinculado a workspace/filtros/data; retome com o `as_of` retornado |
| Escrita/revisão | `memory_write`, `memory_propose_write`, `memory_review` | Ativação automática padrão com indexação após commit quando o provedor está ativo; modo manual opcional exige outro perfil |
| História/retenção | `memory_update_item`, `memory_delete`, `memory_move_item` | Substituição automática atômica, soft delete e movimento auditado dentro do workspace |
| Ingestão | `memory_ingest_markdown`, `memory_ingest_project` | Cliente envia conteúdo; preview/hash obrigatório; aplicação transacional do manifesto; tombstones/idempotência |
| Mídia | `memory_attach_media`, `memory_search_media` | Bytes S3 privados, SHA-256, extração PDF/texto, texto fornecido pelo cliente, vetor textual ou multimodal de imagem quando configurado |
| Entre projetos | `memory_cross_workspace` | Relação explícita + autorização do destino + gate; falha fecha a travessia |
| Consolidação | `memory_consolidate` | Preview/hash, textos e snapshots integrais, ativação atômica com verificação das fontes |
| Auditoria/aprendizado | `memory_mutations`, `memory_feedback` | Auditoria append-only e passo de importância de 0,05 em [0,1] |
| Continuidade | `memory_context`, `memory_checkpoint`, `memory_resume` | Pacote limitado em bytes, checkpoints ativos automaticamente e referências relidas com hash/eligibilidade |
| Estado de projeto | `memory_record`, `memory_project` | Tipos goal/decision/constraint/evidence/issue/procedure; basis e autoridade declaradas; medição exige data/referências; ambiguidades de valores ativos |

São 28 nomes reconstruídos. As cinco adições originais são `memory_create_workspace`, `memory_create_node`, `memory_link`, `memory_index` e `memory_read_media`; a versão 0.5.0 acrescenta mais dez, chegando a **43 ferramentas**. Não há ferramentas anunciadas sem dispatch correspondente. A integração exercita os 43 nomes, com autorização real e persistência; caminhos de modelo são simulados, não medições pagas.

O conector local (`src/project-bridge.mjs`) acrescenta `memory_connection_status`, que pertence ao bridge e não ao catálogo do serviço: um agente conectado por broker vê 44 nomes. As demais ferramentas do broker são as do escopo do projeto, com o campo `workspace` injetado e removido do schema.

## Mudanças deliberadas

- Um banco com RLS substitui bancos por workspace e banco mestre `_shared`. Não há workspace global reservado para credenciais; nomes explícitos definem instalação vazia.
- API administrativa local/formulários/perfis persistidos em banco são substituídos por CLI e configuração nativa de ambiente. Tokens/hashes por perfil aplicam-se também ao HTTP remoto.
- O gate oferece recomendação e score indicativos. Ativação automática padrão ocorre por política local, mesmo com score baixo ou provedor indisponível. No modo manual opcional, escritas permanecem propostas. Rerank permanece opcional e não corta resultados pelo limiar de escrita.
- Datas são explícitas (`valid_from`, `valid_until`), sem inferir a validade de um fato pelo nome do arquivo ou por uma data mencionada. Checkpoint/registro guardam datas declaradas e hashes de referências.
- Novos IDs são UUIDs; ingestão deriva UUID determinístico de workspace/caminho/cabeçalho/conteúdo. Uma mídia pode estar ligada a itens diferentes; repetição dos mesmos bytes no mesmo item é deduplicada.
- Consolidação aceita `ids`; atualização aceita `content`; revisão usa `action: accept|reject`. O schema MCP é a referência exata, não esta tabela resumida.
- Ingestão segue a mesma política de escrita, com ativação automática padrão. Um manifesto cabe numa transação: falha não deixa um lote parcial aplicado. Alterar bytes exige nova prévia; versões anteriores não são automaticamente apagadas.
- Mídia até 4 MiB. PNG/JPEG/WebP, PDF e texto têm verificação/extração declaradas; GIF/BMP/SVG, áudio e vídeo podem ser preservados como bytes privados. Não há OCR automático, descrição visionária, transcrição ou indexação semântica de áudio/vídeo. Imagem sem texto pode usar modelo multimodal explícito; suporte real do provedor precisa de validação.
- Não há geração automática de respostas ou fatos. `memory_project` detecta divergência textual por chave na página, não contradições semânticas em todo o corpus. Fontes omitidas por orçamento/cursor não demonstram ausência. `memory_mutations` projeta a auditoria e omite `item`/`before`, que carregariam o conteúdo integral de cada item.
- Backups são snapshots administrativos com mídia e manifest externo. Restore de verificação compara o banco e hashes de arquivos; repopular um Bucket de produção é procedimento separado e autorizado.

## O que não é herdado como garantia

Medidas de qualidade, corpus, calibração, chaves/modelos específicos, workspaces pessoais, configuração de clientes e estado operacional da instalação anterior não são defaults do novo projeto. Não houve importação de dados ou troca dos clientes antigos. Métricas antigas não certificam a qualidade deste código/corpus.

A avaliação nova suporta Precision/Recall/Hit@10, MRR, consultas negativas e calibração com treino/holdout. A operação mantém os objetivos de diagnosticar, indexar backlog, fazer backup e testar restauração, usando comandos próprios. Consulte [EVALUATION.md](EVALUATION.md) e [OPERATIONS.md](OPERATIONS.md).

## Limites conhecidos e declaração honesta

- `memory_feedback` grava um passo auditado de `importance` e o valor é devolvido em `memory_list`/`memory_read`, mas **nenhuma consulta o usa para ordenar**. A ordenação vem de `ts_rank_cd`, distância de vetor e data de criação. Importância é sinal observável, não ajuste de recuperação.
- `memory_record.authority` (`canonical|supporting|historical`) é persistido e relido, mas não influences ranking nem filtra Searches.
- A lista de preferencias gratuitas filtrada pelo catálogo é limitada a **3 candidatos** por chamada, antes do fallback pago.
- Limiares declarados (escrita 0,60 e travessia 0,75) **não são calibrados** por padrão; `memory_calibration` só existe como `npm run evaluate -- calibration`.
- Telemetria só é registrada para ferramentas que recebem `workspace`. `memory_version`, `memory_capabilities`, `memory_open_project` e `memory_overview` não geram linha em `telemetry`.
- Os nomes de repositório aceitos seguem `^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$` (Git usual). A regex antiga em `scripts/evaluate.mjs` foi corrigida para o mesmo contrato e agora é derivada de `WORKSPACE_PATTERN`, declarado uma única vez em `src/config.mjs`.

## Contrato 0.3.0

`memory_create_workspace` exige perfil administrativo autorizado ao nome solicitado, não admite conteúdo e registra uma única criação auditada. Credenciais por projeto podem ser adicionadas por `EXTRA_AUTH_PROFILES` sem substituir `AUTH_PROFILES`; IDs e hashes duplicados impedem inicialização. A migration 002 libera somente INSERT no registro de workspaces para a role runtime; conteúdo continua nas transações RLS.

Inferência é apoio explícito ao agente: `synthesize`, `enrich` e `summarize` são falsos por padrão. Embeddings e rerank permanecem automáticos; `memory_write` e `memory_update_item` usam decisão indicativa. Atualização remove análise auxiliar da versão anterior para não reapresentá-la como análise do novo conteúdo. Síntese fornece evidência compactada e citações, preservando IDs/hash do original; conteúdo cortado declara `content_truncated` e `content_bytes`, e a releitura integral continua disponível por ID. Consolidação preserva textos integrais mesmo quando produz resumo auxiliar.

## Contrato 0.4.0

Síntese continua opt-in e muda de modelo primário fixo para rota lógica gratuita. `synthesis.model` identifica o modelo efetivo retornado pelo provedor; `synthesis.routing` declara modelo solicitado, modelo efetivo, classe de rota e uso de fallback pago. Preferências gratuitas são filtradas pelo catálogo e preços zero; teto de preço pago é imposto pelo roteamento nativo. A escolha de outro modelo dentro da rota gratuita não gera `synthesis_fallback`; esse marcador informa fallback pago. Orçamento, hashes, releitura integral e validação de citações permanecem.

## Contrato 0.5.0

43 ferramentas. Dez contratos complementam matrícula/revogação de projeto,
overview global, guia de agente, observações/fontes, feed de mudanças, diagnóstico
de manutenção, revalidação e retirement. Registry e credenciais são geridas por
controlador confiável, sem ampliar o escopo cotidiano do agente. Workspace usa o
nome do repositório e recusa identidade conflitante. `memory_record.replace_key`
é verdadeiro por padrão; `false` conserva explicitamente afirmações divergentes.
Divergências múltiplas não são apagadas por uma substituição silenciosa. Registros
expirados podem receber sucessor com histórico preservado. `source_refs` são
opcionais para compatibilidade; ausência delas aparece como `untracked`.

Busca/contexto/releitura/retomada/projeto incluem diagnóstico de fontes;
`memory_maintenance` inclui itens ativos expirados que a recuperação normal exclui.
Fontes alteradas permanecem legíveis com aviso até o agente verificar, atualizar ou
retirar o fato. `memory_changes` traz sequências e metadados de mutação, sem snapshots
de corpus; cursor/limite declaram a página. `memory_mutations` projeta a auditoria
para `sequence`, `operation`, `item_id`, `actor`, `created_at` e `payload` sem as
chaves `item`/`before`, que guardariam o conteúdo integral de cada item.
Fallback pago não recebe `max_price`; variáveis de preço antigas são ignoradas.
Tentativas gratuitas conservam teto zero.

## Correções de 0.5.1

- `memory_update_item` **herda** a janela de validade do antecessor quando o chamador
  omite `valid_from`/`valid_until`. Antes, a substituição apagava o prazo e tornava
  permanente um fato temporário, sem auditoria. Janela explícita continua substituindo.
- Nó inexistente em escrita, movimentação ou criação de nó-pai é recusado com `NODE`
  antes de chegar ao banco, em vez de virar erro de infraestrutura.
- Violações de constraint do Postgres (`23505`, `23503`, `23514`, `40001`, `40P01`)
  viram `Fault` com código acionável (`CONFLICT`, `REFERENCE`, `INPUT`) em vez de `INTERNAL`.
- Ingestão persiste o `heading` da seção, que já era usado no UUID determinístico e na prévia.
- Limites de PDF (páginas e tamanho de texto) deixam de ser engolidos como
  `pdf_extraction_unavailable`; agora propagam `LIMIT` e não silenciam a recusa.
- `memory_record.locator` usa o mesmo contrato de locator seguro de `source_refs`.
- `memory_project`, `memory_resume` e `memory_maintenance` leem fontes uma única vez e
  diagnosticam referências em lote, em vez de uma transação por item.
- `bounded()` reancla o cursor da página na última linha retida, para que linhas
  cortadas pelo orçamento continuem alcançáveis; paginação que não coubse nenhum item
  falha com `BUDGET` em vez de devolver página vazia com cursor já exaurido.
- `graph()` e a busca lexical de mídia recebem ordenação determinística, porque a fusão
  RRF depende da ordem de cada braço.
- O payload enviado a rerank e síntese é limitado por `RERANK_PAYLOAD_BYTES` (1 MiB por
  padrão) sem alterar a evidência devolvida ao agente.
- `/health` responde por cache curto e o caminho JWT valida o formato antes de gastar
  ida ao banco, reduzindo carga não autenticada.
- O conector local reobserva fontes quando o estado Git muda ou a janela de 60s expira,
  em vez de re-hashear toda a árvore a cada chamada.
- `tsx` passa a ser dependência de desenvolvimento declarada, e não apenas transitiva de `railway`.
- `npm run lint` exige que `VERSION`, `package.json` e `CHANGELOG.md` declarem a mesma
  versão. Antes, um changelog anunciando uma release inexistente passava sem aviso.
- O estado barato do repositório passou a incluir `git diff HEAD`. Porcelain sozinho não
  distingue dois conteúdos do mesmo arquivo já modificado, o que deixava o hash de fonte
  obsoleto em silêncio.
- Falhas de constraint passam a considerar o nome da constraint: uma colisão de
  `projects.repository_id` entre workspaces distintos reporta `PROJECT_COLLISION`, e não a
  mensagem genérica de item duplicado.

## Contrato 0.5.2

O observatório deixa de ser um servidor MCP separado e passa a ser servido pelo broker do
próprio projeto. `memory_overview` continua sendo a ferramenta nº 3 das 43 do mesmo
servidor, com o papel `observer` enxergando apenas ela.

O broker aceita um bloco opcional `observer` na sua configuração privada, com um token de
leitura global lido de arquivo externo ao projeto. O agente vê **um** servidor de memória:
o catálogo do projeto e o do observatório são servidos pelo mesmo processo, e a chamada é
encaminhada pela credencial correspondente. O token do observatório nunca chega ao agente,
o que é mais restrito do que a configuração anterior, em que ele vivia no `Authorization`
do cliente.

O roteamento do observatório é uma **allowlist explícita** de `memory_overview`, e não a
simples confiança no papel do token. Na conexão, o broker confere que o catálogo da
credencial contém as ferramentas do observatório **e nada fora delas**; um token de
perfil mais amplo é recusado com `OBSERVER_ROLE`. Confiar apenas no rótulo do papel seria
uma invariante não verificada: um `observer.token_file` apontado por engano para um token
de administrador transformaria o broker em um repasse global de privilégio, com argumentos
do agente encaminhados sem a injeção de workspace.

Argumentos são encaminhados sem o campo `workspace`, e a falha de uma chamada derruba a
conexão do observatório para que o próximo ciclo reconecte e o catálogo volte a declarar
apenas o que funciona. O observatório é global e permanece disponível mesmo quando o
repositório atual não consegue se matricular. `memory_connection_status` declara
`observatory.configured|connected|tools|error`. Sem o bloco `observer`, o comportamento
anterior é preservado e o observatório aparece como não configurado.

### Correção de 0.5.1 levada pela revisão do 0.5.2

O estado barato do repositório passou a incluir `git diff HEAD`, e não só
`status --porcelain`. Porcelain não contém hash de conteúdo: dois conteúdos diferentes do
mesmo arquivo já modificado produzem saída byte a byte idêntica, e o hash de fonte ficava
permanentemente obsoleto sem nenhum erro aparente. Isso invalidava justamente a invariante
que sustenta `needs_revalidation` e `memory_revalidate`. O diff é barato (um subprocesso) e
sensível ao conteúdo.
