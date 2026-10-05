# Estado da entrega — 2026-10-05

## Implementado

43 ferramentas MCP, incluindo os 28 objetivos funcionais catalogados da aplicação anterior, com mudanças explícitas em PARITY.md. Código/configuração novos. HTTP autenticado e stdio com SDK oficial; persistência PostgreSQL/pgvector isolada por RLS; mídia S3 privada; ativação automática/histórico/consolidação e modo manual opcional; continuidade/registros; avaliação; snapshot/restore; ambiente de desenvolvimento próprio.

## Verificado localmente — histórico até 0.4.0

Versão 0.4.0: syntax/version, scanner público, 20 testes unitários e 19 cenários de integração (20 resultados TAP incluindo o teste principal), com todos os 33 nomes exercitados. Clientes MCP reais por HTTP/stdio, role runtime sem superuser/BYPASSRLS, autenticação/permissões/origin, concorrência de revisão e integridade/restauração de snapshot com mídia. Cobertura nova: ativação automática em todos os caminhos de escrita, recuperação imediata, checkpoint/registro, substituição concorrente, consolidação, validade temporal, gate opcional e rollback completo de conteúdo/auditoria. O modo manual foi testado separadamente. Dependências: auditoria npm sem vulnerabilidade conhecida na consulta desta entrega.

Nesta reconciliação não houve importação de corpus pessoal ou dados antigos. O primeiro smoke remoto recusou embedding por ausência de chave no processo. O operador cadastrou as chaves em armazenamento externo/variáveis privadas. A conexão local foi ativada e passou por chamadas reais de embeddings, decisão, análise e rerank. `.env` e `private/` contêm somente configuração nova da instalação local e são ignorados pelo Git.

## Roteamento anterior e validação real — histórico 0.2/0.3

A camada de provedor foi ampliada para a matriz especializada definida para o Jove Memory: `google/gemini-embedding-2` em embeddings, `upstage/solar-decide` em gates probabilísticos pela Decisions API, `qwen/qwen3.8-flash` em rerank, `deepseek/deepseek-v4-flash` em extração/consolidação auxiliar e `stealth/space-bunny-alpha` em síntese de contexto. Os modelos generativos têm fallback entre si; decisões probabilísticas não recebem fallback de chat. Saídas gerativas permanecem auxiliares e não substituem conteúdo lossless ou evidências persistidas.

Indexação automática após ativação, rerank padrão, fallback em respostas fora do contrato e verificação das citações após orçamento passaram em testes locais com provedor simulado. Separadamente, chamadas reais no desenvolvimento confirmaram Gemini Embedding 2 (1536 dimensões), Solar Decide, DeepSeek V4 Flash e Qwen3.8 Flash. O Qwen usa saída JSON Schema e reasoning desativado para a tarefa de rerank. O modelo `stealth/space-bunny-alpha` retornou HTTP 404 no OpenRouter e não apareceu no catálogo consultado; síntese usa fallback, declarado por modelo efetivo e `synthesis_fallback`. Não há alegação de disponibilidade desse quinto modelo.

Na reconciliação, GitHub e Railway já executavam o mesmo commit de roteamento. A variável de chave existia no Railway, mas o runtime retornou `PROVIDER_DISABLED` ao indexar com `provider_enabled=true`. Após o diagnóstico, as chaves foram cadastradas pelo operador e a ativação foi retomada com rebuild da fonte; saúde de banco/MCP não comprova saúde de modelos.

A produção só é considerada conectada ao OpenRouter quando `OPENROUTER_API_KEY` estiver cadastrada como segredo de produção e `ENABLE_PROVIDER=true` tiver sido aplicado com deploy saudável. O desenvolvimento local usa `~/.config/jovememory/secrets/openrouter.key` e `npm run provider:enable`; a chave não é copiada para o `.env`.

## Limites e próximos gates

Repositório público novo publicado, com proteção de branch, CI obrigatório, proteção de push contra segredos, alertas de dependências e canal privado de vulnerabilidades. Produção ativada em projeto Railway privado separado: aplicação sem volume, PostgreSQL/pgvector com volume e rede privada sem proxy TCP público, Bucket nativo de mídia.

Smoke remoto inicial da versão 0.1.0 observado com clientes MCP oficiais e conteúdo sintético: saúde de banco/schema/role runtime, recusa anônima e de Origin externo, catálogo de 32 ferramentas do administrador e catálogo restrito do leitor, escopo de workspace, proposta fora de busca antes da revisão, aceite por outro perfil, busca/releitura, mídia no Bucket real com roundtrip SHA-256/deduplicação, recusa HTTP 403 do acesso direto anônimo ao objeto S3, auditoria persistente e soft delete do item de teste. A versão 0.2.0 altera a política padrão para ativação automática; valide `memory_version`, `memory_capabilities.review_mode`, escrita sintética/recuperação imediata e auditoria após cada deploy dessa mudança. Tokens, endpoints da instalação e evidências permanecem somente em configuração privada/local ignorado.

