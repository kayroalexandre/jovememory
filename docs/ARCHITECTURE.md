# Arquitetura

## Decisões da reconstrução

A finalidade é memória persistente, auditável e recuperável para agentes. A implementação anterior serviu de inventário funcional, sem copiar seu código, configuração, dados ou histórico Git.

Um serviço Node.js ESM oferece MCP por stdio local e HTTP remoto. O SDK oficial cuida do protocolo; Express faz autenticação, validação de Host/Origin e limites HTTP. O catálogo e schemas são definidos em `src/schemas.mjs`; `Service` centraliza autorização e operações para que CLI e transportes compartilhem as mesmas regras.

Um PostgreSQL com pgvector mantém workspaces em tabelas comuns. Cada operação de conteúdo abre transação, seleciona a role sem privilégio de administrador e define `app.workspace` com escopo local à transação. RLS forçado protege itens, nós, mídia, relações e auditoria. As consultas também declaram workspace explicitamente. O runtime usa credencial própria sem superuser/BYPASSRLS; migrations usam credencial administrativa separada. Isso elimina criação de um banco e pools diferentes para cada workspace. Não equivale à separação física entre instalações hostis; o administrador de banco é confiável.

Apenas `src/store.mjs` escreve SQL de aplicação. Scripts de migration, provisionamento, avaliação e backup são operações administrativas. Migration é explícita, com checksum e advisory lock; o processo HTTP verifica o schema antes de abrir o socket.

Mídia fica em S3 privado. Em produção, o Bucket Railway substitui o SeaweedFS local. PostgreSQL guarda ID, hash, MIME, tamanho, texto e vetor. Não há arquivos pessoais no checkout ou no disco efêmero da aplicação.

## Recuperação

O primeiro braço é FTS nativo em português, com GIN e `websearch_to_tsquery`. O segundo é pgvector exato com similaridade de cosseno, filtrando modelo e dimensão. O terceiro lê relações explícitas entre itens do mesmo workspace; o quarto reordena candidatos elegíveis pela data de registro. RRF combina posições e informa os braços presentes por item.

Recência só ordena candidatos encontrados: não transforma notas recentes sem correspondência em respostas a uma consulta vazia. Propostas, rejeitados, apagados, versões invalidadas e fatos fora da validade são excluídos antes da recuperação normal. `as_of` permite uma consulta de validade histórica; não recria o estado antigo de revisões/árvore.

Não existe BM25 nativo, índice ANN nem piso calibrado de similaridade. Busca vetorial de vizinhos próximos pode devolver resultados irrelevantes. Falhas do provedor são relatadas como degradação. Rerank é padrão com o provedor ativo, pode ser desativado por `rerank=false` em busca/contexto e ordena por score, sem aceitar como verdade a avaliação do modelo.

Travessia entre workspaces requer relação declarada, autorização sobre destino e score de gate acima de 0,75. Falha do gate bloqueia esse destino. Não é uma busca global implícita.

## Escrita, história e continuidade

Toda escrita nova tem ID imutável. `MEMORY_REVIEW_MODE=automatic`, padrão, grava e ativa a memória na mesma transação. Auditoria registra o proponente e a ativação pelo ator interno `system:auto`, que não é uma credencial de cliente. Erros de validação/conflito abortam a transação inteira; não deixam itens parcialmente ativados. Isso vale também para o nome compatível `memory_propose_write`, checkpoints, registros, ingestão, atualização e consolidação.

`memory_write` consulta um gate opcional e devolve score/status indicativos, sem condicionar a ativação ao provedor ou ao limiar não calibrado. `manual` mantém propostas pendentes e revisão por outro perfil; a mudança de configuração só afeta novas escritas. Propostas anteriores continuam identificadas como pendentes até uma revisão explícita. Aprovação automática não declara conteúdo verdadeiro, seguro ou autorizado para execução.

Atualização cria um sucessor. Aceite bloqueia proposta/predecessor na transação e invalida o anterior. Consolidação conserva o texto integral e snapshots dos itens; preview tem hash e o aceite verifica fontes sob lock. Alterações concorrentes de estado/hash/nó impedem aceitar um plano obsoleto. Auditoria recebe a mutação na mesma transação; UPDATE/DELETE nela são recusados por privilégios e trigger.

Rejeição apaga o texto da linha principal e conserva o hash/tombstone, evitando ressuscitar o mesmo conteúdo por ingestão. **Snapshots anteriores na auditoria permanecem privados**, assim como dumps; rejeição/delete não implementam apagamento legal ou purga física. Soft delete retira o conteúdo de busca sem apagar história.

