# Arquitetura

## Decisões da reconstrução

A finalidade é memória persistente, revisada e recuperável para agentes. A implementação anterior serviu de inventário funcional, sem copiar seu código, configuração, dados ou histórico Git.

Um serviço Node.js ESM oferece MCP por stdio local e HTTP remoto. O SDK oficial cuida do protocolo; Express faz autenticação, validação de Host/Origin e limites HTTP. O catálogo e schemas são definidos em `src/schemas.mjs`; `Service` centraliza autorização e operações para que CLI e transportes compartilhem as mesmas regras.

Um PostgreSQL com pgvector mantém workspaces em tabelas comuns. Cada operação de conteúdo abre transação, seleciona a role sem privilégio de administrador e define `app.workspace` com escopo local à transação. RLS forçado protege itens, nós, mídia, relações e auditoria. As consultas também declaram workspace explicitamente. O runtime usa credencial própria sem superuser/BYPASSRLS; migrations usam credencial administrativa separada. Isso elimina criação de um banco e pools diferentes para cada workspace. Não equivale à separação física entre instalações hostis; o administrador de banco é confiável.

Apenas `src/store.mjs` escreve SQL de aplicação. Scripts de migration, provisionamento, avaliação e backup são operações administrativas. Migration é explícita, com checksum e advisory lock; o processo HTTP verifica o schema antes de abrir o socket.

Mídia fica em S3 privado. Em produção, o Bucket Railway substitui o MinIO local. PostgreSQL guarda ID, hash, MIME, tamanho, texto e vetor. Não há arquivos pessoais no checkout ou no disco efêmero da aplicação.

## Recuperação

O primeiro braço é FTS nativo em português, com GIN e `websearch_to_tsquery`. O segundo é pgvector exato com similaridade de cosseno, filtrando modelo e dimensão. O terceiro lê relações explícitas entre itens do mesmo workspace; o quarto reordena candidatos elegíveis pela data de registro. RRF combina posições e informa os braços presentes por item.

Recência só ordena candidatos encontrados: não transforma notas recentes sem correspondência em respostas a uma consulta vazia. Propostas, rejeitados, apagados, versões invalidadas e fatos fora da validade são excluídos antes da recuperação normal. `as_of` permite uma consulta de validade histórica; não recria o estado antigo de revisões/árvore.

Não existe BM25 nativo, índice ANN nem piso calibrado de similaridade. Busca vetorial de vizinhos próximos pode devolver resultados irrelevantes. Falhas do provedor são relatadas como degradação. Rerank é opt-in e ordena por score, sem aceitar como verdade a avaliação do modelo.

Travessia entre workspaces requer relação declarada, autorização sobre destino e score de gate acima de 0,75. Falha do gate bloqueia esse destino. Não é uma busca global implícita.

## Escrita, história e continuidade

Toda escrita nova produz uma proposta com ID imutável. `memory_write` consulta um gate opcional, mas não aceita automaticamente. Outro perfil deve revisar; isso separa credenciais de proposição e revisão, sem provar que pertencem a seres humanos diferentes.

Atualização cria um sucessor. Aceite bloqueia proposta/predecessor na transação e invalida o anterior. Consolidação conserva o texto integral e snapshots dos itens; preview tem hash e o aceite verifica fontes sob lock. Alterações concorrentes de estado/hash/nó impedem aceitar um plano obsoleto. Auditoria recebe a mutação na mesma transação; UPDATE/DELETE nela são recusados por privilégios e trigger.

Rejeição apaga o texto da linha principal e conserva o hash/tombstone, evitando ressuscitar o mesmo conteúdo por ingestão. **Snapshots anteriores na auditoria permanecem privados**, assim como dumps; rejeição/delete não implementam apagamento legal ou purga física. Soft delete retira o conteúdo de busca sem apagar história.

Checkpoints e registros tipados reutilizam o mesmo fluxo de revisão. Referências carregam IDs e hashes observados. Contexto, retomada e visão de projeto releem elegibilidade/hash e declaram lacunas. Não há snapshot distribuído entre busca e releitura, nem verificação automática da verdade de uma medição externa.

## Configuração e simplicidade

Configuração operacional fica no ambiente: `.env` local privado ou variáveis Railway. Não existe armazenamento de chaves de provedor em banco, formulário administrativo, senha distribuída, workspace pessoal padrão ou seed de conteúdo. Perfis contêm somente hashes dos tokens e escopo autorizado. Configuração é validada ao iniciar; alterações requerem reiniciar.

O serviço não usa worker/Redis/cron próprio. Indexação do backlog é explícita via CLI; modelos são APIs externas opcionais. Instalação e testes não geram custos de modelo. O cache de embeddings do processo tem 128 entradas, chave por hash/modelo/dimensão e não registra conteúdo em logs.

Fontes oficiais consultadas para esta topologia: [Railpack](https://docs.railway.com/builds/railpack), [configuração declarativa](https://docs.railway.com/config-as-code/reference), [pgvector](https://docs.railway.com/guides/rag-pipeline-pgvector), [Buckets privados](https://docs.railway.com/storage-buckets), [SDK MCP](https://ts.sdk.modelcontextprotocol.io/server) e [embeddings OpenRouter](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings).