Serviços novos do Railway não aplicam railway.json. A inicialização sem migration falhou no primeiro deploy; comandos e healthcheck foram corrigidos pela configuração nativa e um deploy novo pela fonte GitHub concluiu migration/provisionamento/start. A configuração pública passou para Infrastructure as Code; o SDK foi avaliado localmente. IaC não foi aplicado via CLI, e ausência de drift remoto não foi medida por plan. O serviço ativo foi configurado pelas ferramentas nativas.

Qualidade de corpus real, capacidade multimodal de um modelo específico, custo/latência e calibração dos limiares não foram medidos. Provedor local ativado com chave fora do checkout; integração automatizada usa exclusivamente provedor simulado e Compose isolado. Inferência real de produção requer smoke após o rebuild; o healthcheck não testa modelos. Restore verificou banco e arquivos locais; não repopulou Bucket nem restaurou volume de produção. Política automática de backups nativos não foi configurada/verificada nesta entrega e deve ser definida conforme retenção exigida.

A instalação anterior foi retirada por solicitação explícita do operador, sem importar seu corpus. Checkout/histórico Git local, dados, backups, credenciais locais, contêineres, volumes e caches identificados foram removidos. Registros locais dos clientes apontam para esta instalação nova. O repositório remoto anterior não está mais disponível; esta entrega continua sem corpus antigo.

O gate inicial no GitHub identificou uma imagem MinIO indisponível em runner sem cache. O S3 local foi substituído por SeaweedFS público com digest fixo, em volume novo, e a integração completa foi repetida. A produção continua usando Bucket nativo.

## Agente principal — versão 0.3.0

Inferência generativa é seletiva: contexto sem síntese, notas sem enriquecimento e consolidação sem resumo auxiliar por padrão. O agente pode solicitar essas funções quando úteis, sem aprovação humana. Embeddings automáticos, decisão indicativa e rerank padrão permanecem ativos. Testes verificam ausência das chamadas generativas redundantes, solicitação explícita, invalidação de análise da versão anterior, referências/orçamento e persistência integral.

Provisionamento administrativo de workspace via MCP é idempotente, auditado e restrito por perfil/nome. Novos perfis podem ser acrescentados em `EXTRA_AUTH_PROFILES` sem substituir a base. Migration 002 aplicada no ambiente local; autorização e RLS entre workspaces foram verificadas em Compose isolado. Banco físico separado por projeto não é parte desta topologia. Associação privada de cliente e histórico de sessões reais não são garantidos pela existência destas funções.

## Inferência gratuita — versão 0.4.0

O modelo primário anterior foi retirado da configuração vigente. Síntese usa rota gratuita com catálogo dinâmico e preferência por modelos maiores: Nemotron Ultra, Super e Gemma 31B. Fallbacks pagos explícitos: DeepSeek V4 Pro, V4 Flash e MiMo-V2.5, sujeitos aos tetos de US$ 0,25 de entrada e US$ 1,50 de saída por milhão de tokens. Modelos efetivos e classe da rota são declarados, sem confundir seleção gratuita com fallback pago. Embeddings, decisão, rerank e inferência seletiva preservam seus papéis.

Testes cobrem seleção de candidatos gratuitos, rejeição de modalidades/preços incompatíveis, preferências, identidade efetiva, JSON/citações, fallback pago com teto e comportamento do contexto para rota gratuita/paga. Chamadas reais são validação operacional separada; não medem superioridade, calibração ou disponibilidade futura. O histórico acima conserva o diagnóstico do modelo anterior e não representa a configuração atual.

## Lifecycle e projetos automáticos — 0.5.0

Schema 3, conector Git/stdio, matrícula com credencial scoped, revogação por epoch,
observações de fontes, guia de agente, retirement auditado, substituição por chave
e métricas globais sem corpus implementados. JOSE 6.2.12 foi fixado como dependência
para validação de tokens. O teto de preço pago foi retirado por decisão do operador;
o histórico 0.4.0 acima descreve a política anterior.

Gates completos locais passaram: syntax/version, scanner público, 24 testes
unitários e auditoria npm sem vulnerabilidade conhecida. Validação em Compose
isolado: 23 cenários de integração (24 resultados TAP),
incluindo todos os 43 nomes MCP, broker stdio real com Git temporário, bloqueio de
colisão, escopo/revogação de JWT, RLS nas tabelas novas, mudanças de fontes,
revalidação concorrente, registro por chave/ambiguidade, retirement e backup/restore
com fingerprint de projects/sources/telemetry. Publicação e operação desta versão
exigem gates completos e smoke privado após deploy; implementação não basta.