Checkpoints e registros tipados reutilizam a política de escrita; no modo automático entram imediatamente em retomada/visão de projeto. Referências carregam IDs e hashes observados. Síntese é omitida se o orçamento retirar uma fonte citada, com `synthesis_budget_omitted`. Contexto, retomada e visão de projeto releem elegibilidade/hash e declaram lacunas. Não há snapshot distribuído entre busca e releitura, nem verificação automática da verdade de uma medição externa.

## Configuração e simplicidade

Configuração operacional fica no ambiente: `.env` local privado ou variáveis Railway. Não existe armazenamento de chaves de provedor em banco, formulário administrativo, senha distribuída, workspace pessoal padrão ou seed de conteúdo. Perfis contêm somente hashes dos tokens e escopo autorizado. Configuração é validada ao iniciar; alterações requerem reiniciar. Ativar o provedor sem uma chave privada impede iniciar o serviço. A chave local fica em arquivo externo ao checkout; o `.env` conserva apenas o caminho.

O serviço não usa worker/Redis/cron próprio. Novos itens elegíveis recebem indexação após o commit da escrita ou aceite; falhas são declaradas e não revertem uma memória já ativada. O UPDATE do vetor verifica ID/hash/status na transação RLS, evitando publicar vetores de versões alteradas. Indexação do backlog é explícita via CLI; modelos são APIs externas opcionais. Instalação e testes não geram custos de modelo. O cache de embeddings do processo tem 128 entradas, chave por hash/modelo/dimensão e não registra conteúdo em logs.

A camada de modelos é roteada por função, não por um único modelo genérico. Gemini Embedding 2 gera vetores multimodais; Solar Decide atende gates probabilísticos pela Decisions API; Qwen3.8 Flash faz rerank com JSON Schema e reasoning desativado; DeepSeek V4 Flash produz análise auxiliar e resumo de consolidação; A rota gratuita do OpenRouter compacta contexto com IDs citados; preferências de modelos maiores precedem o roteador aleatório. Qwen e DeepSeek conservam seus papéis em rerank/enriquecimento, e a síntese usa fallbacks pagos explícitos sem teto de preço pago, inclusive quando o primeiro modelo devolve JSON fora do contrato. Decisions não recebe fallback generativo. Fallbacks são declarados no resultado por modelo efetivo e status de degradação. Qwen e DeepSeek recebem JSON Schema estrito; a validação local continua obrigatória. Saídas gerativas são auxiliares e nunca substituem conteúdo lossless, hashes ou referências persistidas.

