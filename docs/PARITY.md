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

São 28 nomes reconstruídos. As quatro adições são `memory_create_node`, `memory_link`, `memory_index` e `memory_read_media`. Não há ferramentas anunciadas sem dispatch correspondente. Integração exercita os 32 nomes, com autorização real e persistência; caminhos de modelo são simulados, não medições pagas.

## Mudanças deliberadas

- Um banco com RLS substitui bancos por workspace e banco mestre `_shared`. Não há workspace global reservado para credenciais; nomes explícitos definem instalação vazia.
- API administrativa local/formulários/perfis persistidos em banco são substituídos por CLI e configuração nativa de ambiente. Tokens/hashes por perfil aplicam-se também ao HTTP remoto.
- O gate oferece recomendação e score indicativos. Ativação automática padrão ocorre por política local, mesmo com score baixo ou provedor indisponível. No modo manual opcional, escritas permanecem propostas. Rerank permanece opcional e não corta resultados pelo limiar de escrita.
- Datas são explícitas (`valid_from`, `valid_until`), sem inferir a validade de um fato pelo nome do arquivo ou por uma data mencionada. Checkpoint/registro guardam datas declaradas e hashes de referências.
- Novos IDs são UUIDs; ingestão deriva UUID determinístico de workspace/caminho/cabeçalho/conteúdo. Uma mídia pode estar ligada a itens diferentes; repetição dos mesmos bytes no mesmo item é deduplicada.
- Consolidação aceita `ids`; atualização aceita `content`; revisão usa `action: accept|reject`. O schema MCP é a referência exata, não esta tabela resumida.
- Ingestão segue a mesma política de escrita, com ativação automática padrão. Um manifesto cabe numa transação: falha não deixa um lote parcial aplicado. Alterar bytes exige nova prévia; versões anteriores não são automaticamente apagadas.
- Mídia até 4 MiB. PNG/JPEG/WebP, PDF e texto têm verificação/extração declaradas; GIF/BMP/SVG, áudio e vídeo podem ser preservados como bytes privados. Não há OCR automático, descrição visionária, transcrição ou indexação semântica de áudio/vídeo. Imagem sem texto pode usar modelo multimodal explícito; suporte real do provedor precisa de validação.
- Não há geração automática de respostas ou fatos. `memory_project` detecta divergência textual por chave na página, não contradições semânticas em todo o corpus. Fontes omitidas por orçamento/cursor não demonstram ausência.
- Backups são snapshots administrativos com mídia e manifest externo. Restore de verificação compara o banco e hashes de arquivos; repopular um Bucket de produção é procedimento separado e autorizado.

## O que não é herdado como garantia

Medidas de qualidade, corpus, calibração, chaves/modelos específicos, workspaces pessoais, configuração de clientes e estado operacional da instalação anterior não são defaults do novo projeto. Não houve importação de dados ou troca dos clientes antigos. Métricas antigas não certificam a qualidade deste código/corpus.

A avaliação nova suporta Precision/Recall/Hit@10, MRR, consultas negativas e calibração com treino/holdout. A operação mantém os objetivos de diagnosticar, indexar backlog, fazer backup e testar restauração, usando comandos próprios. Consulte [EVALUATION.md](EVALUATION.md) e [OPERATIONS.md](OPERATIONS.md).