Fontes oficiais consultadas para esta topologia: [Railpack](https://docs.railway.com/builds/railpack), [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), [pgvector](https://docs.railway.com/guides/rag-pipeline-pgvector), [Buckets privados](https://docs.railway.com/storage-buckets), [SDK MCP](https://ts.sdk.modelcontextprotocol.io/server) e [embeddings OpenRouter](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings).

Baseline de desenvolvimento/produção preparado: PostgreSQL 17 com pgvector, com a mesma imagem fixada por digest; SeaweedFS local e Bucket Railway em produção usam o mesmo contrato S3. O [quick start oficial do SeaweedFS](https://github.com/seaweedfs/seaweedfs/blob/master/README.md) documenta o modo mini e autenticação por ambiente.

## Apoio ao agente e organização de projetos

O modelo do agente é o responsável pela tarefa e resposta. O servidor oferece recuperação híbrida, proveniência, controle de bytes e persistência; não assume planejamento ou execução do cliente. Embeddings e rerank permanecem ativos por padrão com provedor habilitado. Decisão avalia criação/atualização de notas e travessias explícitas; seus scores são indicativos e não calibrados. Registros estruturados e checkpoints fornecidos pelo agente não exigem reanálise generativa.

Enriquecimento de notas/atualizações (`enrich:true`), síntese de contexto (`synthesize:true`) e resumo de consolidação (`summarize:true`) são solicitações técnicas opcionais do agente, sem confirmação humana adicional. Os defaults dispensam essas chamadas. A síntese comprime evidências sem responder à tarefa; trechos cortados declaram truncamento, conservam hash/ID do original e podem ser relidos integralmente. A validação de citações e orçamento continua obrigatória.

Um projeto recebe nome de workspace explícito e perfil limitado a ele; associação ao diretório é configuração privada do cliente, não inferência do nome de uma consulta. O banco PostgreSQL é único, com isolamento lógico por RLS, não um banco físico para cada projeto. Provisionamento administrativo via MCP é idempotente e auditado. `EXTRA_AUTH_PROFILES` acrescenta perfis sem substituir credenciais existentes; autorização continua separada da criação do workspace.

## Inferência gratuita e fallbacks com orçamento

Na versão 0.4.0, síntese usa `openrouter/free` como rota lógica. Antes do roteador aleatório, o provedor consulta `/models` e envia `models` em ordem de preferência ao OpenRouter. Só entram candidatos de texto com preço zero, identidade válida e contexto conservador suficiente; áudio, embeddings e classificadores de segurança não compõem essa lista. Preferências explícitas vêm antes de tamanho divulgado/contexto. Catálogo tem TTL de dez minutos, limite de 8 MiB e timeout de cinco segundos; falha usa o roteador geral, com nova tentativa de catálogo após um minuto. Não há consulta de corpus para escolher o modelo.

Tentativas gratuitas impõem `max_price` zero para conservar sua natureza gratuita. Após falha HTTP, timeout, JSON inválido ou citação desconhecida, o fluxo usa fallbacks pagos configurados, ordenando provedores por preço, **sem teto pago**. As variáveis antigas de teto não são lidas desde 0.5.0. A síntese tem orçamento global de 90 segundos, com tentativas gratuitas de até 20 segundos e pagas de até 30; o contexto considera também o tempo da recuperação. Modelos sem `response_format` podem atender ao prompt JSON, mas a validação local é obrigatória. Saída registra modelo real retornado pelo OpenRouter e classe da rota; ausência dessa identidade no roteador gratuito faz a tentativa falhar.

Modelos maiores são uma preferência de capacidade declarada, não garantia de qualidade ou calibração. O agente principal continua responsável pela tarefa; síntese permanece desligada por padrão.

## Registro de projetos, observações e controle global — 0.5.0

Schema 3 acrescenta `projects`, `sources` e `telemetry`, todas com RLS forçado.
A registry associa workspace e SHA-256 da identidade normalizada do Git origin;
URL, credenciais e caminho absoluto do cliente não são persistidos. Workspaces
aceitam os nomes ASCII usuais do Git, com até 100 caracteres, inclusive maiúsculas
e pontos. Nome igual com identidade diferente recusa enrollment. O primeiro vínculo
é estabelecido pelo controlador confiável, não pelo modelo ou por conteúdo recuperado.
Git remoto declarado não é prova criptográfica de propriedade do repositório.

`jose` valida credenciais HS256 com algoritmo fixo, issuer, audience, tipo JWT,
expiração de um dia e escopo writer. A chave de assinatura vive fora do checkout
ou em variável Railway. O epoch persistido por projeto permite revogação imediata;
o controlador ainda autorizado pode emitir uma nova credencial. O conector local
não anuncia ferramentas administrativas nem de travessia; renova a credencial e
injeta o workspace. Ausência de Git origin ou erro de associação expõe somente
status de conexão, sem destino substituto. HTTP autentica também perfis estáticos.

Observações `sources` contêm locator relativo, hash, presença, revisão e data.
`source_refs` de uma memória são verificadas na transação contra essas observações.
Fonte alterada ou ausente sinaliza `needs_revalidation`; hash igual significa apenas
`matches_observation`, nunca verdade ou testes aprovados. Inferência não invalida
fatos automaticamente. Revalidação verifica hash do item e das fontes, evitando
aceitar uma observação concorrente antiga. Retirement conserva texto/auditoria;
substituição da mesma chave serializa escritores por lock transacional.

Métricas registram nome da ferramenta, sucesso/código de erro, duração e rota/modelo
de síntese, sem argumentos, consultas, tokens ou conteúdo. Retenção é de 30 dias,
com janela agregada de sete dias. Leituras/escritas de métricas usam RLS e falhas
na telemetria não revertem operações de memória. Overview pagina workspaces
autorizados e consulta cada um em sua própria transação; não há bypass global de RLS.
O observer vê agregados, enquanto somente administrador lê/administra corpus global.
Fonte sem observação ou fonte antiga ainda exige julgamento do agente. Isso não
é certificação de qualidade, prevenção absoluta de regressão ou importação de sessões.


O modo nativo `PROJECT_TOKEN_KEY_MODE=database-derived` deriva uma chave de
assinatura com HKDF-SHA256, domínio exclusivo e identidade do banco, a partir da
credencial runtime privada já gerida pelo Railway. Não usa a senha diretamente
como chave e não exporta o material derivado. Rotacionar essa credencial invalida
JWTs antigos. Uma chave independente em `PROJECT_TOKEN_SECRET`/arquivo externo
tem prioridade e permite rotação separada. `CONTROL_AUTH_PROFILES` acrescenta
controlador/observer sem sobrescrever perfis existentes.
